'use strict';

/**
 * Import Analyzer — direct-api driver 专用。
 *
 * 当使用 claude-code driver 时，导入分析由 sa-import-orchestrator subagent
 * 通过 MCP 工具自主完成。此模块的 6-task 并行分析逻辑仅作为 direct-api
 * 替补路径保留。
 *
 * Uses the unified semantic model profile router to run analysis
 * tasks in parallel. Each task emits eventBus events so the frontend can
 * show real-time per-task progress.
 *
 * Two-step API:
 *   1. startAnalyses(stagingDir) — spawns all tasks, returns runIds[]
 *   2. finalizeAnalyses(stagingDir) — awaits results, writes to staging
 *
 * Chunked mode (EC-14): texts > MAX_TEXT_CHARS are split into chunks,
 * each analyzed independently, then merged.
 */

const fs = require('node:fs').promises;
const path = require('node:path');
const { createProfileProvider } = require('../runtime/profileProvider');
const eventBus = require('../runtime/eventBus');
const characterEnricher = require('./characterEnricher');
const { splitIntoChunks, mergeChunkResults } = require('./resultMerger');

async function resolveProvider() {
  return createProfileProvider({ systemTask: 'import-analysis', legacyTier: 'sonnet' }, { extra: { maxTokens: 16384 } });
}

const MAX_TEXT_CHARS = 60000;
const CHUNK_SIZE = 40000;

const TASK_DEFS = [
  { id: 'characters', label: '提取角色信息', outputDir: 'characters', isJson: true },
  { id: 'factions', label: '提取势力派系', outputDir: 'factions', isJson: true },
  { id: 'timeline', label: '提取时间线事件', outputDir: 'timeline', isJson: false },
  { id: 'world', label: '提取世界观设定', outputDir: 'world', isJson: true },
  { id: 'outline', label: '提取剧情大纲', outputDir: 'outlines', isJson: false },
  { id: 'style', label: '分析文风特征', outputDir: 'style', isJson: false },
];

const TASK_PROMPTS = {
  characters: `以下小说文本中出现了哪些角色？请按 JSON 格式列出所有角色（包括主要角色和次要角色）。只输出一个 JSON 数组，不要任何额外文字或说明文字。

[{"id":"拼音或英文唯一标识","name":"小说中的名字","aliases":["别名/绰号"],"gender":"男/女","age":"年龄","role":"在故事中的定位","appearance":"外貌描写","personality":"性格特征","background":"背景","relationships":[{"with":"对方名字","type":"关系类型"}],"storyArc":"剧情中的作用","protagonist":true,"sourceWork":"原作名称（如果是同人/二创角色）","originalName":"原作中的名字（如果与小说中的名字不同）"}]

**输出风格约束：**
- 采用客观、结构化、专业角色卡的表达方式。
- 只填写文本中已经明确确认的事实；不允许脑补、推测、润色、夸张或延伸解读。
- 不要使用口语化、段子风、吐槽式、玩梗式表达。
- 各字段内容应尽量简洁、可核对，适合作为正式角色档案。

**角色来源信息：**
- \`sourceWork\`：如果文本明确提到角色来自某个已有作品，填写原作名称；否则留空字符串。
- \`originalName\`：如果角色在小说中的名字与原作官方名字不同，填写原作标准名字；否则留空字符串。
- 不要自行判断角色是否为原创，这些字段由用户在导入后手动补充。

**姓名识别规则（必须严格遵守）：**
1. 优先使用文本和导入线索中明确出现的姓名，如“陈可”“刘燕君”等。
2. 不要把“金发女孩”“空姐”“主角”“尸体”“少女”等描述性称呼作为 name；如果确实没有姓名，可把描述写入 appearance 或 aliases，并将 name 留为最稳定的称呼。
3. 同一人物既有姓名又有描述时，name 必须使用姓名，描述写入 aliases/appearance。

**主角识别规则（必须严格遵守）：**
1. 如果文本是第一人称叙述（"我"的视角），叙述者必定是主角，protagonist 必须为 true。
2. 如果文本是第三人称叙述，从以下线索判断主角：
   - 出场篇幅最多、心理描写最丰富的角色
   - 故事围绕其命运/成长展开的角色
   - 书名与某个角色名字相关
3. 主角的 protagonist 字段必须为 true，其他角色为 false 或不填。
4. 一般小说应有且仅有 1~3 个主角（主角、双主角、群像主角）。

注意：输出必须是一个 JSON 数组，不能有 Markdown 代码围栏，不能有说明文字。如果文中没有明确提到的字段就留空字符串；若信息存在歧义或未被文本直接确认，也必须留空字符串。`,
  factions: `以下小说文本中出现了哪些势力、派系、组织或团体？请按 JSON 格式列出。只输出一个 JSON 数组（不要额外文字）：

[{"name":"势力名称","aliases":["别名"],"type":"公司/政府/社团/家族/军事组织等","description":"描述","members":["成员1","成员2"],"goals":"目标","conflicts":["对立势力1"]}]

注意：只输出 JSON 数组。如果文本中没有提到任何势力派系，输出空数组 []。`,
  timeline: `以下小说文本中发生了哪些重要事件？请按时间顺序列出所有重要事件，用 JSON 格式输出。只输出一个 JSON 数组（不要额外文字）：

[{"id":"evt-1","timestamp":"故事内时间（如'第一天上午''第二章开头'）","title":"事件标题","event":"事件描述","type":"plot/character/world/setting","importance":"major/minor","involvedCharacters":["角色1"]}]

注意：只输出 JSON 数组。id按顺序编号。如果没有明显的时间线事件可以只编几个最重要的。`,
  world: `分析以下小说的世界观设定，并判断它是否是已有作品的二创/同人。

按以下 JSON 格式输出，只输出 JSON 对象（不要额外文字）：
{
  "isFanwork": true,
  "referencedWorks": ["碧蓝航线", "原神"],
  "possibleFanworkOf": "如果这是同人或二创作品，请注明可能的原作（电影/电视剧/游戏/动漫/漫画/小说名称）。如果不是二创，填null。说明你的判断依据。",
  "timeSetting": "时代背景（具体到朝代/年份/纪元）",
  "location": "主要故事发生地",
  "society": "社会结构、势力分布",
  "rules": "特殊规则（魔法/科技/社会规则）",
  "places": [{"name":"地名","type":"城市/国家/建筑","description":"描述"}]
}

**二创检测规则（必须严格遵守）：**
1. 仔细阅读文本，判断是否包含二创/同人元素。判断依据包括：
   - 角色名称与已有作品中的角色相同或高度相似
   - 世界观设定与已有作品（游戏、动漫、影视、小说）明显一致
   - 文中明确提到原作名称或角色出处
   - 地名、组织名、术语与已有作品一致
2. \`isFanwork\`：布尔值。如果文本明显是已有作品的同人/二创，设为 true；如果明显是原创作品，设为 false；如果不确定，设为 false。
3. \`referencedWorks\`：字符串数组。如果 \`isFanwork\` 为 true，列出文中明确引用或涉及的所有原作名称（如：["碧蓝航线", "原神"]）。如果是单一作品同人，只填一个；如果是 crossover/多部作品混搭，填写全部。如果 \`isFanwork\` 为 false，设为空数组 []。
4. \`possibleFanworkOf\`：如果 \`isFanwork\` 为 true，填写最主要的原作名称（单部）或填写 "多作品 crossover"。如果不是二创，填 null。

注意：只输出 JSON 对象，不要额外文字。`,
  outline: `从以下小说文本中提取剧情大纲，用 Markdown 格式输出以下内容。如果这篇小说看起来是已有作品的二创/同人，在开头注明。不要输出“好的”“以下是”等寒暄或解释，直接从指定标题开始。

## 原作识别
如果这是同人或二创作品，注明可能的原作名称（影视/游戏/动漫/漫画/小说）及判断依据。如果不是就写"原创作品"。

## 故事梗概
200字以内概括整个故事。

## 主要人物关系
列出所有主要角色之间的关系网。

## 明线（显性情节线）
故事表面上发生的主线事件，按时间顺序列出。包括：
- 事件节点
- 涉及角色
- 该事件在表面叙事中的作用

## 暗线（隐性情节线）
隐藏在表面叙事之下的深层线索，按时间顺序列出。包括：
- 暗线类型：情感暗线/阴谋暗线/命运暗线/成长暗线/权力暗线/其他
- 暗线描述：这条暗线具体是什么
- 涉及角色
- 与明线的交汇点

## 章节概要
按顺序列出每章核心事件。

## 冲突设定
列出主要冲突。

## 伏笔与回收
用表格形式列出文本中的伏笔：
| 伏笔内容 | 埋设章节/位置 | 回收状态 | 回收章节/位置 | 关联暗线 |
|---------|-------------|---------|-------------|---------|
（回收状态填写：已回收/未回收/疑似回收）

## 未解悬念
列出文本中尚未解决的悬念，供后续创作参考。`,
  style: `分析以下小说的写作风格特征与作者创作意图，用 Markdown 输出。不要输出“好的”“以下是”等寒暄或解释，直接从指定标题开始：

## 叙述视角
第一人称/第三人称/多视角切换等。

## 用词特点
- 词汇偏好（华丽/朴素/古雅/网络化等）
- 专业术语密度
- 情感色彩词的使用倾向

## 句式特点
- 句子长短节奏
- 修辞手法偏好（排比、对偶、隐喻等）
- 标点运用特点

## 对话特点
- 对话风格（书面化/口语化/古风化等）
- 对话与叙述的比例

## 描写风格
- 景物/人物/心理描写的侧重
- 描写密度与细腻程度

## 节奏特点
- 整体叙事节奏（舒缓/紧凑/跳跃）
- 高潮与铺垫的分布

## 作者创作意图与情感基调（重点分析）
基于全文判断作者想要给读者传达的核心感觉与审美追求：
- **情感基调**：悲怆、欢快、压抑、温暖、冷峻、浪漫等
- **审美追求**：波澜壮阔的史诗感、诗情画意的随性、悬疑紧张的惊悚感、轻松幽默的娱乐性、感官刺激的猎奇感等
- **主题气质**：宏大叙事/个人命运/社会批判/纯粹娱乐/情色刺激等
- 引用文本中 1~3 个最能体现这种意图的典型段落作为佐证`,
};

