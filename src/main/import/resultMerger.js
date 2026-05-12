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
  if (!text || text.length <= maxChars) return [{ index: 0, title: '全文', text }];

  // Split at chapter markers first
  const chapterPattern = /(?=\n#{1,3}\s*(?:第[一二三四五六七八九十百千零\d]+章|Chapter\s+\d+|\d+\s*[、.．]|\[第\d+章\]))/gi;
  let chapters = text.split(chapterPattern).filter((s) => s.trim().length > 0);

  // If no chapters found, split at paragraph boundaries
  if (chapters.length <= 1) {
    chapters = text.split(/\n\n+/).filter((s) => s.trim().length > 0);
  }

  const chunks = [];
  let current = '';
  let startTitle = '';
  let endTitle = '';
  let chunkIndex = 0;

  function extractTitle(piece) {
    const m = piece.match(/^#{1,3}\s*(.+)/m);
    return m ? m[1].trim().slice(0, 30) : piece.trim().slice(0, 30);
  }

  for (let i = 0; i < chapters.length; i++) {
    const piece = chapters[i];
    const title = extractTitle(piece);
    if (!startTitle) startTitle = title;
    endTitle = title;

    if (current.length + piece.length > maxChars && current.length > 0) {
      chunks.push({
        index: chunkIndex++,
        title: startTitle === endTitle ? startTitle : `${startTitle} ~ ${endTitle}`,
        text: current.trim(),
      });
      current = piece;
      startTitle = title;
      endTitle = title;
    } else {
      current += '\n\n' + piece;
    }
  }

  if (current.trim().length > 0) {
    chunks.push({
      index: chunkIndex,
      title: startTitle === endTitle ? startTitle : `${startTitle} ~ ${endTitle}`,
      text: current.trim(),
    });
  }

  return chunks;
}

// ---------- Merge helpers ----------

function _normalizeName(name) {
  return (name || '').toLowerCase().replace(/\s+/g, '').trim();
}

function _pickRicher(a, b) {
  if (!a) return b;
  if (!b) return a;
  // Prefer longer / more detailed string; if same length, prefer newer (b)
  if (typeof a === 'string' && typeof b === 'string') {
    if (b.length > a.length) return b;
    if (a.length > b.length) return a;
    return b || a;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    const merged = [...a];
    for (const item of b) {
      if (!merged.includes(item)) merged.push(item);
    }
    return merged;
  }
  return b || a;
}

function mergeCharacters(chunkResults) {
  const byName = new Map();
  for (const cr of chunkResults) {
    const chars = cr.characters || [];
    for (const ch of chars) {
      const key = _normalizeName(ch.name || ch.id);
      if (!key) continue;
      if (!byName.has(key)) {
        byName.set(key, { ...ch });
      } else {
        const existing = byName.get(key);
        // Merge fields: prefer non-empty, longer descriptions
        for (const field of ['aliases', 'gender', 'age', 'role', 'appearance', 'personality', 'background', 'storyArc']) {
          existing[field] = _pickRicher(existing[field], ch[field]);
        }
        // Merge relationships
        const rels = [...(existing.relationships || []), ...(ch.relationships || [])];
        const relMap = new Map();
        for (const r of rels) {
          const rk = _normalizeName(r.with);
          if (rk) {
            if (!relMap.has(rk)) relMap.set(rk, r);
            else relMap.get(rk).type = relMap.get(rk).type || r.type;
          }
        }
        existing.relationships = Array.from(relMap.values());
      }
    }
  }
  return Array.from(byName.values());
}

function mergeFactions(chunkResults) {
  const byName = new Map();
  for (const cr of chunkResults) {
    const factions = cr.factions || [];
    for (const f of factions) {
      const key = _normalizeName(f.name);
      if (!key) continue;
      if (!byName.has(key)) {
        byName.set(key, { ...f });
      } else {
        const existing = byName.get(key);
        for (const field of ['aliases', 'type', 'description', 'goals']) {
          existing[field] = _pickRicher(existing[field], f[field]);
        }
        existing.members = _pickRicher(existing.members || [], f.members || []);
        existing.conflicts = _pickRicher(existing.conflicts || [], f.conflicts || []);
      }
    }
  }
  return Array.from(byName.values());
}

function _eventSimilarity(a, b) {
  const aTitle = (a.title || a.event || '').toLowerCase();
  const bTitle = (b.title || b.event || '').toLowerCase();
  if (aTitle === bTitle) return 1;
  // Simple Jaccard on words
  const aWords = new Set(aTitle.split(/\s+/));
  const bWords = new Set(bTitle.split(/\s+/));
  const intersection = new Set([...aWords].filter((x) => bWords.has(x)));
  const union = new Set([...aWords, ...bWords]);
  return union.size > 0 ? intersection.size / union.size : 0;
}

function mergeTimeline(chunkResults) {
  const allEvents = [];
  for (const cr of chunkResults) {
    const events = cr.timeline || [];
    for (const e of events) {
      allEvents.push(e);
    }
  }
  // Deduplicate by similarity
  const unique = [];
  for (const e of allEvents) {
    let found = false;
    for (const u of unique) {
      if (_eventSimilarity(e, u) > 0.7) {
        found = true;
        // Prefer more detailed event
        if ((e.event || '').length > (u.event || '').length) u.event = e.event;
        if ((e.involvedCharacters || []).length > (u.involvedCharacters || []).length) {
          u.involvedCharacters = Array.from(new Set([...(u.involvedCharacters || []), ...(e.involvedCharacters || [])]));
        }
        break;
      }
    }
    if (!found) unique.push({ ...e });
  }
  // Sort by some heuristic order (numeric timestamp if available, else by order of appearance)
  return unique;
}

function mergeWorld(chunkResults) {
  const lore = [];
  const placesByName = new Map();
  for (const cr of chunkResults) {
    const world = cr.world || {};
    if (world.lore) lore.push(world.lore);
    const places = world.places || [];
    for (const p of places) {
      const key = _normalizeName(p.name);
      if (!key) continue;
      if (!placesByName.has(key)) {
        placesByName.set(key, { ...p });
      } else {
        const existing = placesByName.get(key);
        existing.description = _pickRicher(existing.description, p.description);
        existing.type = existing.type || p.type;
      }
    }
  }
  return {
    lore: lore.join('\n\n---\n\n'),
    places: Array.from(placesByName.values()),
  };
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
