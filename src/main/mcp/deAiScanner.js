'use strict';

const { hash } = require('../codex-runtime/contracts');
const { DETECTOR_VERSION, PATTERN_RULES } = require('./deAiPatternCatalog');

const INVISIBLE = /[\u200B-\u200D\u2060\uFEFF]/u;

function normalizedWithOffsetMap(text) {
  const original = String(text || '').replace(/\r\n?/gu, '\n');
  let normalized = '';
  const offsetMap = [];
  for (let index = 0; index < original.length; index += 1) {
    const character = original[index];
    if (INVISIBLE.test(character)) continue;
    const value = character.normalize('NFKC')
      .replace(/[。．]/gu, '.')
      .replace(/[，、]/gu, ',')
      .replace(/；/gu, ';')
      .replace(/！/gu, '!')
      .replace(/？/gu, '?')
      .replace(/：/gu, ':');
    for (const outputCharacter of value) {
      normalized += outputCharacter;
      offsetMap.push(index);
    }
  }
  offsetMap.push(original.length);
  return { original, normalized, offsetMap };
}

function paragraphTable(text) {
  const paragraphs = [];
  let start = 0;
  String(text).split('\n').forEach((value, index, list) => {
    paragraphs.push({ id: `p-${index + 1}`, start, end: start + value.length, text: value });
    start += value.length + (index < list.length - 1 ? 1 : 0);
  });
  return paragraphs;
}

function originalRangesFor(paragraphs, start, end) {
  return paragraphs.filter((paragraph) => paragraph.end >= start && paragraph.start <= end).map((paragraph) => ({
    paragraphId: paragraph.id,
    start: Math.max(0, start - paragraph.start),
    end: Math.max(0, Math.min(paragraph.end, end) - paragraph.start),
  })).filter((range) => range.end > range.start);
}

function scanDeAiPatterns({ resourceRef, content, baseContentHash } = {}) {
  const mapped = normalizedWithOffsetMap(content);
  const resolvedResourceRef = String(resourceRef || '');
  const resolvedBaseHash = baseContentHash || hash(mapped.original);
  const paragraphs = paragraphTable(mapped.original);
  const candidates = [];
  const seen = new Set();
  for (const rule of PATTERN_RULES) {
    rule.expression.lastIndex = 0;
    for (const match of mapped.normalized.matchAll(rule.expression)) {
      const normalizedStart = match.index;
      const normalizedEnd = normalizedStart + match[0].length;
      const originalStart = mapped.offsetMap[normalizedStart] ?? 0;
      const originalEnd = Math.min(mapped.original.length, (mapped.offsetMap[Math.max(normalizedStart, normalizedEnd - 1)] ?? originalStart) + 1);
      const key = `${originalStart}:${originalEnd}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const ranges = originalRangesFor(paragraphs, originalStart, originalEnd);
      const paragraphIds = ranges.map((range) => range.paragraphId);
      candidates.push({
        schemaVersion: 1,
        candidateId: `pattern-${hash({
          detectorVersion: DETECTOR_VERSION,
          resourceRef: resolvedResourceRef,
          baseHash: resolvedBaseHash,
          ruleId: rule.ruleId,
          start: originalStart,
          end: originalEnd,
        }).slice(0, 24)}`,
        ruleId: rule.ruleId,
        detectorVersion: DETECTOR_VERSION,
        resourceRef: resolvedResourceRef,
        baseContentHash: resolvedBaseHash,
        start: originalStart,
        end: originalEnd,
        expectedTextHash: hash(mapped.original.slice(originalStart, originalEnd)),
        paragraphIds,
        originalRanges: ranges,
        originalExcerpt: mapped.original.slice(originalStart, originalEnd),
        normalizedExcerpt: match[0],
        context: { before: mapped.original.slice(Math.max(0, originalStart - 80), originalStart), after: mapped.original.slice(originalEnd, originalEnd + 80) },
        sourceExampleRefs: [...rule.sourceExampleRefs],
      });
    }
  }
  return { detectorVersion: DETECTOR_VERSION, scopeHash: hash(mapped.original), candidates };
}

module.exports = { normalizedWithOffsetMap, scanDeAiPatterns };
