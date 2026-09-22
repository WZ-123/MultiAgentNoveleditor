'use strict';

const DiffMatchPatch = require('diff-match-patch');

const PREVIEW_VERSION = 1;
const DIFF_DELETE = -1;
const DIFF_EQUAL = 0;
const DIFF_INSERT = 1;
const DEFAULT_CONTEXT_CHARS = 64;
const DEFAULT_MAX_CORE_CHARS = 240;
const DEFAULT_MAX_HUNKS = 6;
const DEFAULT_MERGE_GAP_CHARS = 80;

function normalizeLineEndings(value) {
  return String(value || '').replace(/\r\n?/gu, '\n');
}

function lineNumberAt(text, index) {
  const safeIndex = Math.max(0, Math.min(String(text || '').length, Number(index) || 0));
  let line = 1;
  for (let cursor = 0; cursor < safeIndex; cursor += 1) {
    if (text[cursor] === '\n') line += 1;
  }
  return line;
}

function clipChangedCore(value, maxChars = DEFAULT_MAX_CORE_CHARS) {
  const text = String(value || '');
  if (text.length <= maxChars) return text;
  const side = Math.max(24, Math.floor((maxChars - 3) / 2));
  return `${text.slice(0, side)}…${text.slice(-side)}`;
}

function snippetWithContext({ leading, core, trailing, leadingTruncated, trailingTruncated }) {
  return [
    leadingTruncated ? '…' : '',
    leading,
    clipChangedCore(core),
    trailing,
    trailingTruncated ? '…' : '',
  ].join('');
}

function buildOperations(before, after) {
  const dmp = new DiffMatchPatch();
  const diffs = dmp.diff_main(before, after);
  dmp.diff_cleanupSemantic(diffs);
  let beforeCursor = 0;
  let afterCursor = 0;
  return diffs.map(([type, rawText]) => {
    const text = String(rawText || '');
    const operation = {
      type,
      text,
      beforeStart: beforeCursor,
      afterStart: afterCursor,
    };
    if (type !== DIFF_INSERT) beforeCursor += text.length;
    if (type !== DIFF_DELETE) afterCursor += text.length;
    operation.beforeEnd = beforeCursor;
    operation.afterEnd = afterCursor;
    return operation;
  });
}

function clusterChangedOperations(operations, mergeGapChars = DEFAULT_MERGE_GAP_CHARS) {
  const changedIndexes = operations
    .map((operation, index) => (operation.type === DIFF_EQUAL ? -1 : index))
    .filter((index) => index >= 0);
  if (!changedIndexes.length) return [];

  const clusters = [];
  let first = changedIndexes[0];
  let last = first;
  for (const index of changedIndexes.slice(1)) {
    const gapLength = operations
      .slice(last + 1, index)
      .filter((operation) => operation.type === DIFF_EQUAL)
      .reduce((sum, operation) => sum + operation.text.length, 0);
    if (gapLength <= mergeGapChars) {
      last = index;
      continue;
    }
    clusters.push({ first, last });
    first = index;
    last = index;
  }
  clusters.push({ first, last });
  return clusters;
}

function buildHunk(before, after, operations, cluster, contextChars = DEFAULT_CONTEXT_CHARS) {
  const coreOperations = operations.slice(cluster.first, cluster.last + 1);
  const previous = operations[cluster.first - 1];
  const next = operations[cluster.last + 1];
  const previousEqual = previous?.type === DIFF_EQUAL ? previous.text : '';
  const nextEqual = next?.type === DIFF_EQUAL ? next.text : '';
  const leading = previousEqual.slice(-contextChars);
  const trailing = nextEqual.slice(0, contextChars);
  const leadingTruncated = previousEqual.length > leading.length;
  const trailingTruncated = nextEqual.length > trailing.length;
  const beforeCore = coreOperations
    .filter((operation) => operation.type !== DIFF_INSERT)
    .map((operation) => operation.text)
    .join('');
  const afterCore = coreOperations
    .filter((operation) => operation.type !== DIFF_DELETE)
    .map((operation) => operation.text)
    .join('');
  const removedLength = coreOperations
    .filter((operation) => operation.type === DIFF_DELETE)
    .reduce((sum, operation) => sum + operation.text.length, 0);
  const addedLength = coreOperations
    .filter((operation) => operation.type === DIFF_INSERT)
    .reduce((sum, operation) => sum + operation.text.length, 0);
  const firstOperation = operations[cluster.first];
  const lastOperation = operations[cluster.last];
  const beforeStart = firstOperation.beforeStart;
  const beforeEnd = lastOperation.beforeEnd;
  const afterStart = firstOperation.afterStart;
  const afterEnd = lastOperation.afterEnd;

  return {
    beforeStart,
    beforeEnd,
    afterStart,
    afterEnd,
    beforeLine: lineNumberAt(before, beforeStart),
    afterLine: lineNumberAt(after, afterStart),
    removedLength,
    addedLength,
    beforeSnippet: snippetWithContext({
      leading,
      core: beforeCore,
      trailing,
      leadingTruncated,
      trailingTruncated,
    }),
    afterSnippet: snippetWithContext({
      leading,
      core: afterCore,
      trailing,
      leadingTruncated,
      trailingTruncated,
    }),
  };
}

