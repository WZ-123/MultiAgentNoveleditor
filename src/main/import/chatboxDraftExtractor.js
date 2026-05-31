'use strict';

const JSON5 = require('json5');
const providerManager = require('../providerManager');
const modelAliases = require('../modelAliases');

const SINGLE_PASS_CHAR_LIMIT = 60000;
const BATCH_CHAR_LIMIT = 45000;
const DEFAULT_BATCH_CONCURRENCY = 3;

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
  if (!provider) throw new Error('导入 Chatbox HTML 需要配置 AI 服务商。请先在设置中配置 API Key 和模型。');
  const apiKey = provider.apiKey || '';
  if (!apiKey) throw new Error('导入 Chatbox HTML 需要可用的 AI API Key。请先在设置中配置。');
  const modelId = alias?.modelId || provider.models?.[0]?.id || '';
  if (!modelId) throw new Error('导入 Chatbox HTML 需要配置 AI 模型。请先在设置中配置模型。');
  const type = providerManager.inferProviderType(provider);
  return {
    provider: pickProvider(type),
    tier: { type, model: modelId, apiKey, baseUrl: provider.baseUrl || '', extra: { maxTokens: 32768, streaming: false } },
  };
}

function parseJsonFromText(text) {
  const raw = String(text || '').trim();
  if (!raw) throw new Error('AI 未返回整理结果');

  const candidates = _buildJsonCandidates(raw);
  const errors = [];
  for (const candidate of candidates) {
    const parsed = _tryParseJsonCandidate(candidate, errors);
    if (parsed.ok) return parsed.value;
  }
  const detail = errors.find(Boolean) || '无法定位 JSON 对象';
  throw new Error(`AI 返回的 Chatbox 整理结果不是有效 JSON: ${detail}`);
}

function _buildJsonCandidates(raw) {
  const candidates = [];
  const add = (value) => {
    const text = String(value || '').trim();
    if (text && !candidates.includes(text)) candidates.push(text);
  };

  add(raw);
  const fenceRe = /```(?:json|json5)?\s*([\s\S]*?)```/gi;
  let fence;
  while ((fence = fenceRe.exec(raw))) add(fence[1]);
  const strippedFence = _stripDanglingCodeFence(raw);
  add(strippedFence);
  add(_extractBalancedObject(raw));
  add(_extractBalancedObject(strippedFence));

  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first >= 0 && last > first) add(raw.slice(first, last + 1));
  const strippedFirst = strippedFence.indexOf('{');
  const strippedLast = strippedFence.lastIndexOf('}');
  if (strippedFirst >= 0 && strippedLast > strippedFirst) add(strippedFence.slice(strippedFirst, strippedLast + 1));
  return candidates;
}

