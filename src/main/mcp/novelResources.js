'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const novelData = require('../store/novelData');
const { novelPaths } = require('../store/paths');
const { parseFrontmatter } = require('../store/frontmatter');
const { assertChapterName } = require('../store/resourceIdentity');
const { hash, contractError } = require('../codex-runtime/contracts');

const RESOURCE_KINDS = Object.freeze([
  'novel', 'chapter', 'chapter-summary', 'character', 'character-memory',
  'world', 'outline', 'timeline', 'asset', 'style',
]);

function stableJson(value) {
  return JSON.stringify(value == null ? null : value, null, 2);
}

function safeId(value, label = 'resource id') {
  const id = String(value || '');
  if (!id || id.includes('..') || /[\\/\0]/u.test(id)) throw contractError(`${label} is invalid`, 'tool_scope_denied');
  return id;
}

function chapterName(value) {
  try { return assertChapterName(safeId(value, 'chapter name')); }
  catch { throw contractError('chapter resourceRef is invalid', 'tool_scope_denied'); }
}

function parseResourceRef(resourceRef) {
  const ref = String(resourceRef || '');
  if (ref === 'novel:meta') return { kind: 'novel', key: 'meta' };
  if (ref === 'world:lore' || ref === 'world:places') return { kind: 'world', key: ref.slice(6) };
  if (ref === 'outline:nodes' || ref === 'outline:hierarchy' || ref === 'outline:master') return { kind: 'outline', key: ref.slice(8) };
  const outlineChapter = ref.match(/^outline:chapter:(\d+):(\d+):(\d+)$/u);
  if (outlineChapter) return { kind: 'outline', key: 'chapter', volumeIndex: Number(outlineChapter[1]), sectionIndex: Number(outlineChapter[2]), chapterIndex: Number(outlineChapter[3]) };
  if (ref === 'timeline:all') return { kind: 'timeline', key: 'all' };
  if (ref === 'style:memory') return { kind: 'style', key: 'memory' };
  const prefixes = [
    ['chapter-summary:', 'chapter-summary'], ['character-memory:', 'character-memory'],
    ['chapter:', 'chapter'], ['character:', 'character'], ['timeline:event:', 'timeline-event'], ['asset:', 'asset'],
  ];
  for (const [prefix, kind] of prefixes) {
    if (!ref.startsWith(prefix)) continue;
    const key = safeId(ref.slice(prefix.length));
    return { kind, key: kind.startsWith('chapter') ? chapterName(key) : key };
  }
  throw contractError('novel resourceRef is invalid', 'tool_scope_denied');
}

function normalizeSearchText(value) {
  return String(value || '').normalize('NFKC').toLocaleLowerCase('zh-CN')
    .replace(/[，、]/gu, ',')
    .replace(/[。]/gu, '.')
    .replace(/[：]/gu, ':')
    .replace(/[；]/gu, ';')
    .replace(/[！]/gu, '!')
    .replace(/[？]/gu, '?')
    .replace(/[“”]/gu, '"')
    .replace(/[‘’]/gu, "'")
    .replace(/\s+/gu, ' ')
    .trim();
}

function normalizeSearchQuery(value) {
  let query = normalizeSearchText(value);
  const wrappers = [['"', '"'], ["'", "'"], ['「', '」'], ['『', '』'], ['《', '》'], ['【', '】']];
  for (let pass = 0; pass < 2; pass += 1) {
    const pair = wrappers.find(([open, close]) => query.startsWith(open) && query.endsWith(close) && query.length > open.length + close.length);
    if (!pair) break;
    query = query.slice(pair[0].length, -pair[1].length).trim();
  }
  return query;
}

function chineseCharacterCount(value) {
  return (String(value || '').match(/[\u3400-\u9fff]/gu) || []).length;
}

function proseRepetitionEvidence(values) {
  const sources = (Array.isArray(values) ? values : [values]).map((value, sourceIndex) => ({
    resourceRef: value && typeof value === 'object' ? String(value.resourceRef || `source:${sourceIndex + 1}`) : `source:${sourceIndex + 1}`,
    hash: value && typeof value === 'object' ? String(value.hash || value.sourceHash || '') : '',
    content: String(value && typeof value === 'object' ? value.content || '' : value || ''),
  }));
  const sentences = [];
  for (const source of sources) {
    const lines = source.content.split(/\r?\n/u);
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      if (/^\s*#/u.test(lines[lineIndex])) continue;
      const parts = lines[lineIndex].split(/[。！？!?；;]+/u).map((item) => item.trim()).filter((item) => chineseCharacterCount(item) >= 6);
      for (const sentence of parts) sentences.push({ sentence, resourceRef: source.resourceRef, hash: source.hash || null, line: lineIndex + 1 });
    }
  }
  const frequencies = new Map();
  for (const item of sentences) {
    const entry = frequencies.get(item.sentence) || { count: 0, occurrences: [] };
    entry.count += 1;
    entry.occurrences.push({ resourceRef: item.resourceRef, hash: item.hash, line: item.line });
    frequencies.set(item.sentence, entry);
  }
  const repeatedEntries = [...frequencies.entries()].filter(([, entry]) => entry.count > 1).sort((left, right) => right[1].count - left[1].count);
  const repeatedOccurrences = repeatedEntries.reduce((sum, [, entry]) => sum + entry.count, 0);
  return {
    methodology: '正文按中文句末标点和换行分句；忽略 Markdown 标题及少于 6 个汉字的片段；比对完全相同的句子。',
    sentenceCount: sentences.length,
    uniqueSentenceCount: frequencies.size,
    repeatedOccurrences,
    repeatedOccurrenceRatio: sentences.length ? repeatedOccurrences / sentences.length : 0,
    topRepeated: repeatedEntries.slice(0, 10).map(([sentence, entry]) => ({ sentence, count: entry.count, occurrences: entry.occurrences })),
  };
}

