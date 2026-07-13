export const REVIEW_LABELS = {
  character_world: '人设/世界观',
  timeline: '时空/信息传播',
  style: '文风一致性',
  prose_quality: 'AI 味/行文质量',
  paragraph_function: '段落功能',
  event_ledger: '事件账本',
};

const REVIEW_SOURCES = new Set(Object.keys(REVIEW_LABELS));
const REVIEW_STATUSES = new Set(['open', 'fixed', 'ignored', 'passed']);

function safeText(value) {
  return String(value == null ? '' : value);
}

export function compactReviewText(value, limit = 160) {
  const compacted = safeText(value).replace(/\s+/g, ' ').trim();
  if (!Number.isFinite(limit) || limit <= 0 || compacted.length <= limit) return compacted;
  return `${compacted.slice(0, limit)}...`;
}

export function normalizeReviewSource(rawSource, raw = {}) {
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

function paragraphLookup(paragraphs) {
  const byId = new Map();
  const byIndex = new Map();
  for (const paragraph of Array.isArray(paragraphs) ? paragraphs : []) {
    if (!paragraph) continue;
    if (paragraph.id) byId.set(String(paragraph.id), paragraph);
    if (Number.isInteger(paragraph.index)) byIndex.set(paragraph.index, paragraph);
  }
  return { byId, byIndex };
}

export function normalizeReviewIssue(raw, options = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const lookup = paragraphLookup(options.paragraphs);
  const source = normalizeReviewSource(options.source || raw.source || raw.sourceAgent, raw);
  const note = compactReviewText(raw.note || raw.summary || raw.reason || raw.detail || raw.message || '', 500);
  const evidence = compactReviewText(raw.evidence || '', 500);
  if (!note && !evidence && raw.reviewIncomplete !== true) return null;
  const paragraphIds = [];
  const addId = (value) => {
    const id = safeText(value).trim();
    if (!id || paragraphIds.includes(id)) return;
    if (lookup.byId.size && !lookup.byId.has(id)) return;
    paragraphIds.push(id);
  };
  if (Array.isArray(raw.paragraphIds)) raw.paragraphIds.forEach(addId);
  addId(raw.paragraphId);
  const paragraphIndexes = [];
  const addIndex = (value) => {
    const index = Number(value);
    if (!Number.isInteger(index) || paragraphIndexes.includes(index)) return;
    paragraphIndexes.push(index);
  };
  if (Array.isArray(raw.paragraphIndexes)) raw.paragraphIndexes.forEach(addIndex);
  if (Number.isInteger(raw.paragraphIndex)) addIndex(raw.paragraphIndex);
  for (const id of paragraphIds) addIndex(lookup.byId.get(id)?.index);
  const excerpt = compactReviewText(
    raw.excerpt || paragraphIds.map((id) => lookup.byId.get(id)?.text || '').filter(Boolean).join(' / '),
    180
  );
  const reviewIncomplete = raw.reviewIncomplete === true;
  return {
    id: safeText(raw.id).trim() || `${source}-${options.index || 0}`,
    source,
    sourceAgent: source,
    category: safeText(raw.category || raw.kind || source).trim() || source,
    patternId: raw.patternId != null ? safeText(raw.patternId) : undefined,
    severity: safeText(raw.severity).trim() || options.defaultSeverity || 'blocking',
    confidence: Number.isFinite(Number(raw.confidence))
      ? Math.max(0, Math.min(1, Number(raw.confidence)))
      : undefined,
    status: reviewIncomplete ? 'open' : normalizeStatus(raw.status),
    paragraphIds,
    paragraphIndexes: paragraphIndexes.sort((left, right) => left - right),
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

function issueKey(issue) {
  return [
    issue?.source || issue?.sourceAgent || '',
    issue?.category || '',
    Array.isArray(issue?.paragraphIds) ? issue.paragraphIds.join(',') : '',
    compactReviewText(issue?.note || issue?.summary || issue?.detail || '', 140),
  ].join('::');
}

export function mergeReviewIssues(...groups) {
  const out = [];
  const seen = new Set();
  for (const group of groups) {
    for (const issue of Array.isArray(group) ? group : []) {
      if (!issue) continue;
      const key = issueKey(issue);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(issue);
    }
  }
  return out;
}

export function normalizeReviewIssues(rawList, options = {}) {
  return mergeReviewIssues((Array.isArray(rawList) ? rawList : [])
    .map((item, index) => normalizeReviewIssue(item, { ...options, index })));
}

export function isOpenReviewIssue(issue) {
  return !!issue && normalizeStatus(issue.status) === 'open';
}

export function hasBlockingReviewIssues(issues) {
  return (Array.isArray(issues) ? issues : []).some((issue) => (
    isOpenReviewIssue(issue) && issue?.severity !== 'advisory'
  ));
}

export function reviewSourceLabel(source) {
  return REVIEW_LABELS[normalizeReviewSource(source)] || '审查';
}
