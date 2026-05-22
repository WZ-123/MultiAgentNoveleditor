function findLiteralRanges(haystack, needle) {
  if (!needle) return [];
  const matches = [];
  let cursor = 0;
  while (cursor <= haystack.length) {
    const index = haystack.indexOf(needle, cursor);
    if (index < 0) break;
    matches.push({ start: index, end: index + needle.length });
    cursor = index + needle.length;
  }
  return matches;
}

function normalizeMatchChar(rawChar) {
  if (/[\u0000-\u001f]/u.test(rawChar) && rawChar !== '\n' && rawChar !== '\t' && rawChar !== '\r') {
    return rawChar;
  }
  if ('“”„‟〝〞＂'.includes(rawChar)) return '"';
  if ('‘’‚‛＇'.includes(rawChar)) return '\'';
  return rawChar.normalize('NFKC');
}

function buildNormalizedTextIndex(text) {
  const source = typeof text === 'string' ? text : '';
  let normalized = '';
  const ranges = [];
  let originalIndex = 0;

  while (originalIndex < source.length) {
    const rawChar = source[originalIndex];
    let originalEnd = originalIndex + 1;
    let normalizedChunk = rawChar;

    if (rawChar === '\r') {
      if (source[originalIndex + 1] === '\n') originalEnd = originalIndex + 2;
      normalizedChunk = '\n';
    } else if (rawChar === '\u00a0' || rawChar === '\u3000' || rawChar === '\t') {
      normalizedChunk = ' ';
    } else if (/[\u200b\u200c\u200d\ufeff]/u.test(rawChar)) {
      originalIndex = originalEnd;
      continue;
    }

    normalizedChunk = Array.from(normalizedChunk, normalizeMatchChar).join('');
    for (const normalizedChar of normalizedChunk) {
      normalized += normalizedChar;
      ranges.push({ start: originalIndex, end: originalEnd });
    }
    originalIndex = originalEnd;
  }

  return { text: normalized, ranges };
}

function findNormalizedRanges(currentIndex, searchText) {
  const normalizedNeedle = buildNormalizedTextIndex(searchText).text;
  if (!normalizedNeedle) return [];

  const matches = [];
  let cursor = 0;
  while (cursor <= currentIndex.text.length) {
    const normalizedStart = currentIndex.text.indexOf(normalizedNeedle, cursor);
    if (normalizedStart < 0) break;
    const normalizedEnd = normalizedStart + normalizedNeedle.length;
    const firstRange = currentIndex.ranges[normalizedStart];
    const lastRange = currentIndex.ranges[normalizedEnd - 1];
    if (firstRange && lastRange) {
      matches.push({
        start: firstRange.start,
        end: lastRange.end,
        normalizedStart,
        normalizedEnd,
      });
    }
    cursor = normalizedEnd;
  }

  const deduped = [];
  const seen = new Set();
  for (const match of matches) {
    const key = `${match.start}:${match.end}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(match);
  }
  return deduped;
}

function filterRangesByContext(matches, currentIndex, options = {}) {
  const beforeContext = typeof options.beforeContext === 'string' ? options.beforeContext : '';
  const afterContext = typeof options.afterContext === 'string' ? options.afterContext : '';
  if (!beforeContext && !afterContext) return matches;

  const normalizedBefore = buildNormalizedTextIndex(beforeContext).text;
  const normalizedAfter = buildNormalizedTextIndex(afterContext).text;
  const lookaround = Math.max(240, normalizedBefore.length + normalizedAfter.length + 40);

  return matches.filter((match) => {
    if (normalizedBefore) {
      const leftEdge = Math.max(0, match.normalizedStart - lookaround);
      const leftText = currentIndex.text.slice(leftEdge, match.normalizedStart);
      if (!leftText.includes(normalizedBefore)) return false;
    }
    if (normalizedAfter) {
      const rightEdge = Math.min(currentIndex.text.length, match.normalizedEnd + lookaround);
      const rightText = currentIndex.text.slice(match.normalizedEnd, rightEdge);
      if (!rightText.includes(normalizedAfter)) return false;
    }
    return true;
  });
}

function collectPreferredTextMatches(current, search, options = {}) {
  const exactMatches = findLiteralRanges(current, search).map((match) => ({ ...match, strategy: 'exact' }));
  const currentIndex = buildNormalizedTextIndex(current);
  const normalizedMatches = filterRangesByContext(findNormalizedRanges(currentIndex, search), currentIndex, options)
    .map((match) => ({
      start: match.start,
      end: match.end,
      normalizedStart: match.normalizedStart,
      normalizedEnd: match.normalizedEnd,
      strategy: options.beforeContext || options.afterContext ? 'normalized_context' : 'normalized',
    }));

  return {
    matches: exactMatches.length ? exactMatches : normalizedMatches,
    exactMatches,
    normalizedMatches,
  };
}

function resolveAnchoredTextMatches(current, search, options = {}) {
  const expectedMatchCount = Number.isInteger(options.expectedMatchCount)
    ? options.expectedMatchCount
    : 1;
  const exactMatches = findLiteralRanges(current, search);
  if (exactMatches.length === expectedMatchCount) {
    return { matches: exactMatches, strategy: 'exact', expectedMatchCount };
  }

  const currentIndex = buildNormalizedTextIndex(current);
  const normalizedMatches = findNormalizedRanges(currentIndex, search);
  const filteredNormalizedMatches = filterRangesByContext(normalizedMatches, currentIndex, options);

  if (filteredNormalizedMatches.length === expectedMatchCount) {
    return {
      matches: filteredNormalizedMatches.map(({ start, end }) => ({ start, end })),
      strategy: options.beforeContext || options.afterContext ? 'normalized_context' : 'normalized',
      expectedMatchCount,
    };
  }

  return {
    matches: exactMatches,
    strategy: 'exact',
    expectedMatchCount,
    normalizedMatchCount: filteredNormalizedMatches.length,
  };
}

const textMatch = {
  buildNormalizedTextIndex,
  collectPreferredTextMatches,
  filterRangesByContext,
  findLiteralRanges,
  findNormalizedRanges,
  normalizeMatchChar,
  resolveAnchoredTextMatches,
};

export {
  buildNormalizedTextIndex,
  collectPreferredTextMatches,
  filterRangesByContext,
  findLiteralRanges,
  findNormalizedRanges,
  normalizeMatchChar,
  resolveAnchoredTextMatches,
};

export default textMatch;