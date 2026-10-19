'use strict';

const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { readResource } = require('../mcp/novelResources');
const { completeReadRefs, readIntervals, readResult, successfulReadItems } = require('./readEvidence');

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
  const blocks = [...String(text || '').matchAll(/```(?:json)?\s*\n?([\s\S]*?)```/giu)];
  for (const match of blocks.reverse()) {
    try {
      const value = JSON.parse(match[1].trim());
      if (Array.isArray(value?.issues) && Array.isArray(value?.coveredResourceRefs)) return value;
      if (value && (Object.hasOwn(value, 'issues') || Object.hasOwn(value, 'coveredResourceRefs'))) return null;
    } catch { if (/"(?:issues|coveredResourceRefs)"/u.test(match[1])) return null; }
  }
  return null;
}
function stableIssue(raw) {
  const issueId = String(raw?.issueId || raw?.id || '').trim();
  if (!/^[^:\s]+:[^:\s]+:.+$/u.test(issueId)) return null;
  const evidence = (Array.isArray(raw.evidence) ? raw.evidence : []).map((item) => ({
    resourceRef: String(item?.resourceRef || ''),
    hash: typeof item?.hash === 'string' ? item.hash : null,
    bindReadVersion: !Object.hasOwn(item || {}, 'hash'),
    location: String(item?.location || ''), quote: String(item?.quote || ''),
    ...(Number.isSafeInteger(item?.quoteOffset)?{quoteOffset:item.quoteOffset}:{}),
  })).filter((item) => item.resourceRef && item.quote);
  const requestedSeverity = ['hard', 'suspicion', 'preference'].includes(raw.severity) ? raw.severity : 'suspicion';
  const hardEvidenceValid = requestedSeverity !== 'hard' || (evidence.length > 0 && String(raw.contradiction || '').trim().length > 0);
  return {
    issueId, category: String(raw.category || issueId.split(':')[0]),
    sourceKey:raw.sourceKey || null,
    affectedResourceRefs:[...new Set(Array.isArray(raw.affectedResourceRefs)?raw.affectedResourceRefs:evidence.map(item=>item.resourceRef))],
    severity: hardEvidenceValid ? requestedSeverity : 'suspicion', requestedSeverity,
    schemaValid:['hard','suspicion','preference'].includes(raw.severity)&&['open','closed'].includes(raw.status),
    status: raw.status === 'closed' ? 'closed' : 'open',
    contradiction: String(raw.contradiction || '').slice(0, 1000), evidence,
    resolution: raw.resolution && ['fixed','not_an_issue'].includes(raw.resolution.kind)
      ? {kind:raw.resolution.kind,explanation:String(raw.resolution.explanation||'').trim(),changes:raw.resolution.changes||[]} : null,
    evidenceComplete: Array.isArray(raw.evidence) && evidence.length === raw.evidence.length,
    verified: false,
  };
}
function observedReadRefs(items) {
  return new Set(successfulReadItems(items).map(item => readResult(item).resourceRef).filter(Boolean));
}
async function assessReview(entry, context) {
  const parsed = parseLedgerBlock(context.text);
  const phaseItems = (context.items || []).slice(context.reviewItemOffset || 0);
  const items = successfulReadItems(phaseItems);
  const coverageClaimed = Array.isArray(parsed?.coveredResourceRefs) ? [...new Set(parsed.coveredResourceRefs.map(String))] : [];
  const resources = new Map();
  const declaredIssues = Array.isArray(parsed?.issues) ? parsed.issues : [];
  for (const ref of new Set([...coverageClaimed, ...observedReadRefs(items), ...declaredIssues.flatMap(issue => (issue.evidence || []).map(item => item.resourceRef)),...(context.reviewFindings||[]).flatMap(issue=>issue.evidence.map(item=>item.resourceRef))])) {
    resources.set(ref, await (context.resourceReader || readResource)(entry, ref).catch(() => null));
  }
  const auditTargets=new Set([...(context.taskConstraints?.reviewTargetResourceRefs||[]),...(context.committedResources||context.savedResources||[]).map(item=>item.resourceRef),...(context.reusedSavedResources||[]).map(item=>item.resourceRef)]);
  if(!auditTargets.size && context.taskConstraints?.reviewScope==='observed_resources')for(const ref of observedReadRefs(items))auditTargets.add(ref);
  const auditRequired=context.taskConstraints?.narrativeAuditRequired===true&&[...auditTargets].some(ref=>ref.startsWith('chapter:'));
  const narrativeAudit=auditRequired ? require('./narrativeAudit').assessNarrativeReview(parsed,{
    targets:[...auditTargets],aspects:context.taskConstraints?.intentBinding?.reviewAspects||[],
  }) : null;
  const rawIssues=declaredIssues;
  const issues=rawIssues.map(stableIssue).filter(Boolean);
  const fullyRead = completeReadRefs(items, [...resources.values()].filter(Boolean));
  for (const issue of issues) {
    const previous=(context.reviewFindings||[]).find(item=>item.issueId===issue.issueId);
    if(previous)issue.affectedResourceRefs=previous.affectedResourceRefs || [...new Set(previous.evidence.map(item=>item.resourceRef))];
    const current = issue.evidence.map(item => {
      const resource = resources.get(item.resourceRef);
      // Bind omitted versions to an actual content read in THIS review phase.
      // Never substitute the current store version: that would silently rebase
      // stale evidence. Explicit legacy hashes remain strict, including blanks.
      const latestRead = items.findLast(read => readResult(read)?.resourceRef === item.resourceRef
        && typeof readResult(read)?.content === 'string');
      const boundHash = item.bindReadVersion ? readResult(latestRead || {})?.hash : item.hash;
      if(!item.location || Number.isSafeInteger(item.quoteOffset)) {
        const located=require('./narrativeAudit').locateEvidence(item,resources,items);
        return {...item,location:located?.location || '',hash:boundHash || null,versionSource:item.bindReadVersion?'actual_content_read':'explicit_legacy_hash',
          currentHash:resource?.sourceHash || null,sourceCurrent:!!boundHash&&resource?.sourceHash===boundHash,quoteLocated:!!located,quoteOffset:located?.offset ?? -1,
          observed:!!located,verified:!!located&&!!boundHash&&resource?.sourceHash===boundHash};
      }
      const lineRange = item.location.normalize('NFKC').match(/^(?:第\s*)?(\d+)\s*(?:[-–—~至到]\s*(\d+)\s*)?行$/u)
        || item.location.match(/^L(\d+)(?:[-–—:]L?(\d+))?$/iu);
      const startLine = lineRange ? Number(lineRange[1]) : 0;
      const endLine = lineRange ? Number(lineRange[2] || lineRange[1]) : 0;
      const lines = resource?.content.split('\n') || [];
      const excerpt = startLine > 0 && endLine >= startLine && endLine <= lines.length ? lines.slice(startLine - 1, endLine).join('\n') : '';
      const quoteLocated = !!item.quote && excerpt.includes(item.quote);
      const start = Buffer.byteLength(lines.slice(0, Math.max(0, startLine - 1)).join('\n') + (startLine > 1 ? '\n' : ''), 'utf8');
      const quoteOffset = quoteLocated ? start + Buffer.byteLength(excerpt.slice(0, excerpt.indexOf(item.quote)), 'utf8') : -1;
      const quoteEnd = quoteOffset + Buffer.byteLength(item.quote, 'utf8');
      const observed = !!resource && readIntervals(items, resource).some(([from, to]) => from <= quoteOffset && to >= quoteEnd);
      return { ...item, hash: boundHash || null, versionSource: item.bindReadVersion ? 'actual_content_read' : 'explicit_legacy_hash',
        currentHash: resource?.sourceHash || null, sourceCurrent: !!boundHash && resource?.sourceHash === boundHash,
        quoteLocated, quoteOffset, observed, verified: !!boundHash && quoteLocated && observed && resource?.sourceHash === boundHash };
    });
    issue.evidence = [...new Map(current.map(item=>[`${item.resourceRef}:${item.quoteOffset}:${item.quote}`,item])).values()];
    issue.sourceSnapshots=Object.fromEntries(current.filter(item=>item.verified).map(item=>[item.resourceRef,resources.get(item.resourceRef).content]));
    issue.verified = issue.schemaValid && issue.evidenceComplete && current.length > 0 && current.every(item => item.verified)
      && current.some(item=>issue.affectedResourceRefs.includes(item.resourceRef))
      && (issue.requestedSeverity !== 'hard' || !!issue.contradiction.trim());
    if(issue.requestedSeverity!=='preference'&&issue.status==='closed') {
      const commits=[...(context.committedResources||context.savedResources||[]),...(context.reusedSavedResources||[])];
      // Verify an edit to an original issue anchor, not just any hash change in
      // the same file. The independent review still owns the semantic decision.
      const changed=(issue.resolution?.changes||[]).some(change=>{
        const old=previous?.evidence?.[change.beforeEvidenceIndex];
        const before=previous?.sourceSnapshots?.[old?.resourceRef];
        const source=resources.get(old?.resourceRef);
        if(!old||typeof before!=='string'||!source||change.after?.resourceRef!==old.resourceRef)return false;
        const after=require('./narrativeAudit').locateEvidence(change.after,resources,items);
        if(!after||!commits.some(commit=>commit.resourceRef===old.resourceRef&&commit.newHash===source.sourceHash))return false;
        const engine=new (require('diff-match-patch'))();
        const diffs=engine.diff_main(before,source.content);engine.diff_cleanupSemantic(diffs);
        const start=Number.isSafeInteger(old.quoteOffset)?Buffer.from(before).subarray(0,old.quoteOffset).toString('utf8').length:before.indexOf(old.quote);
        if(start<0)return false;
        const from=engine.diff_xIndex(diffs,start),to=engine.diff_xIndex(diffs,start+old.quote.length);
        const quoteStart=Buffer.from(source.content).subarray(0,after.offset).toString('utf8').length;
        return source.content.slice(from,to)!==old.quote && quoteStart<=to && quoteStart+after.quote.length>=from;
      });
      const alreadyResolved=previous?.status==='closed'&&previous.resolutionVerified&&current.every(evidence=>previous.evidence.some(old=>old.resourceRef===evidence.resourceRef&&old.hash===evidence.hash&&old.location===evidence.location&&old.quote===evidence.quote));
      issue.resolutionVerified=!!issue.resolution?.explanation && (alreadyResolved||context.resolutionAuthority==='independent_review'&&!!previous&&(issue.resolution.kind==='not_an_issue'||changed));
      issue.resolutionAssessment=issue.resolutionVerified?'independent_model_assessed':'not_accepted';
      issue.verified=issue.verified&&issue.resolutionVerified;
    }
    if (!issue.verified && issue.requestedSeverity === 'hard') issue.severity = 'suspicion';
  }
  const observed = observedReadRefs(phaseItems);
  const coverageHashes = [...resources].map(([resourceRef, resource]) => ({ resourceRef, hash: resource?.sourceHash || null }));
  const versionCurrent = !context.expectedCoverageHashes || context.expectedCoverageHashes.every(item => resources.get(item.resourceRef)?.sourceHash === item.hash);
  const row = {
    type: 'review_recorded', taskId: context.taskId, attemptId: context.attemptId,
    runId: context.runId, reportSha256: crypto.createHash('sha256').update(String(context.text || '')).digest('hex'),
    parsed: !!parsed, coverageClaimed, coverageObserved: [...observed], coverageHashes, versionCurrent,
    narrativeAudit,
    invalidatedIssueIds:(context.reviewFindings||[]).filter(issue=>issue.status==='closed'&&issue.evidence.some(item=>resources.get(item.resourceRef)?.sourceHash!==item.hash)).map(issue=>issue.issueId),
    coverageVerified: versionCurrent && !!parsed && coverageClaimed.length > 0 && coverageClaimed.every(resourceRef => fullyRead.has(resourceRef)),
    evidenceVerified: versionCurrent && !!parsed && issues.length === rawIssues.length && new Set(issues.map(issue => issue.issueId)).size === issues.length
      && issues.every(issue => issue.schemaValid && (issue.requestedSeverity === 'preference' || issue.verified)),
    issues,
  };
  return row;
}
function mergeReviewFindings(previous,review) {
  const findings=new Map((previous||[]).map(issue=>[issue.issueId,review?.invalidatedIssueIds?.includes(issue.issueId)?{...issue,status:'open',resolutionVerified:false,invalidated:true}:issue]));
  if(review?.versionCurrent!==false&&review?.parsed&&review?.evidenceVerified)for(const issue of review.issues||[]) {
    if(!issue.verified)continue;
    const prior=findings.get(issue.issueId);
    if(prior?.requestedSeverity==='hard'&&issue.requestedSeverity!=='hard')continue;
    if(prior?.requestedSeverity==='suspicion'&&issue.requestedSeverity==='preference')continue;
    findings.set(issue.issueId,{...issue,affectedResourceRefs:prior?.affectedResourceRefs||issue.affectedResourceRefs});
  }
  return [...findings.values()];
}
async function recordReview(entry, context) {
  const row = await assessReview(entry, context);
  await append(entry, row);
  return row;
}
async function invalidateForResources(entry, resources) {
  const changed = new Set((resources || []).map((item) => item.resourceRef));
  if (!changed.size) return [];
  let rows = [];
  try { rows = (await fsp.readFile(fileFor(entry), 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)); } catch { return []; }
  const latest = new Map();
  for (const row of rows) {
    for (const issue of row.issues || []) latest.set(issue.issueId, issue);
    if (row.type === 'review_issue_invalidated') latest.delete(row.issueId);
  }
  const invalidated = [...latest.values()].filter((issue) => issue.status === 'open' && issue.evidence?.some((item) => changed.has(item.resourceRef))).map((issue) => issue.issueId);
  for (const issueId of invalidated) await append(entry, { type: 'review_issue_invalidated', issueId, changedResourceRefs: [...changed] });
  return invalidated;
}

module.exports = { fileFor, invalidateForResources, observedReadRefs, parseLedgerBlock, assessReview, recordReview, stableIssue, mergeReviewFindings };
