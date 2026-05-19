'use strict';

/**
 * Skills store — manages named skill documents that can be assigned to subagents.
 *
 * <userData>/skills/
 *   index.json   — registry of all skills (metadata only, no content)
 *   <id>.md      — per-skill Markdown content
 */

const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs').promises;
const { paths, skillContentPath } = require('./paths');
const { readJson, writeJson } = require('./jsonStore');

const SCHEMA_VERSION = 1;

const INDEX_PATH = () => paths().skillsIndex;

function _emptyIndex() {
  return { schemaVersion: SCHEMA_VERSION, skills: [] };
}

async function _loadIndex() {
  return readJson(INDEX_PATH(), _emptyIndex());
}

async function _saveIndex(idx) {
  await writeJson(INDEX_PATH(), idx);
}

const DE_AI_LEGACY_BLOCK = [
  '### 1. 避免「不是……而是」对照句式',
  '- 错误：「她不是愤怒，而是感到一种深深的悲哀。」',
  '- 正确：「她感到一种深深的悲哀。」',
  '- 这种 not-but 结构是 GPT 系列最明显的特征之一。',
  '',
  '### 2. 避免「不是……更像是／不是，是」句式',
  '- 错误：「那不是愤怒，更像是疲惫。」',
  '- 错误：「不是他不愿意，是他做不到。」',
  '- 正确：直接写「他疲惫不堪。」或「他做不到。」',
  '- 所有「不是X，(而)是Y」变体都要砍掉。直接说 Y。',
].join('\n');

const DE_AI_UPDATED_BLOCK = [
  '### 1. 重点避免「不是……，也不是……，而是……」与「不是……，不是……，是」',
  '- 错误：「她不是害怕，也不是犹豫，而是忽然觉得心里空了一块。」',
  '- 错误：「不是他不想回头，不是他不念旧，是他知道再站下去只会更狼狈。」',
  '- 这两种都是 AI 八股文高频骨架，看起来像在制造层递，实际常常只是在绕远路。',
  '- 更自然：直接改成直叙，「她心里忽然空了一块。」「他知道再站下去只会更狼狈。」',
  '- 后期补偿：如果必须保留三段对照转折，可退一步改成「并非……抑或……而是……」，但这只是补救方案，不应高频使用。',
  '',
  '### 2. 扩展到所有「不是X，(也)不是Y，而是Z / 不是X，不是Y，是Z / 不是X，更像是Y」变体',
  '- 错误：「那不是愤怒，更像是疲惫。」',
  '- 错误：「她不是冷静，而是在硬撑。」',
  '- 只要句子骨架是先连否两个判断、再托出真正判断，就要高度警惕。',
  '- 处理原则：优先删掉整套对照骨架，直接说 Y 或 Z；只有在节奏确实需要时，才考虑用「并非……抑或……而是……」做补偿。',
].join('\n');

const DE_AI_SUPPLEMENT_BLOCK = [
  '### AI 八股补充：警惕「不是……，也不是……，而是……」与「不是……，不是……，是」',
  '- 这两类句式都属于 AI 八股文的高频变体。写作时尽量避免，别靠连否加转折制造文气。',
  '- 后期补偿有两种办法：可以改成「并非……抑或……而是……」；更彻底的做法是删掉整套对照骨架，直接改成直叙。',
].join('\n');

const DE_AI_REACTION_BLOCK = [
  '### 3. 绝对避免「然后她笑了」式独立短反应句，以及后接「那是一个……」解释句',
  '- 错误：「然后她笑了。」',
  '- 错误：「那是一个与之前所有微笑都不同的笑容。」',
  '- 错误组合：先独立成段写一个很短的反应句，再下一句用「那是一个……」「那是一种……」去解释这个反应。',
  '- 这种写法是非常典型的 AI 八股：先空拍一下，再补一句抽象总结，看似有节奏，实际上既断气又空泛。',
  '- 正确：把动作、神态、情绪和前文动作链写在一起，直接写具体变化，不要拆成“短反应句 + 定义句”两段。',
  '- 后审要求：生成后如果出现这种结构，优先删掉独立短句，改为并回上文或直接直叙。',
].join('\n');

