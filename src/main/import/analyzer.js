'use strict';

/**
 * Import Analyzer — direct-api driver 专用。
 *
 * 当使用 claude-code driver 时，导入分析由 sa-import-orchestrator subagent
 * 通过 MCP 工具自主完成。此模块的 6-task 并行分析逻辑仅作为 direct-api
 * 替补路径保留。
 *
 * Uses providerManager + modelAliases (same as chatAgent) to run analysis
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
const providerManager = require('../providerManager');
const modelAliases = require('../modelAliases');
const eventBus = require('../runtime/eventBus');
const characterEnricher = require('./characterEnricher');
const { splitIntoChunks, mergeChunkResults } = require('./resultMerger');

function pickProvider(type) {
  if (type === 'anthropic') return require('../runtime/providers/anthropic');
  if (type === 'openai-compat') return require('../runtime/providers/openaiCompat');
  throw new Error(`Unsupported provider type: ${type}`);
}

async function resolveProvider() {
  const alias = await modelAliases.getAlias('sonnet');
  const providerId = alias?.providerId || null;
  const provider = providerId
    ? await providerManager.getProvider(providerId)
    : await providerManager.getActiveProvider();
  if (!provider) throw new Error('没有配置 AI 服务商。请先在设置中配置 API Key 和模型。');
  const apiKey = provider.apiKey || '';
  if (!apiKey) throw new Error('AI 服务商 API Key 未设置。请先在设置中配置。');
  const modelId = alias?.modelId || provider.models?.[0]?.id || '';
  if (!modelId) throw new Error('没有配置 AI 模型。请先在设置中配置模型。');
  const type = provider.type || 'anthropic';
  return {
    provider: pickProvider(type),
    tier: { type, model: modelId, apiKey, baseUrl: provider.baseUrl || '', extra: { maxTokens: 16384 } },
  };
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
  outline: `从以下小说文本中提取剧情大纲，用 Markdown 格式输出以下内容。如果这篇小说看起来是已有作品的二创/同人，在开头注明。

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
  style: `分析以下小说的写作风格特征与作者创作意图，用 Markdown 输出：

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

async function _runTaskForChunk({ runId, provider, tier, task, chunkText, chunkIndex, chunkCount, chunkTitle, contextNote }) {
  const label = chunkCount > 1 ? `${task.label} [第 ${chunkIndex + 1}/${chunkCount} 片]` : task.label;

  try {
    eventBus.emit({ runId, subagentId: 'sa-import-analyzer', kind: 'running', data: { label, chunkIndex, chunkCount, chunkTitle } });

    let prompt = TASK_PROMPTS[task.id];
    if (contextNote) {
      prompt = `【上下文】${contextNote}\n\n${prompt}`;
    }

    const result = await provider.sendMessage({
      system: '',
      messages: [{ role: 'user', content: [{ type: 'text', text: `${prompt}\n\n${chunkText}` }] }],
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

async function _analyzeSingleChunk({ provider, tier, chunk, chunkIndex, chunkCount, contextNote, runIdMap }) {
  const promises = TASK_DEFS.map((task) =>
    _runTaskForChunk({ runId: runIdMap[task.id], provider, tier, task, chunkText: chunk.text, chunkIndex, chunkCount, chunkTitle: chunk.title, contextNote })
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

  const { provider, tier } = await resolveProvider();

  // Short text: single batch
  if (fullText.length <= MAX_TEXT_CHARS) {
    const runIds = [];
    const taskIds = [];
    const promises = TASK_DEFS.map((task) => {
      const runId = `import-${task.id}-${Date.now().toString(36)}`;
      runIds.push(runId);
      taskIds.push(task.id);
      return _runTaskForChunk({ runId, provider, tier, task, chunkText: fullText, chunkIndex: 0, chunkCount: 1, chunkTitle: '全文' });
    });

    _pending.set(stagingDir, { promise: Promise.all(promises), chunkMode: false, chunkCount: 1 });
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

    const promise = _analyzeSingleChunk({ provider, tier, chunk, chunkIndex: ci, chunkCount: chunks.length, contextNote, runIdMap });
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

  _pending.set(stagingDir, { promise: Promise.all(chunkPromises), chunkMode: true, chunkCount: chunks.length, chunkResults: allResults });
  return { runIds, taskIds, chunkMode: true, chunkCount: chunks.length };
}

/**
 * Await pending results and write to staging project files.
 * Throws if ALL tasks failed (so the frontend sees the error).
 */
async function finalizeAnalyses(stagingDir) {
  const pending = _pending.get(stagingDir);
  if (!pending) return { characters: 0, outline: '', lore: '', style: '' };

  const { promise, chunkMode, chunkCount, chunkResults: prebuilt } = pending;
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
        if (charCount === 0 && resultsByTask.outline?.output) {
          const fallbackNames = _extractNamesFromOutline(resultsByTask.outline.output);
          for (const name of fallbackNames) {
            await fs.writeFile(path.join(outDir, `${name}.json`), JSON.stringify({ id: name, name, role: '' }, null, 2), 'utf8');
          }
          charCount = fallbackNames.length;
        } else {
          // No longer auto-enrich during import; enrichment happens in character-review step
          const usedNames = new Set();
          for (const ch of chars) {
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
        outlineLen = r.output.length;
        await fs.writeFile(path.join(outDir, 'main.md'), r.output, 'utf8');
      } else if (r.taskId === 'factions') {
        const factions = _parseJsonArray(r.output);
        factionCount = factions.length;
        for (const f of factions) {
          await fs.writeFile(path.join(outDir, `${f.name || Math.random().toString(36).slice(2)}.json`), JSON.stringify(f, null, 2), 'utf8');
        }
      } else if (r.taskId === 'timeline') {
        const events = _parseJsonArray(r.output);
        timelineCount = events.length;
        if (events.length > 0) {
          const lines = events.map((e) => JSON.stringify(e)).join('\n');
          await fs.writeFile(path.join(outDir, 'events.jsonl'), lines + '\n', 'utf8');
        }
      } else if (r.taskId === 'style') {
        styleLen = r.output.length;
        await fs.writeFile(path.join(outDir, 'memory.md'), r.output, 'utf8');
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
  // Match markdown list items that look like character names:
  // "- 张三" or "- 张三（主角）" or "- 张三和李四"
  const items = outlineText.match(/[-•*]\s+([^\n]+)/g) || [];
  for (const item of items) {
    // Remove list marker and trim
    const clean = item.replace(/^[-•*]\s*/, '').trim();
    // Split on common delimiters: 、 , ， 、 and brackets
    const parts = clean.split(/[、,，&＆/]/).map((s) => s.replace(/[（(].*[）)]/g, '').trim()).filter(Boolean);
    for (const p of parts) {
      // Filter out non-name text (relationship descriptions, etc.)
      if (p.length >= 2 && p.length <= 12 && !/^[是关于和与的了对不在有以及或]$/.test(p)) {
        names.push(p);
      }
    }
  }
  return [...new Set(names)];
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

module.exports = { startAnalyses, finalizeAnalyses, extractCharacters, resolveProvider };