function _stripDanglingCodeFence(text) {
  return String(text || '')
    .trim()
    .replace(/^```(?:json|json5)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();
}

function _extractBalancedObject(text) {
  const source = String(text || '');
  let start = -1;
  let depth = 0;
  let quote = '';
  let escape = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (escape) {
        escape = false;
      } else if (ch === '\\') {
        escape = true;
      } else if (ch === quote) {
        quote = '';
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}' && depth > 0) {
      depth--;
      if (depth === 0 && start >= 0) return source.slice(start, i + 1);
    }
  }
  return '';
}

function _tryParseJsonCandidate(candidate, errors = []) {
  const attempts = [
    candidate,
    _repairJsonCandidate(candidate),
  ].filter(Boolean);
  for (const attempt of [...new Set(attempts)]) {
    try {
      return { ok: true, value: JSON.parse(attempt) };
    } catch (err) {
      errors.push(err.message);
    }
    try {
      return { ok: true, value: JSON5.parse(attempt) };
    } catch (err) {
      errors.push(err.message);
    }
  }
  return { ok: false };
}

function _repairJsonCandidate(candidate) {
  return _escapeBareControlCharsInStrings(String(candidate || '')
    .replace(/^\uFEFF/, '')
    .replace(/,\s*([}\]])/g, '$1'));
}

function _escapeBareControlCharsInStrings(text) {
  let out = '';
  let quote = '';
  let escape = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (!quote) {
      out += ch;
      if (ch === '"' || ch === "'") quote = ch;
      continue;
    }

    if (escape) {
      out += ch;
      escape = false;
      continue;
    }
    if (ch === '\\') {
      out += ch;
      escape = true;
      continue;
    }
    if (ch === quote) {
      out += ch;
      quote = '';
      continue;
    }
    if (ch === '\n') {
      out += '\\n';
      continue;
    }
    if (ch === '\r') {
      out += '\\n';
      if (text[i + 1] === '\n') i++;
      continue;
    }
    if (ch === '\t') {
      out += '\\t';
      continue;
    }
    const code = ch.charCodeAt(0);
    if (code >= 0 && code < 32) {
      out += `\\u${code.toString(16).padStart(4, '0')}`;
      continue;
    }
    out += ch;
  }
  return out;
}

function normalizeChapter(raw, index) {
  const title = String(raw?.title || '').trim() || (index === 0 ? '从 Chatbox 整理的正文' : `章节 ${index + 1}`);
  const content = String(raw?.content || '').trim();
  if (!content) return null;
  return { title, content, confident: true };
}

function splitChapterByHeadings(chapter) {
  const content = String(chapter?.content || '').trim();
  if (!content) return [];
  const lines = content.split('\n');
  const headingIndexes = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (/^#{1,3}\s+.+/.test(line) || /^(?:第[一二三四五六七八九十百千万零\d]+[章节话]|Chapter\s+\d+)\b/i.test(line)) {
      headingIndexes.push(i);
    }
  }
  if (headingIndexes.length <= 1) return [chapter];
  const chapters = [];
  for (let i = 0; i < headingIndexes.length; i++) {
    const start = headingIndexes[i];
    const end = headingIndexes[i + 1] ?? lines.length;
    const rawTitle = lines[start].replace(/^#{1,3}\s+/, '').trim();
    const body = lines.slice(start + 1, end).join('\n').trim();
    if (body) chapters.push({ title: rawTitle || chapter.title, content: body, confident: true });
  }
  return chapters.length > 0 ? chapters : [chapter];
}

function normalizeExtraction(parsed, fallbackTitle) {
  let chapters = Array.isArray(parsed?.chapters)
    ? parsed.chapters.map(normalizeChapter).filter(Boolean)
    : [];
  if (chapters.length === 0) {
    const content = String(parsed?.content || parsed?.text || '').trim();
    if (content) chapters.push({ title: '从 Chatbox 整理的正文', content, confident: true });
  }
  chapters = chapters.flatMap((chapter) => splitChapterByHeadings(chapter));
  if (chapters.length === 0) throw new Error('AI 没有从 Chatbox 对话中整理出可导入正文');

  return {
    title: String(parsed?.title || fallbackTitle || 'Chatbox 导入作品').trim(),
    chapters,
    notes: String(parsed?.notes || '').trim(),
  };
}

function formatMessages(messages) {
  return (messages || []).map((msg, index) => {
    const role = String(msg.role || '').toUpperCase();
    return `【${index + 1}. ${role}】\n${msg.content}`;
  }).join('\n\n');
}

function buildPrompt(transcript) {
  const title = transcript.title || transcript.sessionTitles?.[0] || 'Chatbox 导入作品';
  const messages = formatMessages(transcript.messages || []);

  return `你要从 Chatbox 导出的创作对话中整理出用户最终采用的小说正文，用于导入小说项目。

请严格输出 JSON，不要 Markdown 代码围栏，不要解释。格式：
{
  "title": "作品标题",
  "chapters": [
    { "title": "章节标题", "content": "章节正文，Markdown 纯文本" }
  ],
  "notes": "很短的整理说明，可为空"
}

JSON 输出硬性规则：
- content 内的段落换行必须写成 \\n，禁止在 JSON 字符串内部直接换行。
- 禁止尾随逗号，禁止注释，禁止输出 JSON 外的解释文字。

整理规则：
1. 用户的人设、世界观、大纲、修改意见是约束材料，不要直接当作正文。
2. assistant 的长篇创作回复是正文候选；去掉“好的”“我们继续”“请继续提供”等客套和元说明。
3. 如果用户后续指出“换掉”“不要”“改成”“这里不对”“重写”“本来就”等修订意见，后续 assistant 的修正版覆盖同一情节旧版。
4. 多段“继续”按情节顺序拼接；同一章不要重复保留旧版与新版。
5. 保留正文中的对话、颜文字、代码/串口文本等故事内容。
6. 如果无法稳定拆分章节，输出单章，标题用“从 Chatbox 整理的正文”。

候选标题：${title}

以下是完整对话：

${messages}`;
}

function buildBatchPrompt({ transcript, batch, batchIndex, batchCount }) {
  const title = transcript.title || transcript.sessionTitles?.[0] || 'Chatbox 导入作品';
  const sectionTitle = batch.title || `片段 ${batchIndex + 1}`;
  const messages = formatMessages(batch.messages || []);

  return `你要从一份较长的 Chatbox 创作对话中整理最终采用的小说正文。当前只提供第 ${batchIndex + 1}/${batchCount} 个连续片段。

请严格输出 JSON，不要 Markdown 代码围栏，不要解释。格式：
{
  "title": "作品标题",
  "chapters": [
    { "title": "章节标题", "content": "本片段中最终采用的章节正文，Markdown 纯文本" }
  ],
  "notes": "很短的整理说明，可为空"
}

JSON 输出硬性规则：
- content 内的段落换行必须写成 \\n，禁止在 JSON 字符串内部直接换行。
- 禁止尾随逗号，禁止注释，禁止输出 JSON 外的解释文字。

整理规则：
1. 只整理当前片段中已经生成的最终小说正文；用户的人设、大纲、修改意见只是约束材料，不要直接当作正文。
2. 如果当前片段只有设定讨论、大纲讨论、修改要求、确认回复，没有可导入正文，输出 "chapters": []。
3. assistant 的长篇创作回复是正文候选；去掉“好的”“我们继续”“请继续提供”等客套和元说明。
4. 如果用户后续指出“换掉”“不要”“改成”“这里不对”“重写”“本来就”等修订意见，后续 assistant 的修正版覆盖同一情节旧版。
5. 不要复述旧版与新版；同一情节只保留最终采用版。
6. 保留正文中的对话、颜文字、代码/串口文本等故事内容。
7. 如果当前片段自然属于某章，请使用该章标题；无法判断时用当前片段标题。

作品候选标题：${title}
当前片段标题：${sectionTitle}

当前片段对话：

${messages}`;
}

function transcriptTextLength(transcript) {
  return (transcript.messages || []).reduce((total, msg) => total + String(msg.content || '').length, 0);
}

function splitTranscriptIntoBatches(transcript) {
  const sections = Array.isArray(transcript.sections) && transcript.sections.length > 0
    ? transcript.sections
    : [{ title: '', messages: transcript.messages || [] }];
  const batches = [];

  for (const section of sections) {
    const messages = section.messages || [];
    let current = { title: section.title || '', messages: [], charCount: 0 };
    for (const message of messages) {
      const messageSize = String(message.content || '').length + 80;
      if (current.messages.length > 0 && current.charCount + messageSize > BATCH_CHAR_LIMIT) {
        batches.push(current);
        current = { title: section.title || '', messages: [], charCount: 0 };
      }
      current.messages.push(message);
      current.charCount += messageSize;
    }
    if (current.messages.length > 0) batches.push(current);
  }

  return batches.filter((batch) => batch.messages.some((msg) => msg.role === 'assistant'));
}

function _getBatchConcurrency() {
  const raw = Number(process.env.MANA_CHATBOX_IMPORT_CONCURRENCY || DEFAULT_BATCH_CONCURRENCY);
  if (!Number.isFinite(raw)) return DEFAULT_BATCH_CONCURRENCY;
  return Math.max(1, Math.min(4, Math.floor(raw)));
}

async function _runWithConcurrency(tasks, limit) {
  const results = new Array(tasks.length);
  let next = 0;
  const workerCount = Math.min(Math.max(1, limit), tasks.length || 1);
  async function worker() {
    while (next < tasks.length) {
      const index = next++;
      results[index] = await tasks[index]();
    }
  }
  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}

function isGenericChatboxTitle(title) {
  return /^(?:从\s*Chatbox\s*整理的正文|章节\s*\d+|片段\s*\d+|全文)$/i.test(String(title || '').trim());
}

function applyBatchFallbackTitle(extraction, fallbackTitle) {
  const title = String(fallbackTitle || '').trim();
  if (!title || !Array.isArray(extraction?.chapters)) return extraction;
  if (extraction.chapters.length === 1 && isGenericChatboxTitle(extraction.chapters[0].title)) {
    extraction.chapters[0].title = title;
  }
  return extraction;
}

function _formatBatchLabel({ batchIndex, batchCount, batchTitle, fallbackTitle } = {}) {
  const title = batchTitle || fallbackTitle || '全文';
  if (Number.isInteger(batchIndex) && Number.isInteger(batchCount)) {
    return `第 ${batchIndex + 1}/${batchCount} 段「${title}」`;
  }
  return `全文「${title}」`;
}

function _previewText(text, maxChars = 500) {
  return String(text || '').replace(/\s+/g, ' ').slice(0, maxChars);
}

function _previewError(err, maxChars = 180) {
  return _previewText(err?.message || String(err || ''), maxChars);
}

async function _repairJsonWithProvider(provider, tier, rawOutput, label) {
  const prompt = `下面是一段 AI 输出的 Chatbox 小说整理结果，但它不是合法 JSON。请只修复 JSON 语法，不要改写正文内容，不要补充新内容，不要解释。

目标 JSON 格式：
{
  "title": "作品标题",
  "chapters": [
    { "title": "章节标题", "content": "章节正文，Markdown 纯文本，换行必须用 \\n 转义" }
  ],
  "notes": "很短的整理说明，可为空"
}

批次：${label}

原始输出：
${String(rawOutput || '').slice(0, 12000)}`;

  const result = await provider.sendMessage({
    system: '',
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    tools: [],
    tier,
  });
  const textBlock = (result.content || []).find((block) => block.type === 'text');
  return parseJsonFromText(textBlock?.text || '');
}

async function runExtractionPrompt(provider, tier, prompt, fallbackTitle, { allowEmpty = false, batchIndex = null, batchCount = null, batchTitle = '' } = {}) {
  const result = await provider.sendMessage({
    system: '',
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    tools: [],
    tier,
  });
  const textBlock = (result.content || []).find((block) => block.type === 'text');
  const rawOutput = textBlock?.text || '';
  const label = _formatBatchLabel({ batchIndex, batchCount, batchTitle, fallbackTitle });
  let parsed;
  try {
    parsed = parseJsonFromText(rawOutput);
  } catch (firstErr) {
    try {
      parsed = await _repairJsonWithProvider(provider, tier, rawOutput, label);
    } catch (repairErr) {
      console.error(
        '[chatboxDraftExtractor]',
        `Chatbox 整理 JSON 解析失败（${label}）：${_previewError(firstErr)}；修复重试失败：${_previewError(repairErr)}。原始输出片段：${_previewText(rawOutput)}`
      );
      throw new Error(`Chatbox 整理 JSON 解析失败（${label}）：AI 输出不是有效 JSON，修复重试也失败。详见主进程日志。`);
    }
  }
  if (allowEmpty && Array.isArray(parsed?.chapters) && parsed.chapters.length === 0) {
    return {
      title: String(parsed?.title || fallbackTitle || 'Chatbox 导入作品').trim(),
      chapters: [],
      notes: String(parsed?.notes || '').trim(),
    };
  }
  try {
    return applyBatchFallbackTitle(normalizeExtraction(parsed, fallbackTitle), fallbackTitle);
  } catch (err) {
    if (allowEmpty && /没有从 Chatbox 对话中整理出可导入正文/.test(err.message || '')) {
      console.error(`[chatboxDraftExtractor] batch empty: ${label}`);
      return {
        title: String(parsed?.title || fallbackTitle || 'Chatbox 导入作品').trim(),
        chapters: [],
        notes: String(parsed?.notes || '').trim(),
      };
    }
    throw err;
  }
}

async function extractFinalDraftFromChatbox(transcript) {
  const { provider, tier } = await resolveProvider();
  const fallbackTitle = transcript.title || transcript.sessionTitles?.[0] || 'Chatbox 导入作品';
  const sectionCount = (transcript.sections || []).filter((section) =>
    (section.messages || []).some((message) => message.role === 'assistant')
  ).length;
  if (sectionCount <= 1 && transcriptTextLength(transcript) <= SINGLE_PASS_CHAR_LIMIT) {
    return runExtractionPrompt(provider, tier, buildPrompt(transcript), fallbackTitle, { batchTitle: fallbackTitle });
  }

  const batches = splitTranscriptIntoBatches(transcript);
  const concurrency = _getBatchConcurrency();
  console.error(`[chatboxDraftExtractor] extracting ${batches.length} Chatbox batches with concurrency=${concurrency}`);
  let title = fallbackTitle;
  const tasks = batches.map((batch, i) => async () => {
    const batchTitle = batch.title || fallbackTitle;
    console.error(`[chatboxDraftExtractor] batch ${i + 1}/${batches.length} start: ${batchTitle} (${batch.charCount || 0} chars)`);
    const extracted = await runExtractionPrompt(
      provider,
      tier,
      buildBatchPrompt({ transcript, batch, batchIndex: i, batchCount: batches.length }),
      batchTitle,
      { allowEmpty: true, batchIndex: i, batchCount: batches.length, batchTitle }
    );
    console.error(`[chatboxDraftExtractor] batch ${i + 1}/${batches.length} done: ${batchTitle} (${extracted.chapters.length} chapters)`);
    return { index: i, extracted };
  });

  const batchResults = await _runWithConcurrency(tasks, concurrency);
  const chapters = [];
  const notes = [];
  for (const { extracted } of batchResults.sort((a, b) => a.index - b.index)) {
    if (extracted.title && (!title || title === fallbackTitle)) title = extracted.title;
    chapters.push(...extracted.chapters);
    if (extracted.notes) notes.push(extracted.notes);
  }
  if (chapters.length === 0) throw new Error('AI 没有从 Chatbox 对话中整理出可导入正文');
  return {
    title: title || fallbackTitle,
    chapters,
    notes: notes.join('\n'),
  };
}

module.exports = {
  buildPrompt,
  buildBatchPrompt,
  extractFinalDraftFromChatbox,
  normalizeExtraction,
  parseJsonFromText,
  splitTranscriptIntoBatches,
  _internal: {
    _buildJsonCandidates,
    _extractBalancedObject,
    _stripDanglingCodeFence,
    _repairJsonCandidate,
    _escapeBareControlCharsInStrings,
    _getBatchConcurrency,
    _runWithConcurrency,
  },
};