function buildSeedContent(seedId, skillSeedMd) {
  if (seedId === 'writing-reference' && skillSeedMd) {
    const sepIdx = skillSeedMd.indexOf('\n\n---\n\n');
    if (sepIdx > 0) return skillSeedMd.slice(0, sepIdx).trim();
    return skillSeedMd;
  }

  if (seedId === 'outline-cleanup') {
    return [
      '# 章节写作：大纲标记物清除',
      '',
      '## 核心原则',
      '',
      '> 大纲是脚手架，建成后要拆除。最终交付的正文不应携带任何大纲标记物。',
      '',
      '## 核心规则',
      '当你将大纲节点转化为章节正文时，必须移除所有大纲标记物。大纲节点的编号和标题是内部规划工具，永远不应出现在最终正文中。',
      '',
      '## 具体做法',
      '',
      '### 禁止的写法',
      '- ## 1. 办公室商议',
      '- ### 暮色的码头',
      '- 任何形式的 "数字 + 小节名称" 标题',
      '- 在正文段落之间插入带编号的分隔标记',
      '',
      '### 正确的写法',
      '- 章节正文是**连续叙事流**，场景切换使用原文既有的分隔符（如 ……）做自然过渡',
      '- 写入正文前，先读取已有章节，观察其排版格式并保持一致',
      '- 每个场景的开场用描写/对话直接切入，不给场景"挂牌"',
      '',
      '### 心理模型',
      '把大纲当作建筑施工时的脚手架——规划阶段用它定位每个场景，但竣工交付前必须拆除。读者看到的不应该有脚手架残留。',
      '',
    ].join('\n');
  }

  if (seedId === 'de-ai-ify') {
    return [
      '# 去 AI 味写作指南',
      '',
      '## 核心原则',
      '避免 AI 生成文本的常见痕迹，让文字读起来像人类作者写的。',
      '',
      '## 句法禁忌',
      '',
      DE_AI_UPDATED_BLOCK,
      '',
      DE_AI_REACTION_BLOCK,
      '',
      '### 4. 避免模糊限定词',
      '- 仿佛、似乎、好像、略显、有些、某种、几乎、大概',
      '- 除非是不确定视角（比如角色自己在猜测），否则直接陈述。',
      '',
      '### 5. 避免定义式开头',
      '- 错误：「沉默是一种无声的语言。」「爱情是人类永恒的主题。」',
      '- 每段首句不要用「X 是/指的是/意味着」这种定义句式。直接从叙事切入。除非是角色自己在说',
      '',
      '### 6. 避免空话套话',
      '- 值得注意的是、毋庸置疑、众所周知、不可否认、从某种意义上说',
      '- 这些词不传递信息，只占字数。直接写事实。',
      '',
      '### 7. 避免过度概括，具体代替抽象',
      '- 错误：「这是一个充满希望的时刻。」',
      '- 正确：「这是四月的一个清晨，樱花正开。」',
      '- 用具体的感官细节（视觉、听觉、嗅觉）代替概括性描述。',
      '',
      '## 风格要求',
      '',
      '### 8. 多用短句',
      '- 长句不超过 30 字。复杂逻辑拆成 2-3 个短句。',
      '- 少用多层从句嵌套。',
      '',
      '### 9. 动作代替心理',
      '- 错误：「他感到非常紧张。」',
      '- 正确：「他手心全是汗，指节捏得发白。」',
      '- 用外部描写暗示内心状态，不要直接贴标签。',
      '',
      '### 10. 多用具体动词，少用「是」',
      '- 错误：「他是愤怒的。」「她是疲惫的。」',
      '- 正确：「他怒吼着。」「她瘫坐在地上。」',
      '- 「是」字过多会让文本感觉平淡无力，换成具体动词可以增强画面感。',
      '',
      '### 11. 避免排比句式过多',
      '- 偶尔使用排比可以增强节奏，但连续 3 段以上排比就是 AI 味。',
      '',
      '### 12. 称呼一致性',
      '- 确定角色称呼（全名/名字/昵称/代称）后保持一致，不要来回切换。',
      '',
      '## 示例对比',
      '',
      '| AI 版 | 人类版 |',
      '|-------|--------|',
      '| 她不置可否地沉默了片刻，仿佛在思考什么重要的事情 | 她没说话。|',
      '| 这座城市不仅有繁华的现代建筑，更有深厚的历史底蕴 | 高楼后面就是老街，青石板路上还有昨天的雨迹。|',
      '| 值得注意的是，这一发现将彻底改变我们对这个问题的理解 | 这个发现意味着我们之前的假设可能全是错的。|',
      '',
    ].join('\n');
  }

  if (seedId === 'character-search') {
    return [
      '# 角色网络搜索策略',
      '',
      '## 文化圈检测',
      '根据作品名判断文化圈：east-asian-cn / east-asian-jp / east-asian-kr / western-en / global。',
      '',
      '## 搜索源优先级',
      '- 中文作品：萌娘百科 > Bing > 百度百科',
      '- 日文作品：Wikipedia(ja) > Pixiv > DuckDuckGo',
      '- 韩文作品：Namu Wiki > DuckDuckGo',
      '- 英文作品：Wikipedia(en) > DuckDuckGo',
      '',
      '## 查询构建',
      '角色名 + 作品名 + 作品原名（如果有）。',
      '',
      '## 回退策略',
      '主要来源无结果 → 相邻文化圈 → 全局 DuckDuckGo。',
      '',
      '## 合并规则',
      '保留小说已有值，网络数据作为参考追加（括号标注原作设定）。',
    ].join('\n');
  }

  return '';
}