// Store pending results keyed by stagingDir
const _pending = new Map();

function _buildChunkContext(prevResults) {
  const chars = [];
  const events = [];
  for (const pr of prevResults) {
    if (pr.characters) {
      chars.push(...pr.characters.map((c) => c.name).filter(Boolean));
    }
    if (pr.timeline && pr.timeline[0]) {
      events.push(pr.timeline[0].title || pr.timeline[0].event);
    }
  }
  const uniqChars = [...new Set(chars)].slice(0, 20);
  const context = [];
  if (uniqChars.length > 0) context.push(`前面章节已出现的角色：${uniqChars.join('、')}`);
  if (events.length > 0) context.push(`前面主要剧情：${events.slice(0, 5).join('；')}`);
  return context.join('\n');
}

async function _runTaskForChunk({ runId, provider, tier, task, chunkText, chunkIndex, chunkCount, chunkTitle, contextNote, sourceHints }) {
  const label = chunkCount > 1 ? `${task.label} [第 ${chunkIndex + 1}/${chunkCount} 片]` : task.label;

  try {
    eventBus.emit({ runId, subagentId: 'sa-import-analyzer', kind: 'running', data: { label, chunkIndex, chunkCount, chunkTitle } });

    let prompt = TASK_PROMPTS[task.id];
    let analysisText = chunkText;
    if (sourceHints && ['characters', 'factions', 'timeline', 'world', 'outline'].includes(task.id)) {
      prompt = `【导入对话中的用户设定/大纲线索】\n${sourceHints}\n\n请优先利用以上线索中的角色姓名、地点、章节规划和用户最终修改意见；不要把“金发女孩”“空姐”“主角”等描述性称呼当成姓名，除非文本确实没有姓名。\n\n${prompt}`;
    }
    if (sourceHints && task.id === 'characters') {
      analysisText = _buildCharacterFocusedText(sourceHints, chunkText);
      prompt = `下面的文本是从 Chatbox 对话中提取的“人物分析专用材料”，不是完整小说正文。你必须只围绕其中明确出现的候选姓名建立角色卡；不要新增职务、视角、描述性外观或变量名角色。\n\n${prompt}`;
    }
    if (contextNote) {
      prompt = `【上下文】${contextNote}\n\n${prompt}`;
    }

    const result = await provider.sendMessage({
      system: '',
      messages: [{ role: 'user', content: [{ type: 'text', text: `${prompt}\n\n${analysisText}` }] }],
      tools: [],
      tier,
    });

    const textBlock = (result.content || []).find((b) => b.type === 'text');
    const output = textBlock?.text || '';

    eventBus.emit({ runId, subagentId: 'sa-import-analyzer', kind: 'done', data: { output: output.slice(0, 200), chunkIndex, chunkCount } });
    return { taskId: task.id, output, chunkIndex, chunkTitle };
  } catch (err) {
    console.error(`[analyzer] ${task.id} chunk ${chunkIndex} failed:`, err.message);
    eventBus.emit({ runId, subagentId: 'sa-import-analyzer', kind: 'error', data: { message: err.message, chunkIndex, chunkCount } });
    return { taskId: task.id, output: '', error: err.message, chunkIndex, chunkTitle };
  }
}

