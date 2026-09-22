'use strict';

const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { readResource } = require('../mcp/novelResources');

const queues = new Map();
function fileFor(entry) { return path.join(entry.dir, '.mana', 'review-ledger.jsonl'); }
function append(entry, row) {
  const file = fileFor(entry);
  const pending = (queues.get(file) || Promise.resolve()).then(async () => {
    await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await fsp.appendFile(file, `${JSON.stringify({ schemaVersion: 1, eventId: crypto.randomUUID(), timestamp: new Date().toISOString(), ...row })}\n`, { encoding: 'utf8', mode: 0o600 });
  });
  queues.set(file, pending.catch(() => {}));
  return pending;
}
function parseLedgerBlock(text) {
  const match = String(text || '').match(/```(?:json)?\s*\n?([\s\S]*?"issues"[\s\S]*?)```/iu);
  if (!match) return null;
  try { return JSON.parse(match[1].trim()); } catch { return null; }
}
function stableIssue(raw) {
  const issueId = String(raw?.issueId || raw?.id || '').trim();
  if (!/^[^:\s]+:[^:\s]+:.+$/u.test(issueId)) return null;
  const evidence = (Array.isArray(raw.evidence) ? raw.evidence : []).map((item) => ({
    resourceRef: String(item?.resourceRef || ''), hash: String(item?.hash || ''),
    location: String(item?.location || ''), quote: String(item?.quote || '').slice(0, 500),
  })).filter((item) => item.resourceRef && item.hash && item.location);
  const requestedSeverity = ['hard', 'suspicion', 'preference'].includes(raw.severity) ? raw.severity : 'suspicion';
  const hardEvidenceValid = requestedSeverity !== 'hard' || (evidence.length >= 2 && String(raw.contradiction || '').trim().length > 0);
  return {
    issueId, category: String(raw.category || issueId.split(':')[0]),
    severity: hardEvidenceValid ? requestedSeverity : 'suspicion', requestedSeverity,
    status: raw.status === 'closed' ? 'closed' : 'open',
    contradiction: String(raw.contradiction || '').slice(0, 1000), evidence,
    verified: hardEvidenceValid,
  };
}
function observedReadRefs(items) {
  const refs = new Set();
  const visit = (value) => {
    if (!value || typeof value !== 'object') return;
    const name = String(value.name || value.toolName || value.tool || '');
    if (name.includes('read_novel_resource') && value.status !== 'failed') {
      let args = value.arguments || value.args || value.input || {};
      if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
      if (typeof args?.resourceRef === 'string') refs.add(args.resourceRef);
    }
    for (const child of Array.isArray(value) ? value : Object.values(value)) visit(child);
  };
  visit(items);
  return refs;
}
async function recordReview(entry, context) {
  const parsed = parseLedgerBlock(context.text);
  const issues = (Array.isArray(parsed?.issues) ? parsed.issues : []).map(stableIssue).filter(Boolean);
  for (const issue of issues) {
    const current = await Promise.all(issue.evidence.map(async (item) => {
      const resource = await readResource(entry, item.resourceRef).catch(() => null);
      return { ...item, currentHash: resource?.sourceHash || null, sourceCurrent: resource?.sourceHash === item.hash };
    }));
    issue.evidence = current;
    if (current.some((item) => !item.sourceCurrent)) issue.verified = false;
  }
  const coverageClaimed = Array.isArray(parsed?.coveredResourceRefs) ? [...new Set(parsed.coveredResourceRefs.map(String))] : [];
  const observed = observedReadRefs(context.items || []);
  const row = {
    type: 'review_recorded', taskId: context.taskId, attemptId: context.attemptId,
    runId: context.runId, reportSha256: crypto.createHash('sha256').update(String(context.text || '')).digest('hex'),
    parsed: !!parsed, coverageClaimed, coverageObserved: [...observed],
    coverageVerified: !!parsed && coverageClaimed.length > 0 && coverageClaimed.every((resourceRef) => observed.has(resourceRef)),
    issues,
  };
  await append(entry, row);
  return row;
}
async function invalidateForResources(entry, resources) {
  const changed = new Set((resources || []).map((item) => item.resourceRef));
  if (!changed.size) return [];
  let rows = [];
  try { rows = (await fsp.readFile(fileFor(entry), 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)); } catch { return []; }
  const latest = new Map();
  for (const row of rows) for (const issue of row.issues || []) latest.set(issue.issueId, issue);
  for (const row of rows.filter((item) => item.type === 'review_issue_invalidated')) latest.delete(row.issueId);
  const invalidated = [...latest.values()].filter((issue) => issue.status === 'open' && issue.evidence?.some((item) => changed.has(item.resourceRef))).map((issue) => issue.issueId);
  for (const issueId of invalidated) await append(entry, { type: 'review_issue_invalidated', issueId, changedResourceRefs: [...changed] });
  return invalidated;
}

module.exports = { fileFor, invalidateForResources, observedReadRefs, parseLedgerBlock, recordReview, stableIssue };
