'use strict';

const crypto = require('node:crypto');
const {
  normalizeConstraintAssertion,
} = require('../../domain/chapterHarness.cjs');
const { splitIntoParagraphs } = require('./chapterCharacterReview');
const { resolveAnchoredTextMatches } = require('../../domain/textMatch.cjs');

function hashText(value) {
  return crypto.createHash('sha256').update(String(value || '').replace(/\r\n/g, '\n').trim()).digest('hex').slice(0, 16);
}

function sceneIdForParagraph(draft, paragraphId) {
  return (Array.isArray(draft?.sceneDrafts) ? draft.sceneDrafts : [])
    .find((scene) => Array.isArray(scene?.paragraphIds) && scene.paragraphIds.includes(paragraphId))?.sceneId || '';
}

function normalizeAssertions(assertions) {
  return (Array.isArray(assertions) ? assertions : [])
    .map((item, index) => normalizeConstraintAssertion(item, index))
    .filter((item) => item.assertion);
}

function buildConstraintReviewPacket(draft, assertions) {
  const paragraphs = splitIntoParagraphs(draft?.text || '');
  const sceneDrafts = Array.isArray(draft?.sceneDrafts) ? draft.sceneDrafts : [];
  return {
    assertions: normalizeAssertions(assertions),
    scenes: sceneDrafts.map((scene) => ({
      sceneId: scene.sceneId,
      title: scene.title || '',
      paragraphIds: Array.isArray(scene.paragraphIds) ? scene.paragraphIds : [],
    })),
    paragraphs: paragraphs.map((paragraph) => ({
      id: paragraph.id,
      index: paragraph.index,
      text: paragraph.text,
    })),
  };
}

function buildLocalRepairRequest({ draft, issues, repairRound }) {
  const paragraphs = splitIntoParagraphs(draft?.text || '');
  const byId = new Map(paragraphs.map((paragraph) => [paragraph.id, paragraph]));
  const targets = [];
  const seen = new Set();
  for (const issue of Array.isArray(issues) ? issues : []) {
    if (issue?.reviewIncomplete || issue?.severity === 'advisory') continue;
    for (const paragraphId of Array.isArray(issue?.paragraphIds) ? issue.paragraphIds : []) {
      if (!byId.has(paragraphId) || seen.has(paragraphId)) continue;
      seen.add(paragraphId);
      const paragraph = byId.get(paragraphId);
      targets.push({
        paragraphId,
        currentText: paragraph.text,
        previousText: paragraphs[paragraph.index - 1]?.text || '',
        nextText: paragraphs[paragraph.index + 1]?.text || '',
        anchor: {
          textHash: hashText(paragraph.text),
          beforeHash: hashText(paragraphs[paragraph.index - 1]?.text || ''),
          afterHash: hashText(paragraphs[paragraph.index + 1]?.text || ''),
          sceneId: sceneIdForParagraph(draft, paragraphId),
        },
      });
    }
  }
  return {
    repairRound,
    chapter: { name: draft?.name || '', title: draft?.title || '' },
    issues: (Array.isArray(issues) ? issues : []).filter((issue) => !issue?.reviewIncomplete).map((issue) => ({
      constraintId: issue.constraintId || '',
      sceneId: issue.sceneId || '',
      paragraphIds: Array.isArray(issue.paragraphIds) ? issue.paragraphIds : [],
      summary: issue.summary || issue.note || '',
      evidence: issue.evidence || '',
      repairInstruction: issue.repairInstruction || issue.suggestedAction || '',
    })),
    targets,
  };
}

function applyParagraphReplacements(draft, replacements, options = {}) {
  const paragraphs = splitIntoParagraphs(draft?.text || '');
  const sourceText = String(draft?.text || '');
  let rangeCursor = 0;
  const paragraphRanges = new Map();
  for (const paragraph of paragraphs) {
    const start = sourceText.indexOf(paragraph.text, rangeCursor);
    if (start >= 0) {
      paragraphRanges.set(paragraph.id, { start, end: start + paragraph.text.length });
      rangeCursor = start + paragraph.text.length;
    }
  }
  const targetMap = new Map((Array.isArray(options.targets) ? options.targets : []).map((target) => [target.paragraphId, target]));
  const replacementMap = new Map();
  const ambiguousAnchors = [];
  for (const item of Array.isArray(replacements) ? replacements : []) {
    const paragraphId = String(item?.paragraphId || '').trim();
    const replacementText = String(item?.text || item?.replacement || '').trim();
    if (!paragraphId || !replacementText || replacementMap.has(paragraphId)) continue;
    const target = targetMap.get(paragraphId);
    const direct = paragraphs.find((paragraph) => paragraph.id === paragraphId);
    if (!target || (direct && (!target.anchor?.textHash || hashText(direct.text) === target.anchor.textHash))) {
      replacementMap.set(paragraphId, replacementText);
      continue;
    }
    const resolved = resolveAnchoredTextMatches(sourceText, target.currentText || '', {
      beforeContext: target.previousText || '',
      afterContext: target.nextText || '',
      expectedMatchCount: 1,
    });
    if (resolved.matches.length !== 1) {
      ambiguousAnchors.push(paragraphId);
      continue;
    }
    const match = resolved.matches[0];
    const relocated = paragraphs.find((paragraph) => {
      const range = paragraphRanges.get(paragraph.id);
      return range && match.start >= range.start && match.end <= range.end;
    });
    if (!relocated || replacementMap.has(relocated.id)) {
      ambiguousAnchors.push(paragraphId);
      continue;
    }
    replacementMap.set(relocated.id, replacementText);
  }
  if (ambiguousAnchors.length) {
    return { draft, applied: 0, unknownParagraphIds: [], ambiguousAnchors, reason: 'paragraph_anchor_ambiguous' };
  }
  if (!replacementMap.size) return { draft, applied: 0, unknownParagraphIds: [], ambiguousAnchors: [] };
  const known = new Set(paragraphs.map((paragraph) => paragraph.id));
  const unknownParagraphIds = Array.from(replacementMap.keys()).filter((id) => !known.has(id));
  if (unknownParagraphIds.length) {
    return { draft, applied: 0, unknownParagraphIds, ambiguousAnchors: [], reason: 'paragraph_anchor_missing' };
  }
  const text = paragraphs.map((paragraph) => replacementMap.get(paragraph.id) || paragraph.text).join('\n\n');
  const changedParagraphIds = paragraphs.filter((paragraph) => replacementMap.has(paragraph.id)).map((paragraph) => paragraph.id);
  const targetedParagraphIds = Array.from(replacementMap.keys());
  return {
    draft: { ...draft, text },
    applied: changedParagraphIds.length,
    unknownParagraphIds: [],
    ambiguousAnchors: [],
    impact: {
      targetedParagraphIds,
      changedParagraphIds,
      collateralParagraphIds: changedParagraphIds.filter((id) => !targetedParagraphIds.includes(id)),
    },
  };
}

module.exports = {
  applyParagraphReplacements,
  buildConstraintReviewPacket,
  buildLocalRepairRequest,
  normalizeAssertions,
  hashText,
};