async function _extractCandidateNamesForText(provider, tier, sourceHints, chunkText, chunkIndex = 0, chunkCount = 1) {
  const hintText = String(sourceHints || '').slice(0, 12000);
  const storyText = String(chunkText || '').slice(0, CHUNK_SIZE);
  if (!hintText && !storyText) return [];
  const prompt = `请从以下导入材料中抽取“角色姓名候选”。只输出 JSON 数组，不要解释，不要 Markdown。

输出格式：
[
  {"name":"标准姓名","aliases":["同一人物的别名/称呼"],"evidence":"最短证据"}
]

规则：
- 只输出文本中明确出现的角色姓名/人名，包括中文姓名、日式汉字姓名、假名名、英文名、俄文/西里尔名、幻想系姓名。
- 不要输出章节标题、阶段名、部分名、动作短语、外貌描述、职业称呼、主角/女主/男主/空姐/少女等泛称。
- 如果同一人物有姓名和描述，name 用姓名，描述写入 aliases。
- 不确定是不是人名时不要输出。

当前片段：第 ${chunkIndex + 1}/${chunkCount} 片

导入线索：
${hintText}

当前整理正文片段：
${storyText}`;

  try {
    const result = await provider.sendMessage({
      system: '',
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      tools: [],
      tier,
    });
    const textBlock = (result.content || []).find((b) => b.type === 'text');
    const parsed = _parseJsonArray(textBlock?.text || '');
    return _normalizeCandidateNameItems(parsed).slice(0, 120);
  } catch (err) {
    console.error('[analyzer] AI candidate name extraction failed:', err.message);
    return [];
  }
}

function _normalizeCandidateNameItems(items) {
  const normalized = [];
  for (const item of items || []) {
    if (typeof item === 'string') {
      const name = _cleanCandidateName(item);
      if (name) normalized.push({ name, aliases: [], evidence: '' });
      continue;
    }
    if (!item || typeof item !== 'object') continue;
    const name = _cleanCandidateName(item.name || item.id || item.originalName);
    if (!name) continue;
    const aliases = Array.isArray(item.aliases)
      ? item.aliases.map(_cleanCandidateName).filter(Boolean)
      : [];
    normalized.push({
      name,
      aliases: [...new Set(aliases.filter((alias) => alias !== name))],
      evidence: String(item.evidence || '').trim().slice(0, 120),
    });
  }
  return normalized;
}

