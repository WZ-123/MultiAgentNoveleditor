'use strict';

const { normalizeTaskConstraints } = require('./taskLedger');
const { bodyChineseCharacterCount, listResourceDescriptors, proseRepetitionEvidence, readResource } = require('../mcp/novelResources');
const { observedReadRefs } = require('./reviewLedger');

const { completeReadRefs, successfulReadItems } = require('./readEvidence');

async function currentResource(entry, resourceRef) {
  try { return { resource: await readResource(entry, resourceRef), missing: false }; }
  catch (error) { return { resource: null, missing: error.code === 'ENOENT' || error.details?.reason === 'resource_not_found' }; }
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
  const readItems = successfulReadItems(run.items);
  const observed = observedReadRefs(readItems);
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
    refs = ['read', 'review'].includes(constraints.operation) && constraints.wordCountScope === 'whole_novel'
      ? (await listResourceDescriptors(run.entry)).filter(item => item.kind === 'chapter').map(item => item.resourceRef)
      : ['read', 'review'].includes(constraints.operation) ? [...observed]
      : [...commitByRef.keys()].filter(ref => commitByRef.get(ref).mode !== 'delete');
  }
  const states = new Map(await Promise.all([...new Set([...refs, ...commitByRef.keys(), ...constraints.requiredWriteResourceRefs])].map(async ref => [ref, await currentResource(run.entry, ref)])));
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
  const requiredReadResources=await Promise.all(constraints.requiredReadResourceRefs.map(async ref=>(await currentResource(run.entry,ref)).resource));
  const sourceReadItems=['write','edit','roleplay'].includes(constraints.operation)?readItems.filter(item=>item.type!=='reviewSourceDelivery'):readItems;
  const requiredRead=completeReadRefs(sourceReadItems,requiredReadResources.filter(Boolean));
  if(['write','edit','roleplay'].includes(constraints.operation))for(const ref of require('./readEvidence').readBeforeOwnWrites(sourceReadItems,allCommits))requiredRead.add(ref);
  const countResources = wordTarget && ['new_writing', 'saved_resources'].includes(constraints.wordCountScope)
    ? readable.filter(resource => currentSaved.has(resource.resourceRef)) : readable;
  result.evidence = { wordCountScope: constraints.wordCountScope, targetResourceRefs: refs, readableResources: readable.length,
    bodyChineseCharacterCount: countResources.reduce((sum, resource) => sum + bodyChineseCharacterCount(resource.content), 0),
    hashes: readable.map(resource => ({ resourceRef: resource.resourceRef, hash: resource.sourceHash })),
    currentSavedResourceRefs: [...currentSaved], observedReadResourceRefs: [...observed], fullyReadResourceRefs: [...fullyRead] };
  result.checks = { wordCount: wordCountCheck(result.evidence.bodyChineseCharacterCount, constraints) };
  if(constraints.memoryUpdateRequired)result.checks.memoryScope={status:constraints.memoryScopeBound?'bound':'unbound',participantCharacterRefs:constraints.participantCharacterRefs};
  if(constraints.requiredWriteResourceRefs.length) result.checks.requiredWrites={expectedResourceRefs:constraints.requiredWriteResourceRefs,missingResourceRefs:constraints.requiredWriteResourceRefs.filter(ref=>!currentSaved.has(ref))};
  if (constraints.atomicMemoryWithChapter) {
    const batches = new Map();
    for (const commit of allCommits) if (commit.nativeItemId && commit.mode !== 'delete') {
      if (!batches.has(commit.nativeItemId)) batches.set(commit.nativeItemId, new Set());
      batches.get(commit.nativeItemId).add(commit.resourceRef);
      // A continuation retains latest per-resource versions. Host receipts keep
      // the original atomic batch provable after a later chapter-only revision.
      for (const ref of commit.nativeBatchResourceRefs || []) batches.get(commit.nativeItemId).add(ref);
    }
    const combined = [...batches.values()].some(refs => [...refs].some(ref => ref.startsWith('chapter:')) && constraints.requiredWriteResourceRefs.every(ref => refs.has(ref)));
    result.checks.combinedMemoryCommit = {status:combined ? 'met' : 'missing'};
  }
  if (run.nativeValidationErrors?.length) result.checks.nativeValidation = { errors: run.nativeValidationErrors };
  if (constraints.prohibitRepetition) {
    result.evidence.repetition = proseRepetitionEvidence(readable.map(resource => ({ resourceRef: resource.resourceRef, hash: resource.sourceHash, content: resource.content })));
    result.checks.repetition = { status: 'evidence_only', qualityConclusion: 'not_evaluated', actual: result.evidence.repetition.repeatedOccurrenceRatio };
  }
  const unmet = result.objective.unmet;
  if(run.preparationStage) {
    result.checks.preparationStage={phase:run.preparationStage.phase,candidate:run.preparationStage.candidate,error:run.preparationStage.error||null};
    if(run.preparationStage.phase!=='readback_complete')unmet.push('prepared_candidate_not_committed');
  }
  result.checks.requiredReads={expectedResourceRefs:constraints.requiredReadResourceRefs,missingResourceRefs:constraints.requiredReadResourceRefs.filter(ref=>!requiredRead.has(ref))};
  if(result.checks.requiredReads.missingResourceRefs.length)unmet.push('required_reads_missing');
  try {
    require('./writingScope').assertWriteScope({...constraints,memoryUpdateRequired:false},[...currentSaved]);
    result.checks.writeScope={status:'met'};
  } catch(error) {
    result.checks.writeScope={status:'conflict',message:error.message};
    unmet.push('write_scope_violation');
  }
  if(constraints.memoryUpdateRequired&&!constraints.memoryScopeBound)unmet.push('memory_scope_unbound');
  if (result.checks.combinedMemoryCommit?.status === 'missing') unmet.push('combined_memory_commit_missing');
  if (resources.some((resource, index) => !resource && !(commitByRef.get(refs[index])?.mode === 'delete' && currentSaved.has(refs[index])))) unmet.push('target_unreadable');
  if (wordTarget && !refs.length) unmet.push('word_count_target_missing');
  if (wordTarget && result.checks.wordCount.status !== 'met') unmet.push('word_count');
  const mutationRequested = ['write', 'edit', 'outline'].includes(constraints.operation) || commitByRef.size > 0 || constraints.requiredWriteResourceRefs.length>0 || (constraints.operation === 'unspecified' && wordTarget);
  const verifiable = mutationRequested || wordTarget || constraints.reviewRequired || ['read', 'review'].includes(constraints.operation);
  if (mutationRequested) {
    if (!currentCommits.length) unmet.push('no_current_commit');
    if ([...explicitRefs, ...constraints.wordCountResourceRefs].some(ref => !currentSaved.has(ref))) unmet.push('targets_not_saved');
    if(result.checks.requiredWrites?.missingResourceRefs.length) unmet.push('required_writes_missing');
    if (currentCommits.length !== commitByRef.size) unmet.push('saved_version_changed');
  }
  if (constraints.operation === 'read' || constraints.operation === 'review') {
    if (!fullyRead.size || refs.some(ref => !fullyRead.has(ref))) unmet.push('read_evidence_missing');
  }
  if (constraints.reviewRequired) {
    const expected = new Set(constraints.reviewTargetResourceRefs);
    // A compound writing/review request always includes what was actually saved,
    // even when its natural-language review target could not be bound up front.
    if (mutationRequested) for (const commit of currentCommits) if (commit.mode !== 'delete') expected.add(commit.resourceRef);
    if (constraints.reviewScope === 'whole_novel') {
      if (!constraints.reviewScopeBound) for (const item of await listResourceDescriptors(run.entry)) if (item.kind === 'chapter') expected.add(item.resourceRef);
      for (const commit of currentCommits) if (commit.mode !== 'delete') expected.add(commit.resourceRef);
    } else if (constraints.reviewScope === 'saved_resources') {
      for (const commit of currentCommits) if (commit.mode !== 'delete') expected.add(commit.resourceRef);
    } else if (constraints.reviewScope === 'target_resources') for (const ref of explicitRefs) expected.add(ref);
    else for (const ref of observed) expected.add(ref);
    const reviewReads=successfulReadItems((run.items || []).slice(run.reviewItemOffset || 0));
    // Target coverage and source reading are different contracts. A source
    // actually read in full can support a local review without a claim that
    // the entire source itself was reviewed for every possible problem.
    const reviewResources = await Promise.all([...new Set([...expected, ...(run.reviewRecord?.coverageClaimed || []),...observedReadRefs(reviewReads)])].map(async ref => (await currentResource(run.entry, ref)).resource));
    const fullyReviewed = completeReadRefs(successfulReadItems((run.items || []).slice(run.reviewItemOffset || 0)), reviewResources.filter(Boolean));
    const review = run.reviewRecord;
    const missing = [...expected].filter(ref => !fullyReviewed.has(ref) || !review?.coverageClaimed?.includes(ref));
    const evidenceCurrent = review?.coverageClaimed?.every(ref => fullyReviewed.has(ref));
    const missingSourceKinds = constraints.reviewSourceKinds.filter(kind => !reviewResources.some(resource => resource?.kind === kind && fullyReviewed.has(resource.resourceRef)));
    const accepted = expected.size > 0 && !!review?.coverageVerified && evidenceCurrent && !missing.length && !missingSourceKinds.length && review.evidenceVerified !== false && !!String(run.text || '').trim();
    result.evidence.reviewRecord = review || null;
    if(constraints.narrativeAuditRequired&&[...expected].some(ref=>ref.startsWith('chapter:'))) {
      result.checks.narrativeAudit=review?.narrativeAudit || {status:'missing',errors:['analysis_missing']};
      result.checks.narrativeAudit.origin=run.reviewSubmission?.origin || 'unattested';
      result.checks.narrativeAudit.modelId=run.narrativeReview?.modelId || null;
      if(run.narrativeReview?.status==='failed')Object.assign(result.checks.narrativeAudit,{status:'failed',error:run.narrativeReview.error});
      if(run.reviewSubmission?.origin!=='host_readonly_analysis')unmet.push(run.narrativeReview?.status==='failed'?'narrative_review_failed':'narrative_review_not_run');
      if(result.checks.narrativeAudit.status!=='reported')unmet.push('narrative_review_incomplete');
    }
    result.checks.review = { status: accepted ? 'completed' : 'incomplete', expectedResourceRefs: [...expected], missingResourceRefs: missing,
      evidenceVerified: review?.evidenceVerified === true, qualityConclusion: 'not_evaluated' };
    result.checks.review.reportStatus = !review?.parsed ? 'missing_or_invalid' : review.evidenceVerified === false ? 'invalid_evidence' : 'recorded';
    result.checks.review.incompleteCoverageRefs = (review?.coverageClaimed || []).filter(ref=>!fullyReviewed.has(ref));
    result.checks.review.unverifiedEvidence = (review?.issues || []).flatMap(issue => issue.evidence.filter(item => !item.verified).map(item => ({
      issueId: issue.issueId, resourceRef: item.resourceRef, location: item.location,
      reason: !item.sourceCurrent ? 'source_changed' : !item.quoteLocated ? 'quote_not_at_location' : !item.observed ? 'source_not_read' : 'invalid_evidence',
    })));
    result.checks.review.missingSourceKinds = missingSourceKinds;
    result.checks.review.invalidIssueIds=(review?.issues||[]).filter(issue=>issue.schemaValid===false).map(issue=>issue.issueId);
    const findings=require('./reviewLedger').mergeReviewFindings(run.reviewFindings,review);
    const blocking=findings.filter(issue=>issue.status==='open'&&(issue.affectedResourceRefs||issue.evidence.map(item=>item.resourceRef)).some(ref=>expected.has(ref))
      && issue.requestedSeverity==='hard');
    result.checks.semanticReview={status:!accepted?'unverified':blocking.length?'open_hard_issues':'reported',qualityConclusion:'model_reported',
      repairRequired:constraints.repairRequired,blockingIssues:constraints.repairRequired?blocking:[],reportedIssues:findings};
    if(constraints.repairRequired&&blocking.some(issue=>issue.requestedSeverity==='hard'))unmet.push('hard_issues_unresolved');
    if (!accepted) unmet.push('review_evidence_missing');
  }
  if (!modelTurnCompleted) unmet.push('turn_not_completed');
  result.objective.status = !verifiable ? 'not_evaluated' : unmet.length ? 'incomplete' : 'met';
  result.goalStatus = result.objective.status === 'met' ? (constraints.requiresCompleteEnding ? 'awaiting-review' : 'completed')
    : result.objective.status === 'incomplete' ? 'incomplete' : 'unverified';
  result.goalVerified = result.goalStatus === 'completed';
  return result;
}

module.exports = { evaluateTaskResult, wordCountCheck };
