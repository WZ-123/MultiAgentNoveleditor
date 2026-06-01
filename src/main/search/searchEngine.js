'use strict';

/**
 * Cross-project search engine for MultiAgentNovelAssistant.
 * Searches chapter content, chapter names, character cards, world lore, and timeline events.
 * Uses the existing textMatch.cjs for normalized (NFKC/fullwidth) text matching.
 */

const { buildNormalizedTextIndex, findNormalizedRanges } = require('../../domain/textMatch.cjs');
const novelData = require('../store/novelData');

const DEFAULT_MAX_PER_CATEGORY = 10;
const MAX_MATCHES_PER_CHAPTER = 20;
const MAX_TOTAL_RESULTS = 200;
const SNIPPET_CONTEXT_CHARS = 80;
const CONCURRENCY_LIMIT = 4;

/**
 * Search the entire novel project.
 * @param {string} novelDir
 * @param {string} query - search string (will be NFKC-normalized)
 * @param {object} [options]
 * @param {string[]} [options.categories] - ['chapters','characters','world','timeline'] or subset
 * @param {number} [options.maxResultsPerCategory] - cap per category
 * @returns {Promise<SearchResult[]>}
 */
async function searchNovel(novelDir, query, options = {}) {
  if (!query || !query.trim()) return [];

  const categories = Array.isArray(options.categories)
    ? options.categories
    : ['chapters', 'characters', 'world', 'timeline'];
  const maxPer = options.maxResultsPerCategory || DEFAULT_MAX_PER_CATEGORY;

  const tasks = [];
  const addTask = (label, fn) => { tasks.push({ label, fn }); };

  if (categories.includes('chapters')) {
    // Chapter content and chapter names are both in 'chapters' category
    addTask('chapterContent', () => searchChapterContent(novelDir, query, maxPer));
    addTask('chapterNames', () => searchChapterNames(novelDir, query, maxPer));
  }
  if (categories.includes('characters')) {
    addTask('characters', () => searchCharacters(novelDir, query, maxPer));
  }
  if (categories.includes('world')) {
    addTask('world', () => searchWorld(novelDir, query, maxPer));
  }
  if (categories.includes('timeline')) {
    addTask('timeline', () => searchTimeline(novelDir, query, maxPer));
  }

  // Run all category searches concurrently (Promise.all with sequential submission since each is already async)
  const resultsArrays = await Promise.all(tasks.map((t) => t.fn()));

  // Flatten, sort by relevance descending, cap total
  const all = resultsArrays.flat().sort((a, b) => b.relevance - a.relevance);
  return all.slice(0, MAX_TOTAL_RESULTS);
}

/**
 * @typedef {object} SearchResult
 * @property {string} type - result category: 'chapter_content'|'chapter_name'|'character'|'world_lore'|'world_place'|'timeline_event'
 * @property {number} relevance - sort key (higher = more relevant)
 * @property {string} title - display title
 * @property {string} snippet - context snippet with matched text
 * @property {string} [matchField] - the field that matched (e.g., 'name', 'aliases', 'content')
 * @property {object} target - navigation target
 * @property {string} target.type - 'chapter'|'character'|'world'|'timeline'
 * @property {string} [target.chapterFileName] - for chapter results
 * @property {string} [target.characterId] - for character results
 */

/**
 * Search chapter full-text content.
 * Uses normalized text matching (NFKC, fullwidth/halfwidth) from textMatch.cjs.
 * @param {string} novelDir
 * @param {string} query - NFKC-normalized search string
 * @param {number} maxResults
 * @returns {Promise<SearchResult[]>}
 */
async function searchChapterContent(novelDir, query, maxResults) {
  const chapters = await novelData.listChapters(novelDir);
  if (chapters.length === 0) return [];

  const normalizedQuery = query.normalize('NFKC');
  const allResults = [];

  // Process chapters with limited concurrency
  const queue = [...chapters];
  const workers = [];
  for (let i = 0; i < CONCURRENCY_LIMIT && i < queue.length; i++) {
    workers.push(worker(queue, normalizedQuery, novelDir, allResults));
  }
  await Promise.all(workers);

  // Sort by relevance and cap
  allResults.sort((a, b) => b.relevance - a.relevance);
  return allResults.slice(0, maxResults);
}

async function worker(queue, query, novelDir, allResults) {
  while (queue.length > 0) {
    const chapter = queue.shift();
    if (!chapter) break;
    try {
      const results = await searchSingleChapter(novelDir, chapter, query);
      for (const r of results) {
        allResults.push(r);
      }
    } catch (err) {
      // Skip unreadable chapters silently
    }
  }
}