function maybeRefreshSeedContent(seedId, currentContent, skillSeedMd) {
  const fallback = buildSeedContent(seedId, skillSeedMd);
  if (!currentContent) return fallback;
  if (seedId !== 'de-ai-ify') return currentContent;
  let nextContent = currentContent;
  if (currentContent.includes(DE_AI_LEGACY_BLOCK)) {
    nextContent = nextContent.replace(DE_AI_LEGACY_BLOCK, DE_AI_UPDATED_BLOCK);
  }
  if (nextContent.includes('# 去 AI 味写作指南') && !nextContent.includes('AI 八股补充')) {
    nextContent = `${nextContent.trim()}\n\n${DE_AI_SUPPLEMENT_BLOCK}\n`;
  }
  if (nextContent.includes('# 去 AI 味写作指南') && !nextContent.includes('绝对避免「然后她笑了」式独立短反应句')) {
    nextContent = `${nextContent.trim()}\n\n${DE_AI_REACTION_BLOCK}\n`;
  }
  return nextContent;
}

/**
 * Ensure default skills exist on first run.
 * Called once during app startup from index.js.
 * @param {string} [skillSeedMd] - The existing skill.md Markdown to migrate as a skill entry.
 */
async function ensureSeeds(skillSeedMd) {
  const idx = await _loadIndex();
  let indexChanged = false;
  const seeds = [
    {
      id: 'writing-reference',
      name: '写作参考手册',
      description: 'Multi-Agent Novel Assistant 产品概述、内置 Agent/DAG 列表、成本质量权衡建议。',
      tags: ['reference', 'config'],
      assignedSubagentIds: ['sa-config-helper', 'sa-chat', 'sa-outline-drafter'],
      schemaVersion: SCHEMA_VERSION,
    },
    {
      id: 'outline-cleanup',
      name: '章节写作：大纲标记物清除',
      description: '从大纲节点生成章节正文时，必须移除大纲编号/标题标记物，保留连续叙事流。',
      tags: ['writing', 'outline', 'format'],
      assignedSubagentIds: ['sa-writer', 'sa-chat'],
      schemaVersion: SCHEMA_VERSION,
    },
    {
      id: 'character-search',
      name: '角色网络搜索策略',
      description: '同人角色联网搜索的文化圈路由、查询格式、回退策略与合并规则。',
      tags: ['search', 'character'],
      assignedSubagentIds: ['sa-import-orchestrator', 'sa-chat'],
      schemaVersion: SCHEMA_VERSION,
    },
    {
      id: 'de-ai-ify',
      name: '去 AI 味写作指南',
      description: '避免 AI 生成文本常见痕迹的写作规则，保持人类风格。',
      tags: ['writing', 'style'],
      assignedSubagentIds: ['sa-chat', 'sa-writer'],
      schemaVersion: SCHEMA_VERSION,
    },
  ];

  for (const seed of seeds) {
    // Ensure skills dir
    const dir = paths().skills;
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}

    const existingIndex = (idx.skills || []).findIndex((s) => s.id === seed.id);
    if (existingIndex < 0) {
      idx.skills.push({
        id: seed.id,
        name: seed.name,
        description: seed.description,
        tags: seed.tags,
        assignedSubagentIds: seed.assignedSubagentIds,
        schemaVersion: SCHEMA_VERSION,
      });
      indexChanged = true;
    }

    const mdPath = skillContentPath(seed.id);
    let currentContent = '';
    try { currentContent = fs.readFileSync(mdPath, 'utf8'); } catch {}
    const nextContent = existingIndex < 0
      ? buildSeedContent(seed.id, skillSeedMd)
      : maybeRefreshSeedContent(seed.id, currentContent, skillSeedMd);
    if (nextContent !== currentContent) {
      try { fs.writeFileSync(mdPath, nextContent, 'utf8'); } catch {}
    }
  }

  if (indexChanged) {
    await _saveIndex(idx);
  }
}

