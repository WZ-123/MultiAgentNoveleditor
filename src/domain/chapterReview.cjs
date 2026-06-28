'use strict';

const REVIEW_SOURCES = new Set([
  'character_world',
  'timeline',
  'style',
  'prose_quality',
  'paragraph_function',
  'event_ledger',
]);

const REVIEW_STATUSES = new Set(['open', 'fixed', 'ignored', 'passed']);

const REVIEW_LABELS = {
  character_world: '人设/世界观',
  timeline: '时空/信息传播',
  style: '文风一致性',
  prose_quality: 'AI 味/行文质量',
  paragraph_function: '段落功能',
  event_ledger: '事件账本',
};

function safeText(value) {
  return String(value == null ? '' : value);
}

function compactReviewText(value, limit = 160) {
  const compacted = safeText(value).replace(/\s+/g, ' ').trim();
  if (!Number.isFinite(limit) || limit <= 0 || compacted.length <= limit) return compacted;
  return `${compacted.slice(0, limit)}...`;
}

function splitReviewParagraphs(text) {
  const raw = safeText(text).replace(/\r\n/g, '\n').trim();
  if (!raw) return [];
  return raw.split(/\n\s*\n/u).map((part, index) => ({
    id: `p-${index}`,
    index,
    text: part.trim(),
  }));
}

function buildParagraphLookup(paragraphs) {
  const list = Array.isArray(paragraphs) ? paragraphs : [];
  const byId = new Map();
  const byIndex = new Map();
  for (const paragraph of list) {
    if (!paragraph) continue;
    const id = safeText(paragraph.id).trim();
    const index = Number(paragraph.index);
    if (id) byId.set(id, paragraph);
    if (Number.isInteger(index)) byIndex.set(index, paragraph);
  }
  return { list, byId, byIndex };
}

function normalizeSource(rawSource, raw = {}) {
  const source = safeText(rawSource || raw.source || raw.sourceAgent || '').trim();
  if (REVIEW_SOURCES.has(source)) return source;
  const kind = safeText(raw.kind || raw.category || '').trim();
  if (/timeline|time|时空|信息|传播/u.test(source) || /timeline|时空|信息|传播/u.test(kind)) return 'timeline';
  if (/style|文风/u.test(source) || /style|文风/u.test(kind)) return 'style';
  if (/paragraph|段落|choppy|single_sentence/u.test(source) || /paragraph|段落|choppy|single_sentence/u.test(kind)) return 'paragraph_function';
  if (/prose|quality|ai|套话|八股|行文/u.test(source) || /prose|quality|ai|套话|八股|行文/u.test(kind)) return 'prose_quality';
  if (/ledger|账本/u.test(source) || /ledger|账本/u.test(kind)) return 'event_ledger';
  return 'character_world';
}

function normalizeStatus(value) {
  const status = safeText(value).trim();
  return REVIEW_STATUSES.has(status) ? status : 'open';
}

function normalizeSeverity(value, fallback = 'blocking') {
  const severity = safeText(value).trim();
  return severity || fallback || 'blocking';
}

function normalizeParagraphIds(raw, lookup) {
  const ids = [];
  const add = (value) => {
    const id = safeText(value).trim();
    if (!id || ids.includes(id)) return;
    if (lookup?.byId?.size && !lookup.byId.has(id)) return;
    ids.push(id);
  };
  if (Array.isArray(raw?.paragraphIds)) {
    for (const id of raw.paragraphIds) add(id);
  }
  add(raw?.paragraphId);
  if (!ids.length && Number.isInteger(raw?.paragraphIndex)) {
    const paragraph = lookup?.byIndex?.get(raw.paragraphIndex);
    if (paragraph?.id) add(paragraph.id);
  }
  if (!ids.length && Array.isArray(raw?.paragraphIndexes)) {
    for (const index of raw.paragraphIndexes) {
      if (!Number.isInteger(index)) continue;
      const paragraph = lookup?.byIndex?.get(index);
      if (paragraph?.id) add(paragraph.id);
    }
  }
  return ids;
}

function normalizeParagraphIndexes(raw, paragraphIds, lookup) {
  const indexes = [];
  const add = (value) => {
    const index = Number(value);
    if (!Number.isInteger(index) || indexes.includes(index)) return;
    indexes.push(index);
  };
  if (Array.isArray(raw?.paragraphIndexes)) {
    for (const index of raw.paragraphIndexes) add(index);
  }
  if (Number.isInteger(raw?.paragraphIndex)) add(raw.paragraphIndex);
  for (const id of paragraphIds) {
    const paragraph = lookup?.byId?.get(id);
    if (Number.isInteger(paragraph?.index)) add(paragraph.index);
  }
  return indexes.sort((left, right) => left - right);
}

function buildExcerpt(raw, paragraphIds, paragraphIndexes, lookup) {
  const explicit = compactReviewText(raw?.excerpt || '', 180);
  if (explicit) return explicit;
  const paragraphs = [];
  for (const id of paragraphIds || []) {
    const paragraph = lookup?.byId?.get(id);
    if (paragraph?.text) paragraphs.push(paragraph.text);
  }
  if (!paragraphs.length) {
    for (const index of paragraphIndexes || []) {
      const paragraph = lookup?.byIndex?.get(index);
      if (paragraph?.text) paragraphs.push(paragraph.text);
    }
  }
  return compactReviewText(paragraphs.join(' / '), 180);
}