async function searchSingleChapter(novelDir, chapter, query) {
  const content = await novelData.readChapter(novelDir, chapter.name);
  if (!content) return [];

  const index = buildNormalizedTextIndex(content);
  const matches = findNormalizedRanges(index, query);
  if (matches.length === 0) return [];

  // Cap matches per chapter
  const capped = matches.slice(0, MAX_MATCHES_PER_CHAPTER);
  const results = [];

  for (const match of capped) {
    const snippetStart = Math.max(0, match.start - SNIPPET_CONTEXT_CHARS);
    const snippetEnd = Math.min(content.length, match.end + SNIPPET_CONTEXT_CHARS);
    const snippet = content.slice(snippetStart, snippetEnd);

    results.push({
      type: 'chapter_content',
      relevance: 10 + Math.round((match.start < 200 ? 5 : 0) + (query.length >= 4 ? 2 : 0)),
      title: chapter.name,
      snippet,
      matchField: 'content',
      target: {
        type: 'chapter',
        chapterFileName: chapter.name,
        startOffset: match.start,
        endOffset: match.end,
      },
    });
  }

  return results;
}

/**
 * Search chapter display names.
 * @param {string} novelDir
 * @param {string} query
 * @param {number} maxResults
 * @returns {Promise<SearchResult[]>}
 */
async function searchChapterNames(novelDir, query, maxResults) {
  const metas = await novelData.listChapterMetas(novelDir);
  if (metas.length === 0) return [];

  const normalizedQuery = query.normalize('NFKC').toLowerCase();
  const results = [];

  for (let i = 0; i < metas.length; i++) {
    const meta = metas[i];
    // Compute display name like "第1章：开端" for search
    const displayName = await computeDisplayNameForChapter(novelDir, meta, i);
    const displayValue = displayName || '';

    const fields = [
      { value: meta.title || '', weight: 10, field: 'title' },
      { value: meta.headingTitle || '', weight: 8, field: 'headingTitle' },
      { value: displayValue, weight: 9, field: 'displayName' },
      { value: meta.fileName || '', weight: 3, field: 'fileName' },
    ];

    for (const { value, weight, field } of fields) {
      if (!value) continue;
      const normalizedValue = value.normalize('NFKC').toLowerCase();
      if (normalizedValue.includes(normalizedQuery)) {
        results.push({
          type: 'chapter_name',
          relevance: weight + (normalizedValue.startsWith(normalizedQuery) ? 5 : 0),
          title: displayValue || meta.title || meta.fileName,
          snippet: value,
          matchField: field,
          target: {
            type: 'chapter',
            chapterFileName: meta.fileName,
          },
        });
        break; // One result per chapter (highest-weight match)
      }
    }
  }

  results.sort((a, b) => b.relevance - a.relevance);
  return results.slice(0, maxResults);
}

async function computeDisplayNameForChapter(novelDir, meta, index) {
  try {
    return await novelData.computeDisplayNameForNovel(novelDir, index + 1, meta.title);
  } catch {
    return meta.fileName;
  }
}

/**
 * Search character cards.
 * @param {string} novelDir
 * @param {string} query
 * @param {number} maxResults
 * @returns {Promise<SearchResult[]>}
 */
async function searchCharacters(novelDir, query, maxResults) {
  const characters = await novelData.listCharacters(novelDir);
  if (characters.length === 0) return [];

  const normalizedQuery = query.normalize('NFKC').toLowerCase();
  const results = [];

  for (const char of characters) {
    const fields = [
      { value: char.name || '', weight: 20, label: 'name' },
      ...(Array.isArray(char.aliases) ? char.aliases.map((a) => ({ value: a || '', weight: 15, label: 'aliases' })) : []),
      { value: char.originalName || '', weight: 12, label: 'originalName' },
      { value: char.role || '', weight: 5, label: 'role' },
      { value: char.faction || '', weight: 5, label: 'faction' },
      { value: char.personality || '', weight: 3, label: 'personality' },
      { value: char.appearance || '', weight: 3, label: 'appearance' },
      { value: char.background || '', weight: 3, label: 'background' },
      { value: char.moeTraits || '', weight: 2, label: 'moeTraits' },
      { value: char.quotes || '', weight: 2, label: 'quotes' },
    ];

    let bestWeight = 0;
    let bestField = '';
    let bestSnippet = '';

    for (const { value, weight, label } of fields) {
      if (!value) continue;
      const normalizedValue = value.normalize('NFKC').toLowerCase();
      if (normalizedValue.includes(normalizedQuery)) {
        // Calculate weight bonus for prefix match
        const bonus = normalizedValue.startsWith(normalizedQuery) ? 5 : 0;
        const effectiveWeight = weight + bonus;
        if (effectiveWeight > bestWeight) {
          bestWeight = effectiveWeight;
          bestField = label;
          bestSnippet = value.length > 200 ? value.slice(0, 200) + '...' : value;
        }
      }
    }

    if (bestWeight > 0) {
      results.push({
        type: 'character',
        relevance: bestWeight,
        title: char.name || char.id,
        snippet: bestSnippet,
        matchField: bestField,
        target: {
          type: 'character',
          characterId: char.id,
        },
      });
    }
  }

  results.sort((a, b) => b.relevance - a.relevance);
  return results.slice(0, maxResults);
}