function bodyChineseCharacterCount(value) {
  const body = String(value || '').split('\n').filter((line) => {
    const trimmed = line.trim();
    if (!trimmed || /^#{1,6}\s/u.test(trimmed)) return false;
    if (/^(?:时间|日期|天气|雨情|水情)\s*[：:]/u.test(trimmed)) return false;
    return true;
  }).join('\n');
  return chineseCharacterCount(body);
}

function page(items, cursor, requestedLimit) {
  const offset = Math.max(0, Number.parseInt(String(cursor || '0'), 10) || 0);
  const limit = Math.min(200, Math.max(1, Number(requestedLimit) || 100));
  const data = items.slice(offset, offset + limit);
  const next = offset + data.length;
  return { data, total: items.length, cursor: next < items.length ? String(next) : null, hasMore: next < items.length };
}

async function listResourceDescriptors(entry) {
  const [chapters, characters, assets, timeline, summaryFiles, outlineHierarchy] = await Promise.all([
    novelData.listChapters(entry.dir), novelData.listCharacters(entry.dir), novelData.listAssets(entry.dir), novelData.listTimeline(entry.dir),
    fsp.readdir(path.join(entry.dir, 'summaries')).catch((error) => error?.code === 'ENOENT' ? [] : Promise.reject(error)),
    novelData.listOutlineHierarchy(entry.dir),
  ]);
  const existingSummaryFiles = new Set(summaryFiles);
  const descriptors = [
    { resourceRef: 'novel:meta', kind: 'novel', title: entry.title || entry.name || entry.id },
    { resourceRef: 'world:lore', kind: 'world', title: '世界观设定' },
    { resourceRef: 'world:places', kind: 'world', title: '地点设定' },
    { resourceRef: 'outline:nodes', kind: 'outline', title: '大纲节点' },
    { resourceRef: 'outline:hierarchy', kind: 'outline', title: '分层大纲' },
    { resourceRef: 'outline:master', kind: 'outline', title: '总纲' },
    { resourceRef: 'timeline:all', kind: 'timeline', title: '完整时间线' },
    { resourceRef: 'style:memory', kind: 'style', title: '文风记忆' },
  ];
  for (const item of chapters) {
    descriptors.push({ resourceRef: `chapter:${item.name}`, kind: 'chapter', title: item.title || item.name });
    if (existingSummaryFiles.has(`${item.name}.md`)) {
      descriptors.push({ resourceRef: `chapter-summary:${item.name}`, kind: 'chapter-summary', title: `${item.title || item.name} 摘要` });
    }
  }
  for (const item of characters) {
    const id = safeId(item.id || item.name, 'character id');
    descriptors.push({ resourceRef: `character:${id}`, kind: 'character', title: item.name || id });
    descriptors.push({ resourceRef: `character-memory:${id}`, kind: 'character-memory', title: `${item.name || id} 记忆` });
  }
  for (const item of assets) {
    const id = safeId(item.id, 'asset id');
    descriptors.push({ resourceRef: `asset:${id}`, kind: 'asset', title: item.name || id });
  }
  for (const item of timeline) {
    if (!item?.id) continue;
    const id = safeId(item.id, 'timeline id');
    descriptors.push({ resourceRef: `timeline:event:${id}`, kind: 'timeline', title: item.title || item.summary || id });
  }
  for (const item of outlineHierarchy.chapters || []) descriptors.push({ resourceRef: `outline:chapter:${item.volIdx}:${item.secIdx}:${item.chIdx}`, kind: 'outline', title: `第${item.chIdx}章详纲` });
  return descriptors.sort((left, right) => left.resourceRef.localeCompare(right.resourceRef, 'zh-CN'));
}

async function readResource(entry, resourceRef) {
  const parsed = parseResourceRef(resourceRef);
  let value;
  if (parsed.kind === 'novel') {
    try { value = JSON.parse(await fsp.readFile(path.join(entry.dir, 'novel.json'), 'utf8')); }
    catch { value = { id: entry.id, title: entry.title || entry.name || '' }; }
  } else if (parsed.kind === 'chapter') {
    // The editor treats a missing file as an empty draft. Resource and
    // transaction reads must distinguish absence from an existing empty file.
    const raw = await fsp.readFile(path.join(novelPaths(entry.dir).chapters, parsed.key), 'utf8');
    const { metadata, body } = parseFrontmatter(raw);
    value = metadata ? body : raw;
  }
  else if (parsed.kind === 'chapter-summary') value = await novelData.readSummary(entry.dir, parsed.key);
  else if (parsed.kind === 'character') value = await novelData.readCharacter(entry.dir, parsed.key);
  else if (parsed.kind === 'character-memory') value = await novelData.readCharacterMemory(entry.dir, parsed.key);
  else if (parsed.kind === 'asset') value = await novelData.readAsset(entry.dir, parsed.key);
  else if (parsed.kind === 'timeline') value = await novelData.listTimeline(entry.dir);
  else if (parsed.kind === 'timeline-event') value = (await novelData.listTimeline(entry.dir)).find((item) => String(item.id) === parsed.key) || null;
  else if (parsed.kind === 'style') value = await novelData.readStyleMemory(entry.dir);
  else if (parsed.kind === 'outline' && parsed.key === 'nodes') value = await novelData.readOutlineNodes(entry.dir);
  else if (parsed.kind === 'outline' && parsed.key === 'hierarchy') value = await novelData.listOutlineHierarchy(entry.dir);
  else if (parsed.kind === 'outline' && parsed.key === 'master') value = await novelData.readOutlineMaster(entry.dir);
  else if (parsed.kind === 'outline' && parsed.key === 'chapter') value = await novelData.readOutlineChapter(entry.dir, parsed.volumeIndex, parsed.sectionIndex, parsed.chapterIndex);
  else if (parsed.kind === 'world') {
    const world = await novelData.readWorld(entry.dir);
    value = parsed.key === 'lore' ? world?.lore || '' : world?.places || [];
  }
  if (value == null) throw contractError(`novel resource does not exist: ${resourceRef}`, 'context_incomplete');
  const content = typeof value === 'string' ? value : stableJson(value);
  return {
    novelId: String(entry.id),
    resourceRef: String(resourceRef),
    kind: parsed.kind === 'timeline-event' ? 'timeline' : parsed.kind,
    sourceHash: hash(content),
    bytes: Buffer.byteLength(content, 'utf8'),
    content,
  };
}

async function listResources(entry, options = {}) {
  const kinds = new Set((options.kinds || []).map(String));
  const allowed = new Set((options.allowedResourceRefs || []).map(String));
  const all = await listResourceDescriptors(entry);
  const scoped = allowed.size ? all.filter((item) => allowed.has(item.resourceRef)) : all;
  const filtered = kinds.size ? scoped.filter((item) => kinds.has(item.kind)) : scoped;
  return page(filtered, options.cursor, options.limit);
}

async function searchResources(entry, options = {}) {
  const query = normalizeSearchQuery(options.query);
  if (!query) throw contractError('search query is required', 'tool_scope_denied');
  const kinds = new Set((options.kinds || []).map(String));
  const allowed = new Set((options.allowedResourceRefs || []).map(String));
  const descriptors = (await listResourceDescriptors(entry)).filter((item) => (!allowed.size || allowed.has(item.resourceRef)) && (!kinds.size || kinds.has(item.kind)));
  const indexedMatches = [];
  let skippedMissing = 0;
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < descriptors.length) {
      const descriptorIndex = nextIndex;
      nextIndex += 1;
      const descriptor = descriptors[descriptorIndex];
      let resource;
      try { resource = await readResource(entry, descriptor.resourceRef); }
      catch (error) {
        if (error?.code === 'context_incomplete' || error?.code === 'ENOENT') {
          skippedMissing += 1;
          continue;
        }
        throw error;
      }
      const normalized = normalizeSearchText(`${descriptor.title}\n${resource.content}`);
      const index = normalized.indexOf(query);
      if (index < 0) continue;
      const start = Math.max(0, index - 80);
      const snippet = resource.content.slice(start, start + Math.max(240, query.length + 160));
      indexedMatches.push({ descriptorIndex, value: {
        resourceRef: descriptor.resourceRef,
        kind: descriptor.kind,
        title: descriptor.title,
        sourceHash: resource.sourceHash,
        snippet,
        evidenceAuthority: false,
      } });
    }
  };
  await Promise.all(Array.from({ length: Math.min(16, descriptors.length) }, () => worker()));
  const matches = indexedMatches.sort((left, right) => left.descriptorIndex - right.descriptorIndex).map((item) => item.value);
  return { ...page(matches, options.cursor, options.limit), query, truncated: false, skippedMissing, sourceHash: hash(matches) };
}

module.exports = {
  bodyChineseCharacterCount,
  chineseCharacterCount,
  RESOURCE_KINDS,
  chapterName,
  listResourceDescriptors,
  listResources,
  normalizeSearchQuery,
  normalizeSearchText,
  page,
  parseResourceRef,
  proseRepetitionEvidence,
  readResource,
  safeId,
  searchResources,
  stableJson,
};