function normalizeReviewIssue(raw, options = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const lookup = buildParagraphLookup(options.paragraphs);
  const source = normalizeSource(options.source || raw.source || raw.sourceAgent, raw);
  const note = compactReviewText(
    raw.note || raw.summary || raw.reason || raw.detail || raw.message || '',
    500
  );
  const evidence = compactReviewText(raw.evidence || '', 500);
  if (!note && !evidence && raw.reviewIncomplete !== true) return null;
  const paragraphIds = normalizeParagraphIds(raw, lookup);
  const paragraphIndexes = normalizeParagraphIndexes(raw, paragraphIds, lookup);
  const reviewIncomplete = raw.reviewIncomplete === true;
  const id = safeText(raw.id).trim() || `${source}-${options.index || 0}`;
  const category = safeText(raw.category || raw.kind || source).trim() || source;
  const status = reviewIncomplete ? 'open' : normalizeStatus(raw.status);
  const severity = normalizeSeverity(raw.severity, options.defaultSeverity || 'blocking');
  const excerpt = buildExcerpt(raw, paragraphIds, paragraphIndexes, lookup);
  return {
    id,
    source,
    sourceAgent: source,
    category,
    severity,
    status,
    paragraphIds,
    paragraphIndexes,
    note,
    summary: note,
    detail: raw.detail != null ? safeText(raw.detail) : undefined,
    evidence: evidence || undefined,
    suggestedAction: raw.suggestedAction != null ? safeText(raw.suggestedAction) : undefined,
    excerpt: excerpt || undefined,
    timelineKind: raw.timelineKind != null ? safeText(raw.timelineKind) : undefined,
    affectedOutlineNodeIds: Array.isArray(raw.affectedOutlineNodeIds)
      ? raw.affectedOutlineNodeIds.map((item) => safeText(item).trim()).filter(Boolean)
      : [],
    reviewIncomplete,
  };
}

function normalizeReviewIssues(rawList, options = {}) {
  const list = Array.isArray(rawList) ? rawList : [];
  return mergeReviewIssues(list.map((item, index) => normalizeReviewIssue(item, { ...options, index })));
}

function reviewIssueKey(issue) {
  const ids = Array.isArray(issue?.paragraphIds) ? issue.paragraphIds.join(',') : '';
  const idx = Array.isArray(issue?.paragraphIndexes) ? issue.paragraphIndexes.join(',') : '';
  return [
    issue?.source || issue?.sourceAgent || '',
    issue?.category || '',
    ids || idx,
    compactReviewText(issue?.note || issue?.summary || issue?.detail || '', 140),
  ].join('::');
}

function mergeReviewIssues(...groups) {
  const out = [];
  const seen = new Set();
  for (const group of groups) {
    const list = Array.isArray(group) ? group : [];
    for (const issue of list) {
      if (!issue) continue;
      const key = reviewIssueKey(issue);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(issue);
    }
  }
  return out.sort((left, right) => {
    const leftIncomplete = left?.reviewIncomplete ? 0 : 1;
    const rightIncomplete = right?.reviewIncomplete ? 0 : 1;
    if (leftIncomplete !== rightIncomplete) return leftIncomplete - rightIncomplete;
    const leftIndex = Array.isArray(left?.paragraphIndexes) && left.paragraphIndexes.length ? left.paragraphIndexes[0] : 9999;
    const rightIndex = Array.isArray(right?.paragraphIndexes) && right.paragraphIndexes.length ? right.paragraphIndexes[0] : 9999;
    return leftIndex - rightIndex;
  });
}

function isOpenReviewIssue(issue) {
  return !!issue && normalizeStatus(issue.status) === 'open';
}

function hasBlockingReviewIssues(issues) {
  return (Array.isArray(issues) ? issues : []).some(isOpenReviewIssue);
}

function getOpenReviewIssues(issues) {
  return (Array.isArray(issues) ? issues : []).filter(isOpenReviewIssue);
}

function reviewSourceLabel(source) {
  return REVIEW_LABELS[normalizeSource(source)] || '审查';
}

function formatReviewIssueLabel(issue) {
  const label = reviewSourceLabel(issue?.source || issue?.sourceAgent);
  const indexes = Array.isArray(issue?.paragraphIndexes) && issue.paragraphIndexes.length
    ? issue.paragraphIndexes.map((index) => `第${index + 1}段`).join(' / ')
    : '';
  const status = issue?.status && issue.status !== 'open' ? `/${issue.status}` : '';
  return `[${label}${status}]${indexes ? ` ${indexes}` : ''}`;
}

function setReviewIssueStatus(issues, matcher, status) {
  const nextStatus = normalizeStatus(status);
  const predicate = typeof matcher === 'function'
    ? matcher
    : (issue) => safeText(issue?.id).trim() === safeText(matcher).trim();
  return (Array.isArray(issues) ? issues : []).map((issue) => (
    predicate(issue) ? { ...issue, status: nextStatus } : issue
  ));
}

function collectIssueParagraphIndexes(issue, paragraphs) {
  const lookup = buildParagraphLookup(paragraphs);
  const indexes = normalizeParagraphIndexes(issue || {}, Array.isArray(issue?.paragraphIds) ? issue.paragraphIds : [], lookup);
  return indexes;
}

module.exports = {
  REVIEW_LABELS,
  REVIEW_SOURCES,
  REVIEW_STATUSES,
  compactReviewText,
  splitReviewParagraphs,
  normalizeReviewIssue,
  normalizeReviewIssues,
  mergeReviewIssues,
  isOpenReviewIssue,
  hasBlockingReviewIssues,
  getOpenReviewIssues,
  reviewSourceLabel,
  formatReviewIssueLabel,
  setReviewIssueStatus,
  collectIssueParagraphIndexes,
};
