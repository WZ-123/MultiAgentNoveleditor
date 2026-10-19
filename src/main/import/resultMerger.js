'use strict';

/**
 * Result Merger — merges analysis results from multiple text chunks.
 *
 * Each chunk produces: characters[], factions[], timeline[], world{}, outline, style
 * We merge them with deduplication and field enrichment.
 */

const MAX_CHUNK_CHARS = 40000;

/**
 * Split text at natural boundaries (chapter headers, then paragraphs).
 * Returns array of { index, title, text } where title is a chapter range description.
 */
function splitIntoChunks(text, maxChars = MAX_CHUNK_CHARS) {
  if (!Number.isInteger(maxChars) || maxChars < 2) throw new Error('chunk budget must be at least 2');
  const source = String(text || '');
  const chunks = [];
  let offset = 0;
  while (offset < source.length) {
    let end = Math.min(source.length, offset + maxChars);
    if (end < source.length) {
      const boundary = source.lastIndexOf('\n', end - 1);
      if (boundary > offset + Math.floor(maxChars / 2)) end = boundary + 1;
      // Do not split a UTF-16 surrogate pair.
      if (/[\uD800-\uDBFF]/u.test(source[end - 1])) end--;
    }
    const piece = source.slice(offset, end);
    chunks.push({ index: chunks.length, title: piece.match(/^#{1,3}\s*(.+)/m)?.[1]?.slice(0, 30) || `片段 ${chunks.length + 1}`,
      text: piece, sourceStart: offset, sourceEnd: end });
    offset = end;
  }
  return chunks.length ? chunks : [{ index: 0, title: '全文', text: '', sourceStart: 0, sourceEnd: 0 }];
}

// ---------- Merge helpers ----------

function _normalizeName(name) {
  return (name || '').toLowerCase().replace(/\s+/g, '').trim();
}

function _pickRicher(a, b) {
  if (a == null || a === '' || (Array.isArray(a) && !a.length)) return b;
  if (b == null || b === '') return a;
  if (Array.isArray(a) && Array.isArray(b)) return [...new Map([...a, ...b].map((item) => [JSON.stringify(item), item])).values()];
  // The first assertion stays visible; all contradictory assertions are stored below.
  return a;
}
function recordField(target, field, value, source) {
  if (value == null || value === '') return;
  target._analysisCandidates ||= {};
  const candidates = target._analysisCandidates[field] ||= [];
  const existing = candidates.find((candidate) => JSON.stringify(candidate.value) === JSON.stringify(value));
  if (existing) existing.sources.push(source);
  else candidates.push({ value, sources: [source] });
  if (candidates.length > 1 && !Array.isArray(value) && !['id', 'name', 'evidence'].includes(field)) {
    target._analysisConflicts ||= {};
    target._analysisConflicts[field] = candidates;
  }
  target[field] = target._analysisConflicts?.[field] ? null : _pickRicher(target[field], value);
}

function mergeEntities(chunkResults, field) {
  const byName = new Map();
  for (const cr of chunkResults) {
    for (const item of cr[field] || []) {
      const key = _normalizeName(item.name || item.id);
      if (!key) continue;
      if (!byName.has(key)) byName.set(key, { ...item, _analysisCandidates: {}, _analysisConflicts: {} });
      const target = byName.get(key);
      const quote = typeof item.evidence === 'string' ? item.evidence : String(item.evidence?.quote || '');
      const quoteOffset = quote ? String(cr.sourceText || '').indexOf(quote) : -1;
      const source = { chunkIndex: cr.chunkIndex, chunkTitle: cr.chunkTitle, evidence: item.evidence || null,
        sourceFile: cr.sourceFile, sourceStart: cr.sourceStart, quoteFound: quoteOffset >= 0,
        sourceExcerpt: String(cr.sourceText || '').slice(Math.max(0, quoteOffset - 200), Math.max(0, quoteOffset) + Math.min(1000, quote.length + 400)) };
      for (const [name, value] of Object.entries(item)) {
        if (name.startsWith('_analysis') || ['__proto__', 'constructor', 'prototype'].includes(name)) continue;
        recordField(target, name, value, source);
      }
      // Relationship assertions retain their complete payload and source, including disagreements.
      const relationshipCandidates = target._analysisCandidates.relationships || [];
      target.relationships = [...new Map(relationshipCandidates.flatMap((c) => c.value || []).map((r) => [JSON.stringify(r), r])).values()];
      const byPerson = new Map();
      for (const relation of target.relationships) {
        const list = byPerson.get(_normalizeName(relation.with)) || [];
        list.push(relation); byPerson.set(_normalizeName(relation.with), list);
      }
      if ([...byPerson.values()].some((values) => values.length > 1)) {
        target._analysisConflicts.relationships = relationshipCandidates; target.relationships = [];
      }
    }
  }
  return [...byName.values()];
}
function mergeCharacters(chunks) { return mergeEntities(chunks, 'characters'); }
function mergeFactions(chunks) { return mergeEntities(chunks, 'factions'); }

function mergeTimeline(chunkResults) {
  const unique = new Map();
  for (const chunk of chunkResults) {
    for (const event of chunk.timeline || []) {
      const key = JSON.stringify(event);
      if (!unique.has(key)) unique.set(key, { ...event, _analysisSources: [] });
      unique.get(key)._analysisSources.push({ chunkIndex: chunk.chunkIndex, chunkTitle: chunk.chunkTitle });
    }
  }
  return [...unique.values()];
}

function mergeWorld(chunkResults) {
  const { normalizeWorld, FIELDS } = require('./worldSchema');
  const result = normalizeWorld();
  const places = [];
  for (const chunk of chunkResults) {
    if (!chunk.world) continue;
    const world = normalizeWorld(chunk.world);
    result._analysisSources ||= [];
    result._analysisSources.push({ chunkIndex: chunk.chunkIndex, world });
    for (const field of [...FIELDS, 'isFanwork', 'possibleFanworkOf']) recordField(result, field, world[field], { chunkIndex: chunk.chunkIndex, chunkTitle: chunk.chunkTitle });
    recordField(result, 'referencedWorks', world.referencedWorks, { chunkIndex: chunk.chunkIndex, chunkTitle: chunk.chunkTitle });
    places.push({ chunkIndex: chunk.chunkIndex, chunkTitle: chunk.chunkTitle, characters: world.places });
  }
  // Keep text from every chunk; candidates document provenance and conflicts.
  for (const field of FIELDS) if (result._analysisConflicts?.[field]) result[field] = '';
  result.places = mergeCharacters(places);
  return result;
}

function mergeOutline(chunkResults) {
  const parts = [];
  for (const cr of chunkResults) {
    if (cr.outline) {
      parts.push(`## [第${cr.chunkIndex + 1}片：${cr.chunkTitle || ''}]\n\n${cr.outline}`);
    }
  }
  return parts.join('\n\n');
}

function mergeStyle(chunkResults) {
  // Use first chunk's full analysis as base
  const first = chunkResults.find((c) => c.style);
  if (!first) return '';
  const base = first.style;
  const diffs = [];
  for (let i = 1; i < chunkResults.length; i++) {
    if (chunkResults[i].style && chunkResults[i].style !== base) {
      diffs.push(`## [第${i + 1}片补充]\n\n${chunkResults[i].style}`);
    }
  }
  if (diffs.length === 0) return base;
  return base + '\n\n---\n\n后续分片文风补充：\n\n' + diffs.join('\n\n');
}

/**
 * Merge an array of chunk result objects into a single result.
 * Each chunk result should have shape:
 *   { chunkIndex, chunkTitle, characters[], factions[], timeline[], world{}, outline, style }
 */
function mergeChunkResults(chunkResults) {
  return {
    characters: mergeCharacters(chunkResults),
    factions: mergeFactions(chunkResults),
    timeline: mergeTimeline(chunkResults),
    world: mergeWorld(chunkResults),
    outline: mergeOutline(chunkResults),
    style: mergeStyle(chunkResults),
  };
}

module.exports = {
  splitIntoChunks,
  mergeChunkResults,
  mergeCharacters,
  mergeFactions,
  mergeTimeline,
  mergeWorld,
  mergeOutline,
  mergeStyle,
};
