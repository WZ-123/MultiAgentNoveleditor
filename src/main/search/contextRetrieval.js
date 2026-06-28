'use strict';

/**
 * Bounded writing/review context retrieval for novel projects.
 *
 * This is intentionally dependency-free v1 retrieval: no embeddings, no
 * persistent vector index. It builds small source chunks on demand, scores them
 * with normalized text matching plus current-chapter hints, and returns a
 * compact context block suitable for prompt preloading.
 */

const novelData = require('../store/novelData');
const { buildNormalizedTextIndex, findNormalizedRanges } = require('../../domain/textMatch.cjs');
const { fitTextForModel, safeString } = require('../runtime/contextAssembler');

const DEFAULT_CATEGORIES = ['characters', 'world', 'timeline', 'outlines'];
const DEFAULT_MAX_ITEMS = 12;
const DEFAULT_MAX_CHARS = 14000;
const SNIPPET_CONTEXT_CHARS = 120;

function cleanText(value) {
  return safeString(value).replace(/\s+/g, ' ').trim();
}

function compactSnippet(value, limit = 520) {
  const text = cleanText(value);
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function normalizeForSearch(value) {
  return buildNormalizedTextIndex(safeString(value)).text.toLowerCase();
}

function cjkNgrams(text) {
  const source = safeString(text).replace(/[^\u4e00-\u9fffA-Za-z0-9]+/g, '');
  const out = [];
  const seen = new Set();
  for (const size of [4, 3, 2]) {
    if (source.length < size) continue;
    for (let i = 0; i <= source.length - size && out.length < 80; i += 1) {
      const gram = source.slice(i, i + size);
      if (/^\d+$/u.test(gram) || seen.has(gram)) continue;
      seen.add(gram);
      out.push(gram);
    }
  }
  return out;
}

function buildTerms(options = {}) {
  const rawParts = [
    options.query,
    options.focus,
    options.chapterName,
    ...(Array.isArray(options.outlineNodes) ? options.outlineNodes.flatMap((node) => [
      node?.title,
      node?.summary,
      node?.location,
      node?.setting,
      node?.pov,
      ...(Array.isArray(node?.characters) ? node.characters : []),
    ]) : []),
  ].map(cleanText).filter(Boolean);

  const terms = [];
  const seen = new Set();
  const add = (value, weight) => {
    const text = cleanText(value);
    if (!text || text.length < 2) return;
    const key = normalizeForSearch(text);
    if (!key || seen.has(key)) return;
    seen.add(key);
    terms.push({ raw: text, normalized: key, weight });
  };

  for (const part of rawParts) {
    add(part, part === options.query ? 8 : 5);
    for (const piece of part.split(/[,\s，。！？!?；;：:、|/\\()[\]{}"'“”‘’《》<>-]+/u)) {
      add(piece, 4);
    }
    for (const gram of cjkNgrams(part)) add(gram, 1);
  }
  return terms;
}

function scoreText(text, terms, base = 0) {
  const normalized = normalizeForSearch(text);
  if (!normalized || !terms.length) return 0;
  let score = 0;
  let matched = false;
  for (const term of terms) {
    if (!term.normalized) continue;
    const first = normalized.indexOf(term.normalized);
    if (first < 0) continue;
    matched = true;
    score += term.weight;
    if (first < 80) score += 2;
  }
  return matched ? score + base : 0;
}

function bestSnippet(source, terms, fallbackLimit = 520) {
  const text = safeString(source);
  if (!text.trim()) return '';
  const index = buildNormalizedTextIndex(text);
  let best = null;
  for (const term of terms) {
    if (!term.raw) continue;
    const matches = findNormalizedRanges({ text: index.text.toLowerCase(), ranges: index.ranges }, term.raw.toLowerCase());
    if (matches.length) {
      const match = matches[0];
      if (!best || term.weight > best.weight) best = { ...match, weight: term.weight };
    }
  }
  if (!best) return compactSnippet(text, fallbackLimit);
  const start = Math.max(0, best.start - SNIPPET_CONTEXT_CHARS);
  const end = Math.min(text.length, best.end + SNIPPET_CONTEXT_CHARS);
  return compactSnippet(text.slice(start, end), fallbackLimit);
}

function chapterNumber(chapterName) {
  const match = safeString(chapterName).match(/chapter-(\d+)/i);
  return match ? Number(match[1]) : null;
}

function currentChapterBonus(targetChapterName, candidateChapterRef) {
  const target = chapterNumber(targetChapterName);
  const candidate = chapterNumber(candidateChapterRef);
  if (!target || !candidate) return candidateChapterRef && candidateChapterRef === targetChapterName ? 4 : 0;
  const distance = Math.abs(target - candidate);
  if (distance === 0) return 8;
  if (distance === 1) return 5;
  if (distance === 2) return 2;
  return 0;
}

function dedupeAndSort(items, maxItems) {
  const byRef = new Map();
  for (const item of items) {
    if (!item?.sourceRef) continue;
    const existing = byRef.get(item.sourceRef);
    if (!existing || item.score > existing.score) byRef.set(item.sourceRef, item);
  }
  return Array.from(byRef.values())
    .filter((item) => item.score > 0 || item.type === 'outline')
    .sort((left, right) => right.score - left.score || String(left.sourceRef).localeCompare(String(right.sourceRef), 'zh-Hans-CN'))
    .slice(0, maxItems);
}

function renderContextText(items) {
  if (!items.length) return '';
  const lines = ['# Retrieved Novel Context'];
  for (const item of items) {
    lines.push('', `## ${item.title || item.sourceRef}`);
    lines.push(`- sourceRef: ${item.sourceRef}`);
    lines.push(`- type: ${item.type}`);
    lines.push(`- score: ${item.score}`);
    if (item.matchReason) lines.push(`- reason: ${item.matchReason}`);
    if (item.snippet) lines.push('', item.snippet);
  }
  return lines.join('\n');
}

async function collectCharacterItems(novelDir, terms) {
  const characters = await novelData.listCharacters(novelDir);
  return (characters || []).map((character) => {
    const aliases = Array.isArray(character.aliases) ? character.aliases.join('、') : '';
    const body = [
      character.name,
      aliases,
      character.originalName,
      character.role,
      character.faction,
      character.personality,
      character.appearance,
      character.speechStyle,
      character.background,
      character.bio,
      character.storyArc,
      character.quotes,
      character.moeTraits,
      JSON.stringify(character.relationships || character.relationship || ''),
    ].filter(Boolean).join('\n');
    const nameScore = scoreText([character.name, aliases, character.originalName].join(' '), terms, 0) * 2;
    const score = scoreText(body, terms, 2) + nameScore;
    return {
      type: 'character',
      sourceRef: `character:${character.id || character.name}`,
      title: character.name || character.id || '未命名角色',
      snippet: bestSnippet(body, terms),
      score,
      target: { type: 'character', characterId: character.id },
    };
  });
}

function splitLoreChunks(lore) {
  const text = safeString(lore).trim();
  if (!text) return [];
  const paragraphs = text.split(/\n\s*\n/u).map((item) => item.trim()).filter(Boolean);
  const chunks = [];
  let buffer = '';
  for (const paragraph of paragraphs) {
    if (buffer && buffer.length + paragraph.length > 1200) {
      chunks.push(buffer);
      buffer = '';
    }
    buffer = buffer ? `${buffer}\n\n${paragraph}` : paragraph;
  }
  if (buffer) chunks.push(buffer);
  return chunks.length ? chunks : [text.slice(0, 1200)];
}

async function collectWorldItems(novelDir, terms) {
  const world = await novelData.readWorld(novelDir);
  const items = [];
  splitLoreChunks(world.lore).forEach((chunk, index) => {
    items.push({
      type: 'world_lore',
      sourceRef: `world:lore:${index + 1}`,
      title: `世界观设定 #${index + 1}`,
      snippet: bestSnippet(chunk, terms),
      score: scoreText(chunk, terms, 3),
      target: { type: 'world', section: 'lore' },
    });
  });
  for (const place of Array.isArray(world.places) ? world.places : []) {
    const body = [
      place?.name,
      place?.description,
      Array.isArray(place?.tags) ? place.tags.join('、') : '',
      place?.region,
      place?.notes,
    ].filter(Boolean).join('\n');
    const nameScore = scoreText(place?.name || '', terms, 0) * 2;
    items.push({
      type: 'world_place',
      sourceRef: `world:place:${place?.name || items.length + 1}`,
      title: place?.name || '未命名地点',
      snippet: bestSnippet(body, terms),
      score: scoreText(body, terms, 2) + nameScore,
      target: { type: 'world', placeName: place?.name || '' },
    });
  }
  return items;
}

async function collectTimelineItems(novelDir, terms, chapterName) {
  const events = await novelData.listTimeline(novelDir);
  return (events || []).map((event, index) => {
    const body = [
      event?.chapterRef,
      event?.when,
      event?.where,
      Array.isArray(event?.participants) ? event.participants.join('、') : '',
      event?.description,
      event?.physical,
      event?.communication,
    ].filter(Boolean).join('\n');
    return {
      type: 'timeline_event',
      sourceRef: `timeline:${event?.id || event?.chapterRef || event?.ts || index + 1}`,
      title: event?.description ? compactSnippet(event.description, 80) : (event?.chapterRef || '时间线事件'),
      snippet: bestSnippet(body, terms),
      score: scoreText(body, terms, 1) + currentChapterBonus(chapterName, event?.chapterRef),
      target: { type: 'timeline', eventId: event?.id || '', chapterRef: event?.chapterRef || '' },
    };
  });
}

async function collectOutlineItems(novelDir, terms, chapterName, outlineNodes) {
  let nodes = Array.isArray(outlineNodes) ? outlineNodes : [];
  if (!nodes.length) {
    const data = await novelData.readOutlineNodes(novelDir);
    nodes = Array.isArray(data?.nodes) ? data.nodes : [];
  }
  return nodes.map((node) => {
    const body = [
      node?.id,
      node?.title,
      node?.summary,
      node?.location,
      node?.setting,
      node?.pov,
      Array.isArray(node?.characters) ? node.characters.join('、') : '',
    ].filter(Boolean).join('\n');
    const chapterRef = node?.chapterRef || node?.writtenChapterRef || (node?.chapterIndex ? `chapter-${String(node.chapterIndex).padStart(3, '0')}.md` : '');
    return {
      type: 'outline',
      sourceRef: `outline:${node?.id || node?.title || chapterRef || 'node'}`,
      title: node?.title || node?.id || '大纲节点',
      snippet: bestSnippet(body, terms),
      score: scoreText(body, terms, 2) + currentChapterBonus(chapterName, chapterRef),
      target: { type: 'outline', nodeId: node?.id || '', chapterRef },
    };
  });
}

async function retrieveNovelContext(novelDir, options = {}) {
  const categories = Array.isArray(options.categories) && options.categories.length
    ? options.categories.filter((category) => DEFAULT_CATEGORIES.includes(category))
    : DEFAULT_CATEGORIES;
  const maxItems = Math.max(1, Math.min(Number(options.maxItems) || DEFAULT_MAX_ITEMS, 50));
  const maxChars = Math.max(1000, Math.min(Number(options.maxChars) || DEFAULT_MAX_CHARS, 50000));
  const query = cleanText(options.query || options.focus || options.chapterName || '');
  const terms = buildTerms({ ...options, query });
  if (!terms.length) {
    return { query, resultCount: 0, items: [], contextText: '' };
  }

  const groups = [];
  if (categories.includes('characters')) groups.push(collectCharacterItems(novelDir, terms));
  if (categories.includes('world')) groups.push(collectWorldItems(novelDir, terms));
  if (categories.includes('timeline')) groups.push(collectTimelineItems(novelDir, terms, options.chapterName));
  if (categories.includes('outlines')) groups.push(collectOutlineItems(novelDir, terms, options.chapterName, options.outlineNodes));

  const items = dedupeAndSort((await Promise.all(groups)).flat(), maxItems);
  const rawContextText = renderContextText(items);
  const fitted = fitTextForModel(rawContextText, {
    maxChars,
    sourceRef: `rag:${query || 'context'}`,
    label: 'retrieved_novel_context',
    kind: 'rag_context',
  });
  return {
    query,
    resultCount: items.length,
    items,
    contextText: fitted.text,
    wasTrimmed: fitted.wasTrimmed,
    originalLength: fitted.originalLength,
    modelLength: fitted.modelLength,
    omittedLength: fitted.omittedLength,
    manifestItem: fitted.manifestItem,
  };
}

module.exports = {
  retrieveNovelContext,
  _test: {
    buildTerms,
    scoreText,
    bestSnippet,
  },
};