function _cleanCandidateName(raw) {
  const text = String(raw || '')
    .replace(/^[\s"'“”‘’「」『』《》]+|[\s"'“”‘’「」『』《》]+$/g, '')
    .trim();
  if (text.length < 2 || text.length > 80) return '';
  if (_isDefinitelyNonPersonName(text)) return '';
  if (/^(?:主角|女主|男主|少女|女孩|空姐|乘客|众人|阶段|部分|章节|正文|故事|角色|人物)$/.test(text)) return '';
  return text;
}

function _candidateKey(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[\s·・=_.\-—'“”"‘’「」『』《》（）()]+/g, '');
}

function _mergeCandidateNameItems(items) {
  const byKey = new Map();
  const aliasToKey = new Map();
  for (const item of _normalizeCandidateNameItems(items)) {
    const keys = [item.name, ...(item.aliases || [])].map(_candidateKey).filter(Boolean);
    const existingKey = keys.find((key) => aliasToKey.has(key));
    const primaryKey = existingKey ? aliasToKey.get(existingKey) : _candidateKey(item.name);
    if (!primaryKey) continue;
    const current = byKey.get(primaryKey) || { name: item.name, aliases: [], evidence: '' };
    for (const alias of [item.name, ...(item.aliases || [])]) {
      const cleaned = _cleanCandidateName(alias);
      if (cleaned && cleaned !== current.name && !current.aliases.includes(cleaned)) current.aliases.push(cleaned);
    }
    if (!current.evidence && item.evidence) current.evidence = item.evidence;
    byKey.set(primaryKey, current);
    for (const key of keys) aliasToKey.set(key, primaryKey);
  }
  return [...byKey.values()];
}

async function _mergeCandidateNamesWithAi(provider, tier, candidateItems) {
  const merged = _mergeCandidateNameItems(candidateItems).slice(0, 240);
  if (merged.length <= 1) return merged.map((item) => item.name);
  const prompt = `下面是从不同分片抽取到的角色姓名候选，可能有同一角色重复出现或别名。请合并为唯一角色姓名列表。

只输出 JSON 字符串数组，不要解释，不要 Markdown。

合并规则：
- 同一人物的别名/译名/简称只保留最适合作为角色卡 name 的一个标准姓名。
- 不要输出章节标题、阶段名、部分名、动作短语、职业称呼或外貌描述。
- 不确定是否同一人物时保留为两个名字，不要强行合并。

候选：
${JSON.stringify(merged, null, 2)}`;

  try {
    const result = await provider.sendMessage({
      system: '',
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      tools: [],
      tier,
    });
    const textBlock = (result.content || []).find((b) => b.type === 'text');
    const parsed = _parseJsonArray(textBlock?.text || '');
    const names = parsed.map(_cleanCandidateName).filter(Boolean);
    if (names.length > 0) return [...new Set(names)].slice(0, 180);
  } catch (err) {
    console.error('[analyzer] AI candidate name merge failed:', err.message);
  }
  return merged.map((item) => item.name).slice(0, 180);
}

async function _extractCandidateNamesWithAi(provider, tier, sourceHints, chunks) {
  const chunkList = Array.isArray(chunks) && chunks.length > 0
    ? chunks
    : [{ text: String(chunks || '') }];
  const candidates = [];
  for (let i = 0; i < chunkList.length; i++) {
    const chunkNames = await _extractCandidateNamesForText(provider, tier, sourceHints, chunkList[i].text || '', i, chunkList.length);
    candidates.push(...chunkNames);
  }
  return _mergeCandidateNamesWithAi(provider, tier, candidates);
}

function _appendCandidateNamesToHints(sourceHints, candidateNames) {
  const names = [...new Set((candidateNames || []).map((name) => String(name || '').trim()).filter(Boolean))];
  if (names.length === 0) return sourceHints;
  return `${sourceHints || ''}\n\n## AI候选角色姓名\n${names.map((name) => `- ${name}`).join('\n')}`.trim();
}

async function _analyzeSingleChunk({ provider, tier, chunk, chunkIndex, chunkCount, contextNote, runIdMap, sourceHints }) {
  const promises = TASK_DEFS.map((task) =>
    _runTaskForChunk({ runId: runIdMap[task.id], provider, tier, task, chunkText: chunk.text, chunkIndex, chunkCount, chunkTitle: chunk.title, contextNote, sourceHints })
  );
  return Promise.all(promises);
}

/**
 * Start analysis tasks. Supports chunked mode for long texts.
 * Returns { runIds: string[], taskIds: string[], chunkMode?: boolean, chunkCount?: number }.
 */
async function startAnalyses(stagingDir) {
  // Read all chapter content
  const chaptersDir = path.join(stagingDir, 'chapters');
  let fullText = '';
  try {
    const files = await fs.readdir(chaptersDir);
    for (const f of files.sort()) {
      if (!f.endsWith('.md')) continue;
      const content = await fs.readFile(path.join(chaptersDir, f), 'utf8');
      const titleMatch = content.match(/^#\s+(.+)/);
      const title = titleMatch ? titleMatch[1] : f;
      fullText += `\n\n## ${title}\n\n${content.replace(/^#\s+.+\n/, '')}`;
    }
  } catch (err) {
    throw new Error('读取章节文件失败: ' + err.message);
  }
  if (!fullText.trim()) return { runIds: [], taskIds: [] };
  let sourceHints = '';
  try {
    sourceHints = await fs.readFile(path.join(stagingDir, 'sources', 'analysis-hints.md'), 'utf8');
    sourceHints = sourceHints.slice(0, 30000);
  } catch {
    sourceHints = '';
  }

  const { provider, tier } = await resolveProvider();
  const analysisChunks = fullText.length > MAX_TEXT_CHARS ? splitIntoChunks(fullText, CHUNK_SIZE) : [{ title: '全文', text: fullText }];
  const candidateNames = sourceHints ? await _extractCandidateNamesWithAi(provider, tier, sourceHints, analysisChunks) : [];
  if (candidateNames.length > 0) {
    sourceHints = _appendCandidateNamesToHints(sourceHints, candidateNames);
  }

  // Short text: single batch
  if (fullText.length <= MAX_TEXT_CHARS) {
    const runIds = [];
    const taskIds = [];
    const promises = TASK_DEFS.map((task) => {
      const runId = `import-${task.id}-${Date.now().toString(36)}`;
      runIds.push(runId);
      taskIds.push(task.id);
      return _runTaskForChunk({ runId, provider, tier, task, chunkText: fullText, chunkIndex: 0, chunkCount: 1, chunkTitle: '全文', sourceHints });
    });

    _pending.set(stagingDir, { promise: Promise.all(promises), chunkMode: false, chunkCount: 1, sourceHints });
    return { runIds, taskIds };
  }

  // Long text: chunked mode
  const chunks = splitIntoChunks(fullText, CHUNK_SIZE);
  console.error(`[analyzer] Chunked mode: ${chunks.length} chunks for ${fullText.length} chars`);

  const allResults = [];
  const runIds = [];
  const taskIds = [];
  const chunkPromises = [];

  for (let ci = 0; ci < chunks.length; ci++) {
    const chunk = chunks[ci];
    const contextNote = ci > 0 ? _buildChunkContext(allResults) : '';

    // Generate runIds for this chunk and build runIdMap
    const runIdMap = {};
    for (const task of TASK_DEFS) {
      const runId = `import-${task.id}-c${ci}-${Date.now().toString(36)}`;
      runIdMap[task.id] = runId;
      runIds.push(runId);
      taskIds.push(task.id);
    }

    const promise = _analyzeSingleChunk({ provider, tier, chunk, chunkIndex: ci, chunkCount: chunks.length, contextNote, runIdMap, sourceHints });
    chunkPromises.push(
      promise.then((results) => {
        // Collect results for this chunk into the accumulator for next chunk's context
        const chunkResult = { chunkIndex: ci, chunkTitle: chunk.title };
        for (const r of results) {
          if (r.error) continue;
          if (r.taskId === 'characters') chunkResult.characters = _parseJsonArray(r.output);
          if (r.taskId === 'factions') chunkResult.factions = _parseJsonArray(r.output);
          if (r.taskId === 'timeline') chunkResult.timeline = _parseJsonArray(r.output);
          if (r.taskId === 'world') chunkResult.world = _parseJson(r.output);
          if (r.taskId === 'outline') chunkResult.outline = r.output;
          if (r.taskId === 'style') chunkResult.style = r.output;
        }
        allResults.push(chunkResult);
        return results;
      })
    );
  }

  _pending.set(stagingDir, { promise: Promise.all(chunkPromises), chunkMode: true, chunkCount: chunks.length, chunkResults: allResults, sourceHints });
  return { runIds, taskIds, chunkMode: true, chunkCount: chunks.length };
}

/**
 * Await pending results and write to staging project files.
 * Throws if ALL tasks failed (so the frontend sees the error).
 */
async function finalizeAnalyses(stagingDir) {
  const pending = _pending.get(stagingDir);
  if (!pending) return { characters: 0, outline: '', lore: '', style: '' };

  const { promise, chunkMode, chunkCount, chunkResults: prebuilt, sourceHints = '' } = pending;
  _pending.delete(stagingDir);

  let results;
  if (chunkMode) {
    const chunkArrays = await promise; // array of array of { taskId, output, error, chunkIndex }
    // Rebuild per-task results from all chunks, then merge
    const perChunk = [];
    for (const arr of chunkArrays) {
      const cr = {};
      for (const r of arr) {
        if (r.error) continue;
        cr.chunkIndex = r.chunkIndex;
        cr.chunkTitle = r.chunkTitle;
        if (r.taskId === 'characters') cr.characters = _parseJsonArray(r.output);
        if (r.taskId === 'factions') cr.factions = _parseJsonArray(r.output);
        if (r.taskId === 'timeline') cr.timeline = _parseJsonArray(r.output);
        if (r.taskId === 'world') cr.world = _parseJson(r.output);
        if (r.taskId === 'outline') cr.outline = r.output;
        if (r.taskId === 'style') cr.style = r.output;
      }
      if (Object.keys(cr).length > 2) perChunk.push(cr);
    }

    const merged = mergeChunkResults(perChunk);

    // Convert merged results back to the format expected by the write loop
    results = [
      { taskId: 'characters', output: JSON.stringify(merged.characters) },
      { taskId: 'factions', output: JSON.stringify(merged.factions) },
      { taskId: 'timeline', output: JSON.stringify(merged.timeline) },
      { taskId: 'world', output: JSON.stringify(merged.world) },
      { taskId: 'outline', output: merged.outline },
      { taskId: 'style', output: merged.style },
    ];
  } else {
    results = await promise;
  }

  const errors = results.filter((r) => r.error).map((r) => r.error);
  const successes = results.filter((r) => r.output);
  if (errors.length === TASK_DEFS.length && successes.length === 0) {
    throw new Error(`AI 分析失败: ${errors[0]}`);
  }

  let charCount = 0, outlineLen = 0, loreLen = 0, styleLen = 0, factionCount = 0, timelineCount = 0;

  // Collect all results by taskId for cross-referencing
  const resultsByTask = {};
  for (const r of results) resultsByTask[r.taskId] = r;

  for (const r of results) {
    if (!r.output) continue;
    try {
      const outDir = path.join(stagingDir, TASK_DEFS.find((t) => t.id === r.taskId)?.outputDir || r.taskId);
      await fs.mkdir(outDir, { recursive: true });

      if (r.taskId === 'characters') {
        console.error('[analyzer] characters raw output length:', r.output.length, 'first 500:', r.output.slice(0, 500));
        const chars = _parseJsonArray(r.output);
        console.error('[analyzer] characters parsed count:', chars.length);
        charCount = chars.length;
        // If characters task returned nothing, try to extract names from the outline output
        if (charCount === 0 && (sourceHints || resultsByTask.outline?.output)) {
          const fallbackNames = _extractNamesFromOutline(`${sourceHints}\n\n${resultsByTask.outline?.output || ''}`);
          const fallbackChars = _sanitizeCharacterCards(
            fallbackNames.map((name) => ({ id: name, name, role: '' })),
            sourceHints
          );
          for (const ch of fallbackChars) {
            await fs.writeFile(path.join(outDir, `${ch.name}.json`), JSON.stringify(ch, null, 2), 'utf8');
          }
          charCount = fallbackChars.length;
        } else {
          if (sourceHints) {
            const supplementNames = _extractNamesFromOutline(sourceHints);
            const existingNameKeys = new Set(chars.map((ch) => _normalizePersonName(ch.name || ch.id)).filter(Boolean));
            for (const name of supplementNames) {
              const key = _normalizePersonName(name);
              if (key && !existingNameKeys.has(key)) {
                chars.push({ id: name, name, role: '' });
                existingNameKeys.add(key);
              }
            }
            charCount = chars.length;
          }
          const sanitizedChars = _sanitizeCharacterCards(chars, sourceHints);
          charCount = sanitizedChars.length;
          // No longer auto-enrich during import; enrichment happens in character-review step
          const usedNames = new Set();
          for (const ch of sanitizedChars) {
            let baseName = ch.id || ch.name || 'char';
            let fname = baseName;
            let dupIdx = 1;
            while (usedNames.has(fname)) { fname = `${baseName}-${dupIdx++}`; }
            usedNames.add(fname);
            const charObj = { ...ch, id: ch.id || fname };
            await fs.writeFile(path.join(outDir, `${fname}.json`), JSON.stringify(charObj, null, 2), 'utf8');
          }
        }
      } else if (r.taskId === 'world') {
        const parsed = _parseJson(r.output);
        const lore = parsed?.lore || parsed?.timeSetting || (typeof r.output === 'string' && r.output.length > 50 ? r.output : '');
        loreLen = lore.length;
        await fs.writeFile(path.join(outDir, 'lore.md'), lore, 'utf8');
        await fs.writeFile(path.join(outDir, 'places.json'), JSON.stringify({ schemaVersion: 1, places: parsed?.places || [] }, null, 2), 'utf8');
        // Save fanwork detection metadata including AI-suggested isFanwork and referencedWorks
        const meta = {
          schemaVersion: 1,
          isFanwork: parsed?.isFanwork || false,
          referencedWorks: parsed?.referencedWorks || [],
          possibleFanworkOf: parsed?.possibleFanworkOf || null,
          detectedAt: new Date().toISOString(),
        };
        await fs.writeFile(path.join(outDir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');
      } else if (r.taskId === 'outline') {
        const cleaned = _cleanAnalysisMarkdown(r.output);
        outlineLen = cleaned.length;
        await fs.writeFile(path.join(outDir, 'main.md'), cleaned, 'utf8');
      } else if (r.taskId === 'factions') {
        const factions = _parseJsonArray(r.output);
        factionCount = factions.length;
        for (const f of factions) {
          await fs.writeFile(path.join(outDir, `${f.name || Math.random().toString(36).slice(2)}.json`), JSON.stringify(f, null, 2), 'utf8');
        }
      } else if (r.taskId === 'timeline') {
        let events = _parseJsonArray(r.output);
        if (events.length === 0 && resultsByTask.outline?.output) {
          events = _extractTimelineFromOutline(resultsByTask.outline.output);
        }
        timelineCount = events.length;
        if (events.length > 0) {
          const lines = events.map((e) => JSON.stringify(e)).join('\n');
          await fs.writeFile(path.join(outDir, 'events.jsonl'), lines + '\n', 'utf8');
        }
      } else if (r.taskId === 'style') {
        const cleaned = _cleanAnalysisMarkdown(r.output);
        styleLen = cleaned.length;
        await fs.writeFile(path.join(outDir, 'memory.md'), cleaned, 'utf8');
      }
    } catch (err) {
      console.error(`[analyzer] write ${r.taskId} failed:`, err.message);
    }
  }

  return { characters: charCount, factions: factionCount, timeline: timelineCount, outline: outlineLen, lore: loreLen, style: styleLen, chunkMode, chunkCount };
}

/**
 * Fallback: extract character names from outline markdown
 * (the "主要人物关系" section). Returns unique names.
 */
function _extractNamesFromOutline(outlineText) {
  const names = [];
  const source = String(outlineText || '');
  const directPatterns = [
    /(?:主角|男主|女主|空姐|少女|女孩|角色|姓名|名字)[：:为叫是\s“"]*([\u4e00-\u9fa5]{2,4})/g,
    /^\s*(?:[-•*]\s*)?(?:\*\*)?([\u4e00-\u9fa5]{2,4})(?:\*\*)?(?:（[^）]{0,12}）|\([^)]{0,12}\))?[：:]/gm,
    /^\s*([\u4e00-\u9fa5]{2,4})\s*$/gm,
  ];
  for (const pattern of directPatterns) {
    let match;
    while ((match = pattern.exec(source))) {
      const name = _normalizePersonName(match[1]);
      if (name) names.push(name);
    }
  }
  // Match markdown list items that look like character names:
  // "- 张三" or "- 张三（主角）" or "- 张三和李四"
  const items = source.match(/[-•*]\s+([^\n]+)/g) || [];
  for (const item of items) {
    // Remove list marker and trim
    const clean = item.replace(/^[-•*]\s*/, '').trim();
    // Split on common delimiters: 、 , ， 、 and brackets
    const parts = clean.split(/[、,，&＆/]/).map((s) => s.replace(/[（(].*[）)]/g, '').trim()).filter(Boolean);
    for (const p of parts) {
      // Filter out non-name text (relationship descriptions, etc.)
      const name = _normalizePersonName(p);
      if (name) {
        names.push(name);
      }
    }
  }
  names.push(..._extractTrustedCjkNamesFromHints(source));
  names.push(..._extractNonChineseNamesFromHints(source));
  return [...new Set(names)];
}

function _extractTrustedCjkNamesFromHints(sourceHints) {
  const source = String(sourceHints || '');
  const names = [];
  const candidateSection = source.match(/##\s*AI候选角色姓名([\s\S]*?)(?=\n##\s+|$)/);
  const lines = (candidateSection ? candidateSection[1] : source).split(/\n+/);
  for (const line of lines) {
    if (!candidateSection && !/(?:角色|人物|姓名|名字|主角|女主|男主|人名|日本|日式)/.test(line)) continue;
    const chunks = line.match(/[\u4e00-\u9fa5]{2,4}/g) || [];
    for (const chunk of chunks) {
      const name = _normalizePersonName(chunk) || _normalizeTrustedCjkName(chunk, source);
      if (name) names.push(name);
    }
  }
  return [...new Set(names)];
}

function _normalizePersonName(raw) {
  const text = String(raw || '')
    .replace(/^[\s"'“”‘’]+|[\s"'“”‘’]+$/g, '')
    .replace(/[（(].*[）)]/g, '')
    .replace(/[的地得之]$/g, '')
    .trim();
  if (text.length < 2 || text.length > 4) return '';
  if (_isDefinitelyNonPersonName(text)) return '';
  if (/^(主角|男主|女主|空姐|少女|女孩|金发|金发女孩|乘客|尸体|死者|众人|飞机|章节|故事|文本|原作|关系|暗线|明线|冲突|伏笔|悬念|角色)$/.test(text)) return '';
  if (/^[是关于和与的了对不在有以及或]+$/.test(text)) return '';
  if (!_looksLikeChinesePersonName(text)) return '';
  return text;
}

const COMMON_SINGLE_SURNAMES = new Set('赵钱孙李周吴郑王冯陈褚卫蒋沈韩杨朱秦尤许何吕施张孔曹严华金魏陶姜戚谢邹喻柏水窦章云苏潘葛奚范彭郎鲁韦昌马苗凤花方俞任袁柳鲍史唐费廉岑薛雷贺倪汤滕殷罗毕郝邬安常乐于时傅皮卞齐康伍余元卜顾孟平黄和穆萧尹姚邵湛汪祁毛禹狄米贝明臧计伏成戴谈宋庞熊纪舒屈项祝董梁杜阮蓝闵席季麻强贾路娄危江童颜郭梅盛林刁钟徐邱骆高夏蔡田胡凌霍虞万支柯昝管卢莫经房裘缪干解应宗丁宣邓郁单杭洪包诸左石崔吉龚程嵇邢裴陆荣翁荀羊於惠甄曲家封芮羿储靳汲邴糜松井段富巫乌焦巴弓牧隗山谷车侯宓蓬全郗班仰秋仲伊宫宁仇栾暴甘斜厉戎祖武符刘景詹束龙叶幸司韶郜黎蓟薄印宿白怀蒲邰从鄂索咸籍赖卓蔺屠蒙池乔阴胥能苍双闻莘党翟谭贡劳逄姬申扶堵冉宰郦雍郤璩桑桂濮牛寿通边扈燕冀浦尚农温别庄晏柴瞿阎充慕连茹习宦艾鱼容向古易慎戈廖庾终暨居衡步都耿满弘匡国文寇广禄阙东欧利师巩聂关荆司迟游竺权逯盖益桓公仉督晋楚闫法汝鄢涂钦岳帅缑亢况后有琴商牟佘佴伯赏墨哈谯笪年爱阳佟第五言福'.split(''));
const COMMON_COMPOUND_SURNAMES = [
  '欧阳', '太史', '端木', '上官', '司马', '东方', '独孤', '南宫', '万俟', '闻人', '夏侯', '诸葛',
  '尉迟', '公羊', '赫连', '澹台', '皇甫', '宗政', '濮阳', '公冶', '太叔', '申屠', '公孙', '慕容',
  '仲孙', '钟离', '长孙', '宇文', '司徒', '鲜于', '司空', '闾丘', '子车', '亓官', '司寇', '巫马',
  '公西', '颛孙', '壤驷', '公良', '漆雕', '乐正', '宰父', '谷梁', '拓跋', '夹谷', '轩辕', '令狐',
  '段干', '百里', '呼延', '东郭', '南门', '羊舌', '微生', '公户', '公玉', '公仪', '梁丘', '公仲',
  '公上', '公门', '公山', '公坚', '左丘', '公伯', '西门', '公祖', '第五', '公乘', '贯丘', '公皙',
  '南荣', '东里', '东宫', '仲长', '子书', '子桑', '即墨', '达奚', '褚师',
];
const COMMON_JP_SURNAME_PREFIXES = [
  '佐藤', '铃木', '高桥', '田中', '伊藤', '渡边', '山本', '中村', '小林', '加藤', '吉田', '山田',
  '佐佐木', '山口', '松本', '井上', '木村', '林', '清水', '斋藤', '山崎', '森', '池田', '桥本',
  '阿部', '石川', '山下', '中岛', '石井', '前田', '藤田', '冈田', '后藤', '长谷川', '村上',
  '近藤', '上野', '神谷', '白井', '黑川', '星野', '七海', '朝仓', '藤原', '橘',
];
const NON_NAME_BIGRAMS = /^(一样|一片|一行|一边|一下|一声|一个|一种|一些|这里|那里|这个|那个|以及|然后|只是|已经|开始|继续|突然|仿佛|空气|身体|下体|下手|从背|奸淫|空白|人将|只剩|之前|之后|其中|所以|但是|因为|如果|可以|没有|不是|就是|所有|每个|这些|那些|她们|他们|我们|你们|时候|声音|目光|脸上|身上|心里|眼前|周围|基地|房间|舱门|飞机|冰原|雪地|章节|正文|版本|部分|阶段|计划|主动)/;

function _isDefinitelyNonPersonName(name) {
  const text = String(name || '').trim();
  if (!text) return true;
  if (/^第[一二三四五六七八九十百千万零\d]+(?:部分|阶段|章|章节|节|幕|卷|次|回)$/.test(text)) return true;
  if (/^(?:第一|第二|第三|第四|第五|第六|第七|第八|第九|第十)(?:部分|阶段|章|章节|节|幕|卷)$/.test(text)) return true;
  if (/^(?:部分|阶段|章节|正文|故事|候选|姓名|角色|人物|主要人物|关系|计划|任务|目标|流程|版本|片段|大纲|文风|分析|确认)$/.test(text)) return true;
  if (/^(?:和|与|及|跟|同|对|把|被|将|让|能|都|又|再|已|在|从|向|到|为|以|这|那)[\u4e00-\u9fa5]{1,5}$/.test(text)) return true;
  if (/[\u4e00-\u9fa5]+[的地得之][\u4e00-\u9fa5]+/.test(text)) return true;
  if (/^(?:金发|银发|黑发|白发|蓝发|红发|碧眼|黑眼|蓝眼|红眼|长发|短发|舞蹈生|空姐|少女|女孩|乘客|尸体|死者)/.test(text)) return true;
  if (/(?:主动|计划|阶段|部分|章节|正文|候选|补全|联网|识别|抽取|整理|分析|选择|导入|确认|开始|继续|已经|没有|过去|过世|拿过|能去|将机|去主|不是|上一步|下一步)/.test(text)) return true;
  return false;
}

function _looksLikeChinesePersonName(name) {
  const text = String(name || '').trim();
  if (!/^[\u4e00-\u9fa5]{2,4}$/.test(text)) return false;
  if (_isDefinitelyNonPersonName(text)) return false;
  if (NON_NAME_BIGRAMS.test(text)) return false;
  if (COMMON_COMPOUND_SURNAMES.some((surname) => text.startsWith(surname) && text.length > surname.length)) return true;
  if (COMMON_JP_SURNAME_PREFIXES.some((surname) => text.startsWith(surname) && text.length > surname.length)) return true;
  return COMMON_SINGLE_SURNAMES.has(text[0]);
}

function _slugFromName(name) {
  const text = String(name || '').trim();
  if (!text) return '';
  if (/^[a-z][a-z0-9_-]*$/i.test(text)) return text.toLowerCase();
  return text.replace(/[^\w\u4e00-\u9fa5.-]/g, '_');
}

function _isGenericRoleName(name) {
  const text = String(name || '').trim();
  return /^(我|主角|男主|女主|叙述者|乘客|旅客|空姐|空乘|乘务员|机长|副驾驶|驾驶员|尸体|死者|女孩|少女|小女孩|金发女孩|金发小女孩|众人|孩子|女性|男人|女人)$/.test(text);
}

function _isSyntheticId(id, sourceHints) {
  const text = String(id || '').trim();
  if (!text) return true;
  if (/^(wo|i|me|narrator|protagonist|main|mainchar|char|character|unknown|kongjie\d*|stewardess\d*|flightattendant\d*|black_?stocking_?attendant|jizhang|fujizhang|captain|first_?officer|copilot)$/i.test(text)) {
    return true;
  }
  if (/^(?:black|blonde|golden|female|male|young|dead|flight|stocking|attendant|captain|first|officer|protagonist|narrator)[a-z0-9_-]*$/i.test(text)
    && !String(sourceHints || '').toLowerCase().includes(text.toLowerCase())) return true;
  if (/^[a-z]+[0-9]+$/i.test(text) && !String(sourceHints || '').toLowerCase().includes(text.toLowerCase())) {
    return true;
  }
  return false;
}

function _nameAppearsInHints(name, sourceHints) {
  const text = String(name || '').trim();
  if (!text) return false;
  return String(sourceHints || '').toLowerCase().includes(text.toLowerCase());
}

function _normalizeTrustedCjkName(raw, sourceHints = '') {
  const text = String(raw || '')
    .replace(/^[\s"'“”‘’]+|[\s"'“”‘’]+$/g, '')
    .replace(/[（(].*[）)]/g, '')
    .replace(/[的地得之]$/g, '')
    .trim();
  if (!/^[\u4e00-\u9fa5]{2,4}$/.test(text)) return '';
  if (_isGenericRoleName(text)) return '';
  if (_isDefinitelyNonPersonName(text)) return '';
  if (NON_NAME_BIGRAMS.test(text)) return '';
  if (!_nameAppearsInHints(text, sourceHints)) return '';
  return text;
}

function _sanitizeCharacterCards(chars, sourceHints = '') {
  const result = [];
  const seen = new Set();
  const hasSourceHints = Boolean(String(sourceHints || '').trim());
  const trustedNames = new Set([
    ..._extractNamesFromOutline(sourceHints),
    ..._extractLatinNamesFromHints(sourceHints),
    ..._extractNonChineseNamesFromHints(sourceHints),
  ].filter(Boolean));

  for (const raw of chars || []) {
    if (!raw || typeof raw !== 'object') continue;
    const id = String(raw.id || '').trim();
    let name = String(raw.name || '').trim();
    const protagonist = raw.protagonist === true;

    if (!name && protagonist && /^(wo|i|me|narrator|protagonist|main|mainchar)?$/i.test(id)) {
      name = '我（主角）';
    } else if (!name && /^[\u4e00-\u9fa5]{2,4}$/.test(id) && !_isGenericRoleName(id) && _normalizePersonName(id)) {
      name = id;
    } else if (!name && !_isSyntheticId(id, sourceHints) && _nameAppearsInHints(id, sourceHints)) {
      name = id;
    } else if (!name && !_isSyntheticId(id, sourceHints) && /^[\u4e00-\u9fa5]{2,4}$/.test(id) && _normalizePersonName(id)) {
      name = id;
    }

    if (name === '我' || name === '主角' || name === '叙述者') {
      if (protagonist) name = '我（主角）';
    }

    const normalizedChinese = _normalizePersonName(name);
    const normalizedTrustedCjk = normalizedChinese || _normalizeTrustedCjkName(name, sourceHints);
    const hasTrustedChineseName = normalizedTrustedCjk && (!hasSourceHints || trustedNames.has(normalizedTrustedCjk) || _nameAppearsInHints(normalizedTrustedCjk, sourceHints));
    const normalizedForeign = _normalizeTrustedForeignName(name);
    const hasTrustedForeignName = normalizedForeign && (!hasSourceHints || trustedNames.has(normalizedForeign) || _nameAppearsInHints(normalizedForeign, sourceHints));
    const isNarrator = name === '我（主角）';
    if (!isNarrator && _isDefinitelyNonPersonName(name)) continue;
    if (!isNarrator && !hasTrustedChineseName && !hasTrustedForeignName) continue;
    if (!isNarrator && _isGenericRoleName(name)) continue;
    if (!name && _isSyntheticId(id, sourceHints)) continue;

    const finalName = isNarrator ? name : (hasTrustedChineseName ? normalizedTrustedCjk : normalizedForeign);
    const key = finalName.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    result.push({
      ...raw,
      id: !_isSyntheticId(id, sourceHints) ? id : (_slugFromName(finalName) || `char-${result.length + 1}`),
      name: finalName,
    });
  }

  return result;
}

function _cleanAnalysisMarkdown(text) {
  let cleaned = String(text || '').trim();
  cleaned = cleaned
    .replace(/^(好的|当然|以下是|下面是)[^\n]*(?:分析|大纲|提取|整理)[^\n]*\n+/i, '')
    .replace(/^---+\n+/, '')
    .replace(/^#{3,6}\s*##\s+/gm, '## ')
    .replace(/^#{4,6}\s*###\s+/gm, '### ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return cleaned;
}

function _extractTimelineFromOutline(outlineText) {
  const source = _cleanAnalysisMarkdown(outlineText);
  const sectionMatch = source.match(/##\s*章节概要([\s\S]*?)(?=\n##\s+|$)/);
  const section = sectionMatch ? sectionMatch[1] : source;
  const events = [];
  const lines = section.split(/\n+/);
  for (const line of lines) {
    const trimmed = line.replace(/^[-*•]\s*/, '').replace(/^\d+[.、]\s*/, '').trim();
    if (!trimmed || trimmed.length < 6) continue;
    const bold = trimmed.match(/^\*\*([^*]+)\*\*[：:]\s*(.+)$/);
    const colon = trimmed.match(/^([^：:]{2,30})[：:]\s*(.+)$/);
    const title = (bold?.[1] || colon?.[1] || '').trim();
    const event = (bold?.[2] || colon?.[2] || trimmed).trim();
    if (!event || /原作识别|故事梗概|主要人物关系|冲突设定|伏笔|悬念/.test(event)) continue;
    events.push({
      id: `evt-${events.length + 1}`,
      timestamp: title || `章节概要 ${events.length + 1}`,
      title: title || event.slice(0, 24),
      event,
      type: 'plot',
      importance: 'major',
      involvedCharacters: [],
    });
    if (events.length >= 80) break;
  }
  return events;
}

function _extractLatinNamesFromHints(sourceHints) {
  const names = [];
  const pattern = /\b[A-Z][A-Za-z][A-Za-z'-]{1,30}\b/g;
  let match;
  while ((match = pattern.exec(String(sourceHints || '')))) {
    const name = match[0];
    if (/^(Chatbox|Markdown|JSON|USER|ASSISTANT|SYSTEM|AI)$/i.test(name)) continue;
    names.push(name);
  }
  return [...new Set(names)];
}

function _extractNonChineseNamesFromHints(sourceHints) {
  const source = String(sourceHints || '');
  const names = [];
  let match;

  const kanaPattern = /[\u30A0-\u30FFー]{2,24}(?:[・=][\u30A0-\u30FFー]{2,24}){0,3}/g;
  while ((match = kanaPattern.exec(source))) {
    const name = _normalizeTrustedForeignName(match[0]);
    if (name) names.push(name);
  }

  const cyrillicPattern = /(?:^|[^\p{Script=Cyrillic}])(\p{Lu}\p{Script=Cyrillic}{1,24}(?:[ -]\p{Lu}\p{Script=Cyrillic}{1,24}){0,2})(?=$|[^\p{Script=Cyrillic}])/gu;
  while ((match = cyrillicPattern.exec(source))) {
    const name = _normalizeTrustedForeignName(match[1]);
    if (name) names.push(name);
  }

  return [...new Set(names)];
}

function _normalizeTrustedForeignName(raw) {
  const text = String(raw || '')
    .replace(/^[\s"'“”‘’「」『』《》]+|[\s"'“”‘’「」『』《》]+$/g, '')
    .trim();
  if (text.length < 2 || text.length > 80) return '';
  if (/^(Chatbox|Markdown|JSON|USER|ASSISTANT|SYSTEM|AI)$/i.test(text)) return '';
  if (/^[A-Z][A-Z_]{2,}$/.test(text)) return '';
  if (/^[\u30A0-\u30FFー・=]+$/.test(text)) return text;
  if (/^\p{Lu}\p{Script=Cyrillic}{1,24}(?:[ -]\p{Lu}\p{Script=Cyrillic}{1,24}){0,2}$/u.test(text)) return text;
  if (/^[A-Z][A-Za-z][A-Za-z .'-]{0,40}$/.test(text)) return text;
  return '';
}

function _buildCharacterFocusedText(sourceHints, chunkText, maxChars = 22000) {
  const candidateNames = [
    ..._extractNamesFromOutline(sourceHints),
    ..._extractLatinNamesFromHints(sourceHints),
    ..._extractNonChineseNamesFromHints(sourceHints),
  ];
  const uniqueCandidates = [...new Set(candidateNames)].filter(Boolean);
  const lines = [];
  lines.push('## 候选角色姓名');
  lines.push(uniqueCandidates.length > 0 ? uniqueCandidates.map((name) => `- ${name}`).join('\n') : '- （无明确候选姓名）');
  lines.push('\n## 用户设定/大纲线索');
  lines.push(String(sourceHints || '').slice(0, 12000));

  const source = String(chunkText || '');
  const snippets = [];
  for (const name of uniqueCandidates) {
    const needle = String(name || '').trim();
    if (!needle) continue;
    const lowerSource = source.toLowerCase();
    const lowerNeedle = needle.toLowerCase();
    let index = lowerSource.indexOf(lowerNeedle);
    let count = 0;
    while (index >= 0 && count < 3) {
      const start = Math.max(0, index - 350);
      const end = Math.min(source.length, index + needle.length + 550);
      snippets.push(`### ${needle}\n${_redactSyntheticCharacterTokens(source.slice(start, end).trim())}`);
      index = lowerSource.indexOf(lowerNeedle, index + lowerNeedle.length);
      count++;
    }
  }

  if (snippets.length > 0) {
    lines.push('\n## 正文中候选姓名附近片段');
    lines.push(snippets.join('\n\n'));
  }

  return lines.join('\n\n').slice(0, maxChars);
}

function _redactSyntheticCharacterTokens(text) {
  return String(text || '')
    .replace(/\b(?:black_?stocking_?attendant|first_?officer|flight_?attendant|protagonist|narrator|captain|copilot)\b/gi, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function _parseJsonArray(raw) {
  if (!raw) {
    console.error('[analyzer] _parseJsonArray: raw is empty');
    return [];
  }
  console.error('[analyzer] _parseJsonArray raw start:', raw.slice(0, 200));
  // Remove markdown code fences
  let cleaned = raw.replace(/```(?:json)?\s*/gi, '').replace(/```\s*$/g, '').trim();
  // If there's text before the JSON array, strip it (reset bracket index after slice)
  let bracket = cleaned.indexOf('[');
  if (bracket > 0) { cleaned = cleaned.slice(bracket); bracket = 0; }
  // Try direct parse
  try { const p = JSON.parse(cleaned); if (Array.isArray(p)) return p; } catch { /* fallback */ }
  // Try slicing to the last ] (handles trailing text)
  const e = cleaned.lastIndexOf(']');
  if (e > 0) {
    try { const p = JSON.parse(cleaned.slice(0, e + 1)); if (Array.isArray(p)) return p; } catch { /* ignore */ }
  }
  // Try wrapping in [] if model returned individual objects
  try { const p = JSON.parse('[' + cleaned + ']'); if (Array.isArray(p)) return p; } catch { /* ignore */ }
  // Try parsing as object and finding an array value (model might wrap: {"characters": [...]})
  try { const obj = JSON.parse(cleaned); if (typeof obj === 'object') { for (const v of Object.values(obj)) { if (Array.isArray(v)) return v; } } } catch { /* ignore */ }
  // Handle TRUNCATED JSON — the model output was cut off mid-object.
  // Extract each complete {…} object by scanning for balanced braces.
  console.error('[analyzer] _parseJsonArray attempting truncated JSON recovery...');
  const recovered = [];
  let depth = 0, objStart = -1;
  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (ch === '{') {
      if (depth === 0) objStart = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && objStart >= 0) {
        try {
          const obj = JSON.parse(cleaned.slice(objStart, i + 1));
          if (typeof obj === 'object' && !Array.isArray(obj)) recovered.push(obj);
        } catch { /* skip malformed object */ }
        objStart = -1;
      }
    }
  }
  if (recovered.length > 0) {
    console.error('[analyzer] recovered', recovered.length, 'objects from truncated JSON');
    return recovered;
  }
  console.error('[analyzer] _parseJsonArray FAILED for:', cleaned.slice(0, 300));
  return [];
}

function _parseJson(raw) {
  if (!raw) return null;
  let cleaned = raw.replace(/```(?:json)?\s*/gi, '').replace(/```\s*$/g, '').trim();
  let brace = cleaned.indexOf('{');
  if (brace > 0) { cleaned = cleaned.slice(brace); brace = 0; }
  try { return JSON.parse(cleaned); } catch { /* fallback */ }
  const e = cleaned.lastIndexOf('}');
  if (e > 0) try { return JSON.parse(cleaned.slice(0, e + 1)); } catch { /* ignore */ }
  return null;
}

async function extractCharacters(text) {
  if (!text || text.length < 50) return [];
  const { provider, tier } = await resolveProvider();
  const prompt = `${TASK_PROMPTS.characters}\n\n${text}`;
  const result = await provider.sendMessage({
    system: '',
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    tools: [],
    tier,
  });
  const textBlock = (result.content || []).find((b) => b.type === 'text');
  return _parseJsonArray(textBlock?.text || '');
}

module.exports = {
  startAnalyses,
  finalizeAnalyses,
  extractCharacters,
  resolveProvider,
  _internal: {
    _cleanAnalysisMarkdown,
    _extractTimelineFromOutline,
    _extractNamesFromOutline,
    _extractCandidateNamesWithAi,
    _extractCandidateNamesForText,
    _normalizeCandidateNameItems,
    _mergeCandidateNameItems,
    _mergeCandidateNamesWithAi,
    _appendCandidateNamesToHints,
    _normalizePersonName,
    _isDefinitelyNonPersonName,
    _looksLikeChinesePersonName,
    _extractTrustedCjkNamesFromHints,
    _normalizeTrustedCjkName,
    _extractNonChineseNamesFromHints,
    _normalizeTrustedForeignName,
    _redactSyntheticCharacterTokens,
    _sanitizeCharacterCards,
    _buildCharacterFocusedText,
  },
};