/**
 * List all skills (metadata only, no content).
 * @returns {Promise<Array>}
 */
async function listSkills() {
  const idx = await _loadIndex();
  return idx.skills || [];
}

/**
 * Get a single skill's full data (metadata + content).
 * @param {string} id
 * @returns {Promise<object|null>}
 */
async function getSkill(id) {
  const idx = await _loadIndex();
  const entry = (idx.skills || []).find((s) => s.id === id);
  if (!entry) return null;

  let content = '';
  try {
    content = await fsp.readFile(skillContentPath(id), 'utf8');
  } catch {}
  return { ...entry, content };
}

/**
 * Save a skill (create or update).
 * @param {object} spec - SkillSpec with at least id, name, content
 */
async function saveSkill(spec) {
  if (!spec || !spec.id || !spec.name) throw new Error('skill id and name required');
  const idx = await _loadIndex();
  const existing = (idx.skills || []).findIndex((s) => s.id === spec.id);

  const meta = {
    id: spec.id,
    name: spec.name,
    description: spec.description || '',
    tags: Array.isArray(spec.tags) ? spec.tags : [],
    assignedSubagentIds: Array.isArray(spec.assignedSubagentIds) ? spec.assignedSubagentIds : [],
    schemaVersion: SCHEMA_VERSION,
  };

  if (existing >= 0) {
    idx.skills[existing] = meta;
  } else {
    idx.skills.push(meta);
  }
  await _saveIndex(idx);

  // Write content to .md file
  const mdPath = skillContentPath(spec.id);
  const dir = path.dirname(mdPath);
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  await fsp.writeFile(mdPath, spec.content || '', 'utf8');

  return { ...meta, content: spec.content || '' };
}

/**
 * Delete a skill.
 * @param {string} id
 */
async function deleteSkill(id) {
  const idx = await _loadIndex();
  idx.skills = (idx.skills || []).filter((s) => s.id !== id);
  await _saveIndex(idx);

  // Remove content file
  try {
    await fsp.unlink(skillContentPath(id));
  } catch {}
}

/**
 * Assign a skill to a subagent.
 * @param {string} skillId
 * @param {string} subagentId
 */
async function assignSkillToSubagent(skillId, subagentId) {
  const idx = await _loadIndex();
  const entry = (idx.skills || []).find((s) => s.id === skillId);
  if (!entry) throw new Error(`skill not found: ${skillId}`);
  const set = new Set(entry.assignedSubagentIds || []);
  set.add(subagentId);
  entry.assignedSubagentIds = [...set];
  await _saveIndex(idx);
}

/**
 * Unassign a skill from a subagent.
 * @param {string} skillId
 * @param {string} subagentId
 */
async function unassignSkillFromSubagent(skillId, subagentId) {
  const idx = await _loadIndex();
  const entry = (idx.skills || []).find((s) => s.id === skillId);
  if (!entry) throw new Error(`skill not found: ${skillId}`);
  entry.assignedSubagentIds = (entry.assignedSubagentIds || []).filter((id) => id !== subagentId);
  await _saveIndex(idx);
}

/**
 * Export a skill as a portable JSON+Markdown bundle.
 * @param {string} skillId
 * @returns {Promise<object>}
 */
async function exportSkill(skillId) {
  const skill = await getSkill(skillId);
  if (!skill) throw new Error(`skill not found: ${skillId}`);
  return {
    schemaVersion: SCHEMA_VERSION,
    type: 'mana-skill',
    id: skill.id,
    name: skill.name,
    description: skill.description,
    tags: skill.tags,
    content: skill.content,
  };
}

/**
 * Import a skill from a portable bundle.
 * @param {object} bundle - The export bundle
 */
async function importSkill(bundle) {
  if (!bundle || bundle.type !== 'mana-skill') throw new Error('Invalid skill bundle');
  return saveSkill({
    id: bundle.id,
    name: bundle.name || bundle.id,
    description: bundle.description || '',
    tags: Array.isArray(bundle.tags) ? bundle.tags : [],
    content: bundle.content || '',
    assignedSubagentIds: [],
  });
}

module.exports = {
  SCHEMA_VERSION,
  ensureSeeds,
  listSkills,
  getSkill,
  saveSkill,
  deleteSkill,
  assignSkillToSubagent,
  unassignSkillFromSubagent,
  exportSkill,
  importSkill,
};