/**
 * Search world lore and places.
 * @param {string} novelDir
 * @param {string} query
 * @param {number} maxResults
 * @returns {Promise<SearchResult[]>}
 */
async function searchWorld(novelDir, query, maxResults) {
  const world = await novelData.readWorld(novelDir);
  const results = [];
  const normalizedQuery = query.normalize('NFKC');

  // Search lore as full text
  if (world.lore) {
    const index = buildNormalizedTextIndex(world.lore);
    const matches = findNormalizedRanges(index, normalizedQuery);
    if (matches.length > 0) {
      const firstMatch = matches[0];
      const snippetStart = Math.max(0, firstMatch.start - SNIPPET_CONTEXT_CHARS);
      const snippetEnd = Math.min(world.lore.length, firstMatch.end + SNIPPET_CONTEXT_CHARS);
      results.push({
        type: 'world_lore',
        relevance: 10 + matches.length,
        title: '世界观设定',
        snippet: world.lore.slice(snippetStart, snippetEnd),
        matchField: 'lore',
        target: { type: 'world' },
      });
    }
  }

  // Search places
  if (Array.isArray(world.places)) {
    const nq = normalizedQuery.toLowerCase();
    for (const place of world.places) {
      if (!place) continue;
      const name = String(place.name || '').normalize('NFKC').toLowerCase();
      const desc = String(place.description || '').normalize('NFKC').toLowerCase();
      const tags = Array.isArray(place.tags) ? place.tags.map((t) => String(t || '').normalize('NFKC').toLowerCase()) : [];

      const nameMatch = name.includes(nq);
      const descMatch = desc.includes(nq);
      const tagsMatch = tags.some((t) => t.includes(nq));

      if (nameMatch || descMatch || tagsMatch) {
        const weight = nameMatch ? 7 : tagsMatch ? 5 : 3;
        results.push({
          type: 'world_place',
          relevance: weight,
          title: place.name || '（未命名地点）',
          snippet: place.description || '',
          matchField: nameMatch ? 'name' : tagsMatch ? 'tags' : 'description',
          target: { type: 'world' },
        });
      }
    }
  }

  results.sort((a, b) => b.relevance - a.relevance);
  return results.slice(0, maxResults);
}

/**
 * Search timeline events.
 * @param {string} novelDir
 * @param {string} query
 * @param {number} maxResults
 * @returns {Promise<SearchResult[]>}
 */
async function searchTimeline(novelDir, query, maxResults) {
  const events = await novelData.listTimeline(novelDir);
  if (!Array.isArray(events) || events.length === 0) return [];

  const normalizedQuery = query.normalize('NFKC').toLowerCase();
  const results = [];

  for (const event of events) {
    if (!event) continue;
    const fields = [
      { value: event.title || event.description || '', weight: 5, label: 'title' },
      { value: event.description || '', weight: 3, label: 'description' },
      ...(Array.isArray(event.participants) ? event.participants.map((p) => ({ value: p || '', weight: 2, label: 'participants' })) : []),
    ];

    let bestWeight = 0;
    let bestField = '';
    let bestSnippet = '';

    for (const { value, weight, label } of fields) {
      if (!value) continue;
      const nv = String(value).normalize('NFKC').toLowerCase();
      if (nv.includes(normalizedQuery)) {
        const effectiveWeight = weight;
        if (effectiveWeight > bestWeight) {
          bestWeight = effectiveWeight;
          bestField = label;
          bestSnippet = String(value).slice(0, 200);
        }
      }
    }

    if (bestWeight > 0) {
      results.push({
        type: 'timeline_event',
        relevance: bestWeight,
        title: event.title || event.description?.slice(0, 80) || '（未命名事件）',
        snippet: bestSnippet,
        matchField: bestField,
        target: { type: 'timeline' },
      });
    }
  }

  results.sort((a, b) => b.relevance - a.relevance);
  return results.slice(0, maxResults);
}

module.exports = {
  searchNovel,
  searchChapterContent,
  searchChapterNames,
  searchCharacters,
  searchWorld,
  searchTimeline,
};
