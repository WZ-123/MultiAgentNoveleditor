'use strict';

const { normalizeTaskConstraints } = require('./taskLedger');
const { bodyChineseCharacterCount, listResourceDescriptors, proseRepetitionEvidence, readResource } = require('../mcp/novelResources');
const { observedReadRefs } = require('./reviewLedger');

function readResult(item) {
  if (item.result?.structuredContent) return item.result.structuredContent;
  try { return JSON.parse((item.result?.content || []).filter(block => block.type === 'text').map(block => block.text).join('\n')); }
  catch { return null; }
}

function completeReadRefs(items, resources) {
  const covered = new Set();
  for (const resource of resources) {
    const intervals = [];
    for (const item of items) {
      const value = readResult(item);
      if (!value || value.resourceRef !== resource.resourceRef || value.hash !== resource.sourceHash || value.mode !== 'content' || typeof value.content !== 'string') continue;
      let start = Number(value.offset || 0);
      let end = start + Buffer.byteLength(value.content, 'utf8');
      if (value.startLine != null) {
        const lines = resource.content.split('\n');
        start = Buffer.byteLength(lines.slice(0, value.startLine - 1).join('\n') + (value.startLine > 1 ? '\n' : ''), 'utf8');
        end = start + Buffer.byteLength(value.content, 'utf8') + (value.endLine < lines.length ? 1 : 0);
      }
      if (Number.isSafeInteger(start) && start >= 0 && end >= start) intervals.push([start, end]);
    }
    let end = 0;
    for (const interval of intervals.sort((left, right) => left[0] - right[0])) {
      if (interval[0] > end) break;
      end = Math.max(end, interval[1]);
    }
    if (intervals.length && end >= Buffer.byteLength(resource.content, 'utf8')) covered.add(resource.resourceRef);
  }
  return covered;
}

async function currentResource(entry, resourceRef) {
  try { return { resource: await readResource(entry, resourceRef), missing: false }; }
  catch (error) { return { resource: null, missing: error.code === 'ENOENT' || (error.code === 'context_incomplete' && error.message.startsWith('novel resource does not exist:')) }; }
}

function wordCountCheck(actual, constraints) {
  const minimum = constraints.minBodyCjk;
  const maximum = constraints.maxBodyCjk;
  const toleranceRatio = constraints.wordCountToleranceRatio;
  const acceptedMinimum = minimum == null ? null : Math.ceil(minimum * (1 - toleranceRatio));
  const acceptedMaximum = maximum == null ? null : Math.floor(maximum * (1 + toleranceRatio));
  const status = acceptedMinimum != null && actual < acceptedMinimum ? 'below_target'
    : acceptedMaximum != null && actual > acceptedMaximum ? 'over_target'
      : minimum != null || maximum != null ? 'met' : 'not_requested';
  return { status, blocking: false, actual, minimum, maximum, toleranceRatio, acceptedMinimum, acceptedMaximum,
    withinTolerance: status === 'met', belowBy: Math.max(0, (minimum ?? actual) - actual), aboveBy: Math.max(0, actual - (maximum ?? actual)) };
}