function summarizeHunks(hunks, totalHunkCount) {
  if (!hunks.length) return '内容无变化';
  const removedLength = hunks.reduce((sum, hunk) => sum + hunk.removedLength, 0);
  const addedLength = hunks.reduce((sum, hunk) => sum + hunk.addedLength, 0);
  let action = '';
  if (removedLength > 0 && addedLength > 0) action = `替换 ${removedLength} 字为 ${addedLength} 字`;
  else if (addedLength > 0) action = `新增 ${addedLength} 字`;
  else action = `删除 ${removedLength} 字`;

  if (totalHunkCount === 1) return `第 ${hunks[0].afterLine} 行：${action}`;
  const visibleLines = hunks.map((hunk) => hunk.afterLine).join('、');
  return `共 ${totalHunkCount} 处变更（第 ${visibleLines}${totalHunkCount > hunks.length ? '…' : ''} 行）：${action}`;
}

function buildChapterChangePreview(beforeContent, afterContent, options = {}) {
  const before = normalizeLineEndings(beforeContent);
  const after = normalizeLineEndings(afterContent);
  const maxHunks = Math.max(1, Number(options.maxHunks) || DEFAULT_MAX_HUNKS);
  if (before === after) {
    return {
      version: PREVIEW_VERSION,
      hasChanges: false,
      summary: '内容无变化',
      changeCount: 0,
      omittedHunkCount: 0,
      beforeLength: before.length,
      afterLength: after.length,
      hunks: [],
    };
  }

  const operations = buildOperations(before, after);
  const clusters = clusterChangedOperations(operations, options.mergeGapChars);
  const visibleClusters = clusters.slice(0, maxHunks);
  const hunks = visibleClusters.map((cluster) => buildHunk(
    before,
    after,
    operations,
    cluster,
    Math.max(24, Number(options.contextChars) || DEFAULT_CONTEXT_CHARS)
  ));
  return {
    version: PREVIEW_VERSION,
    hasChanges: true,
    summary: summarizeHunks(hunks, clusters.length),
    changeCount: clusters.length,
    omittedHunkCount: Math.max(0, clusters.length - hunks.length),
    beforeLength: before.length,
    afterLength: after.length,
    hunks,
  };
}

function isChapterChangePreview(value) {
  return !!value
    && typeof value === 'object'
    && Number(value.version) === PREVIEW_VERSION
    && typeof value.summary === 'string'
    && Array.isArray(value.hunks);
}

function chapterChangePreviewForPending(pending) {
  if (!pending || typeof pending !== 'object') return null;
  if (isChapterChangePreview(pending.changePreview)) return pending.changePreview;
  return buildChapterChangePreview(
    typeof pending.baseContent === 'string' ? pending.baseContent : '',
    typeof pending.content === 'string' ? pending.content : ''
  );
}

function changePreviewAfterText(preview) {
  if (!isChapterChangePreview(preview)) return '';
  return preview.hunks
    .map((hunk) => String(hunk?.afterSnippet || hunk?.beforeSnippet || ''))
    .filter(Boolean)
    .join('\n…\n');
}

module.exports = {
  PREVIEW_VERSION,
  buildChapterChangePreview,
  chapterChangePreviewForPending,
  changePreviewAfterText,
  isChapterChangePreview,
};