async function evaluateTaskResult(run, modelTurnCompleted) {
  const constraints = normalizeTaskConstraints(run.taskConstraints);
  const savedResources = run.committedResources || [];
  const reusedSavedResources = run.reusedSavedResources || [];
  const result = {
    schemaVersion: 2, modelTurnCompleted, goalVerified: false, goalStatus: 'unverified', constraints, savedResources,
    reusedSavedResources, continuedFromRunId: run.continuedFromRunId || null,
    execution: { status: modelTurnCompleted ? 'completed' : run.interruptionRequested ? 'interrupted' : 'incomplete' },
    persistence: { status: savedResources.length ? (modelTurnCompleted ? 'saved' : 'partial') : 'no_changes', committedCount: savedResources.length },
    objective: { status: 'not_evaluated', unmet: [] },
    contentReview: { ending: { status: constraints.requiresCompleteEnding ? 'required_not_evaluated' : 'not_evaluated' },
      plotProgression: { status: 'not_evaluated' }, characterConsistency: { status: 'not_evaluated' }, style: { status: 'not_evaluated' } },
  };
  if (!run.entry) return result;
  const wordTarget = constraints.minBodyCjk != null || constraints.maxBodyCjk != null;
  const explicitRefs = constraints.targetResourceRefs;
  const allCommits = [...reusedSavedResources, ...savedResources];
  const commitByRef = new Map(allCommits.map(resource => [resource.resourceRef, resource]));
  const readItems = (run.items || []).filter(item => item.status === 'completed' && !item.error && item.result?.isError !== true && /read_novel_resource/u.test(String(item.tool || item.toolName || item.name || '')));
  const observed = observedReadRefs(readItems.map(item => ({ name: item.tool || item.toolName || item.name, arguments: item.arguments || item.args || item.input, status: item.status })));
  let refs = explicitRefs;
  if (wordTarget) {
    if (constraints.wordCountScope === 'whole_novel') {
      refs = (await listResourceDescriptors(run.entry)).filter(item => item.kind === 'chapter').map(item => item.resourceRef);
    } else if (constraints.wordCountScope === 'target_resources') {
      refs = explicitRefs;
    } else if (constraints.wordCountScope === 'new_writing' && constraints.wordCountResourceRefs.length) {
      // Continuations retain the original writing target, not arbitrary later edits.
      refs = constraints.wordCountResourceRefs;
    } else {
      const created = new Set(allCommits.filter(item => item.mode === 'create').map(item => item.resourceRef));
      refs = [...commitByRef.keys()].filter(ref => ref.startsWith('chapter:')
        && commitByRef.get(ref).mode !== 'delete'
        && (constraints.wordCountScope !== 'new_writing' || created.has(ref)));
      // Persist the binding in the task result, including after an interrupted turn.
      if (constraints.wordCountScope === 'new_writing') constraints.wordCountResourceRefs = refs;
    }
  } else if (!refs.length) {
    refs = ['read', 'review'].includes(constraints.operation) ? [...observed]
      : [...commitByRef.keys()].filter(ref => commitByRef.get(ref).mode !== 'delete');
  }
  const states = new Map(await Promise.all([...new Set([...refs, ...commitByRef.keys()])].map(async ref => [ref, await currentResource(run.entry, ref)])));
  const resources = refs.map(ref => states.get(ref).resource);
  const readable = resources.filter(Boolean);
  const currentCommits = [];
  for (const [resourceRef, commit] of commitByRef) {
    const { resource: current, missing } = states.get(resourceRef);
    // Saved evidence remains visible, but only matching formal hashes count towards completion.
    if (commit.mode === 'delete' ? missing : current && commit.newHash && current.sourceHash === commit.newHash) currentCommits.push(commit);
  }
  const currentSaved = new Set(currentCommits.map(resource => resource.resourceRef));
  const fullyRead = completeReadRefs(readItems, readable);
  const countResources = wordTarget && ['new_writing', 'saved_resources'].includes(constraints.wordCountScope)
    ? readable.filter(resource => currentSaved.has(resource.resourceRef)) : readable;
  result.evidence = { wordCountScope: constraints.wordCountScope, targetResourceRefs: refs, readableResources: readable.length,
    bodyChineseCharacterCount: countResources.reduce((sum, resource) => sum + bodyChineseCharacterCount(resource.content), 0),
    hashes: readable.map(resource => ({ resourceRef: resource.resourceRef, hash: resource.sourceHash })),
    currentSavedResourceRefs: [...currentSaved], observedReadResourceRefs: [...observed], fullyReadResourceRefs: [...fullyRead] };
  result.checks = { wordCount: wordCountCheck(result.evidence.bodyChineseCharacterCount, constraints) };
  if (constraints.prohibitRepetition) {
    result.evidence.repetition = proseRepetitionEvidence(readable.map(resource => ({ resourceRef: resource.resourceRef, hash: resource.sourceHash, content: resource.content })));
    result.checks.repetition = { status: 'evidence_only', qualityConclusion: 'not_evaluated', actual: result.evidence.repetition.repeatedOccurrenceRatio };
  }
  const unmet = result.objective.unmet;
  if (resources.some((resource, index) => !resource && !(commitByRef.get(refs[index])?.mode === 'delete' && currentSaved.has(refs[index])))) unmet.push('target_unreadable');
  if (wordTarget && !refs.length) unmet.push('word_count_target_missing');
  if (wordTarget && result.checks.wordCount.status !== 'met') unmet.push('word_count');
  const mutationRequested = ['write', 'edit', 'outline'].includes(constraints.operation) || (constraints.operation === 'unspecified' && (wordTarget || commitByRef.size > 0));
  const verifiable = mutationRequested || wordTarget || ['read', 'review'].includes(constraints.operation);
  if (mutationRequested) {
    if (!currentCommits.length) unmet.push('no_current_commit');
    if ([...explicitRefs, ...constraints.wordCountResourceRefs].some(ref => !currentSaved.has(ref))) unmet.push('targets_not_saved');
    if (currentCommits.length !== commitByRef.size) unmet.push('saved_version_changed');
  }
  if (constraints.operation === 'read' || constraints.operation === 'review') {
    if (!fullyRead.size || refs.some(ref => !fullyRead.has(ref))) unmet.push('read_evidence_missing');
    if (constraints.operation === 'review') {
      result.evidence.reviewRecord = run.reviewRecord || null;
      if (!run.reviewRecord?.coverageVerified || explicitRefs.some(ref => !run.reviewRecord.coverageClaimed?.includes(ref)) || !String(run.text || '').trim()) unmet.push('review_report_missing');
    }
  }
  if (!modelTurnCompleted) unmet.push('turn_not_completed');
  result.objective.status = !verifiable ? 'not_evaluated' : unmet.length ? 'incomplete' : 'met';
  result.goalStatus = result.objective.status === 'met' ? (constraints.requiresCompleteEnding ? 'awaiting-review' : 'completed')
    : result.objective.status === 'incomplete' ? 'incomplete' : 'unverified';
  result.goalVerified = result.goalStatus === 'completed';
  return result;
}

module.exports = { evaluateTaskResult, wordCountCheck };
