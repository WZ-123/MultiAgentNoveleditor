'use strict';

// A small handoff adapter for the existing run, one-shot executor and patch
// preparation tool. No candidate store, scheduler, approval or writer lives here.
const { contractError, hash } = require('./contracts');
const runs = require('../store/chatRuns');
const { readResource } = require('../mcp/novelResources');

async function prepareStage(service, run, { text, outputSchema, reviewCandidate=false, allowRevision=false }) {
  if (run.turnId || run.preparationStage) throw contractError('候选阶段只能在原生提交开始前执行一次', 'preparation_stage_started');
  const stage = run.preparationStage = { version: allowRevision||reviewCandidate?2:1, revision: 1, phase: 'preparing', execution: null, candidate: null };
  const controller = new AbortController();
  let expectedRevision=1;
  service.intentControllers.set(run.runId, controller);
  const assertCurrent = () => {
    if (controller.signal.aborted || run.interruptionRequested) throw contractError('候选阶段已停止', 'turn_interrupted');
    if (run.preparationStage !== stage || stage.revision !== expectedRevision) throw contractError('候选阶段结果已过期', 'preparation_stage_stale');
  };
  const transition=async phase=>{
    assertCurrent();stage.phase=phase;expectedRevision=++stage.revision;
    await service._checkpointRun(run.runId);assertCurrent();
    service._emitEvent({type:'writing_stage_changed',runId:run.runId,conversationId:run.conversationId});
  };
  try {
    await service._checkpointRun(run.runId);
    service._emitEvent({type:'writing_preparation_started',runId:run.runId,conversationId:run.conversationId});
    assertCurrent();
    const context=await require('./writingContext').buildWritingContext(run.entry,run,{includeDefaults:true});
    assertCurrent();
    stage.dependencies=require('./writingContext').contextResources(context).map(source=>({resourceRef:source.resourceRef,hash:source.exists===false?null:source.hash}));
    const result = await service.runOneShot({ text:text+'\n'+JSON.stringify(context), outputSchema, readOnly: true, purpose: 'writing_preparation', parentRunId: run.runId, route: run.route, abortSignal: controller.signal,
      onStarted: async execution => {
        assertCurrent();
        stage.execution = execution;
        run.items.push(...require('./writingContext').contextResources(context).filter(source=>source.exists!==false).map(source=>({type:'writingSourceDelivery',origin:'host',purpose:'writing_preparation',executionRunId:execution.runId,id:execution.runId+':'+source.resourceRef,status:'completed',result:{structuredContent:source}})));
        await service._checkpointRun(run.runId);
        assertCurrent();
      } });
    assertCurrent();
    let authored = JSON.parse(result.text);
    const normalizeParticipants=value=>{
      if(Array.isArray(value.participantCharacterRefs)&&!value.participantCharacterRefs.length&&!run.taskConstraints.participantScopeFixed&&!run.taskConstraints.memoryUpdateRequired)delete value.participantCharacterRefs;
      return value;
    };
    normalizeParticipants(authored);
    const sources=require('./writingContext').contextResources(context);
    if(Array.isArray(authored.changes))authored.changes=authored.changes.map(change=>{
      const source=sources.find(source=>source.resourceRef===change.resourceRef&&source.exists!==false);
      return {...change,...(source?.hash?{baseHash:source.hash}:{})};
    });
    // The same implementation assembles, canonicalizes, binds versions and
    // persists candidates whether called from MCP or from a host stage.
    let candidate = await require('../mcp/writingTools').prepareNovelPatch(authored, { expectedRunId: run.runId, novel: run.entry, novelDir: run.entry.dir });
    assertCurrent();
    run.taskConstraints=await require('./writingScope').bindCandidateScope(run.entry,run.taskConstraints,{participantCharacterRefs:authored.participantCharacterRefs,resourceRefs:authored.changes.map(change=>change.resourceRef)});
    if(candidate.taskScope?.narrativePerspective)run.taskConstraints.narrativePerspective=candidate.taskScope.narrativePerspective;
    stage.candidate = { preparationId: candidate.preparationId, revision: candidate.preparationRevision };
    let candidateFindings=run.reviewFindings||[];
    const examine=async()=>{
      await assertDependencies(run);assertCurrent();
      if(!reviewCandidate)return null;
      await transition('reviewing');
      const reviewed=await require('./narrativeReviewJobs').reviewCandidate(service,run,await materialFor(run),{signal:controller.signal,assertCurrent,priorFindings:candidateFindings,onStarted:async execution=>{
        assertCurrent();stage.executions=[...(stage.executions||[]),execution];await service._checkpointRun(run.runId);assertCurrent();
      }});
      await assertDependencies(run);assertCurrent();
      candidateFindings=reviewed.findings;
      run.reviewFindings=candidateFindings;
      run.items.push({type:'writingCandidateReview',origin:'host',id:'candidate-review:'+candidate.preparationId+':'+candidate.preparationRevision,status:'completed',result:{structuredContent:{preparationId:candidate.preparationId,revision:candidate.preparationRevision,report:reviewed.report,wordCount:candidate.candidateChecks.wordCount}}});
      return reviewed;
    };
    let reviewed=candidate.preparedOnly?await examine():null;
    const wordCount=candidate.candidateChecks?.wordCount;
    const needsLengthRevision=wordCount&&['below_target','over_target'].includes(wordCount.status);
    const hardIssues=candidateFindings.filter(issue=>issue.status==='open'&&issue.requestedSeverity==='hard');
    if(allowRevision&&(!candidate.preparedOnly||needsLengthRevision||run.taskConstraints.repairRequired&&hardIssues.length)) {
      await transition('revising');
      const material=await materialFor(run);
      const suggestedBodyCjk=wordCount?.minimum!=null?Math.round((wordCount.minimum+(wordCount.maximum??wordCount.minimum))/2):wordCount?.maximum;
      const revision=await service.runOneShot({text:'针对候选的具体缺项执行一次定向修订（writing_revision），不执行工具、不写文件。输出与原候选相同 schema 的完整 changes，保留全部资源及原任务范围，只修正下列缺项；不是重新起稿。记忆应与最终正文一致，仍只追加本任务新增见闻。篇幅反馈是宿主实际汉字计数，不是估计；不足需补足 belowBy，过长需删减 aboveBy，可向原范围中部 suggestedBodyCjk 调整以留出计数余量，不改变原上下限。此后不会自动再次生成；如仍未达到目标，按真实缺项交付草稿。\n'+text+'\n'+JSON.stringify({context,previousCandidate:{participantCharacterRefs:material.participantCharacterRefs,narrativePerspective:material.narrativePerspective,changes:material.changes.map(({baseHash,...change})=>change)},feedback:{wordCount,suggestedBodyCjk,missingResourceRefs:candidate.missingResourceRefs||[],issues:reviewed?.report.issues||[]}}),outputSchema,readOnly:true,purpose:'writing_revision',parentRunId:run.runId,route:run.route,abortSignal:controller.signal,onStarted:async execution=>{
        assertCurrent();stage.executions=[...(stage.executions||[]),execution];
        run.items.push(...sources.filter(source=>source.exists!==false).map(source=>({type:'writingSourceDelivery',origin:'host',purpose:'writing_revision',executionRunId:execution.runId,id:execution.runId+':'+source.resourceRef,status:'completed',result:{structuredContent:source}})));
        await service._checkpointRun(run.runId);assertCurrent();
      }});
      assertCurrent();await assertDependencies(run);assertCurrent();
      authored=JSON.parse(revision.text);
      normalizeParticipants(authored);
      if(Array.isArray(authored.changes))authored.changes=authored.changes.map(change=>{
        const source=sources.find(source=>source.resourceRef===change.resourceRef&&source.exists!==false);
        return {...change,...(source?.hash?{baseHash:source.hash}:{})};
      });
      const refs=authored.changes?.map(change=>change.resourceRef);
      if(!refs||material.changes.some(change=>!refs.includes(change.resourceRef)))throw contractError('定向修订不能丢弃候选中的资源','preparation_revision_scope_changed');
      const allowed=new Set([...material.changes.map(change=>change.resourceRef),...(candidate.missingResourceRefs||[])]);
      if(refs.some(ref=>!allowed.has(ref)&&!(allowed.has('chapter:new')&&ref.startsWith('chapter:'))))throw contractError('定向修订不能增加无关资源','preparation_revision_scope_changed');
      if(material.participantCharacterRefs?.length&&(!Array.isArray(authored.participantCharacterRefs)||authored.participantCharacterRefs.length!==material.participantCharacterRefs.length||material.participantCharacterRefs.some(ref=>!authored.participantCharacterRefs.includes(ref))))throw contractError('定向修订不能改变候选参与者','preparation_revision_scope_changed');
      candidate=await require('../mcp/writingTools').prepareNovelPatch({...authored,preparationId:material.id,expectedRevision:material.revision},{expectedRunId:run.runId,novel:run.entry,novelDir:run.entry.dir});
      assertCurrent();stage.candidate={preparationId:candidate.preparationId,revision:candidate.preparationRevision};stage.revisionCount=1;
      reviewed=candidate.preparedOnly?await examine():null;
    }
    if(reviewed) {
      run.items.push(...reviewed.deliveries);
      run.reviewSubmission={report:reviewed.report,coverageHashes:reviewed.assessed.coverageHashes,origin:'host_readonly_analysis',protocolVersion:4,candidate:{...stage.candidate},itemId:'candidate:'+candidate.preparationId+':'+candidate.preparationRevision};
      run.reviewFindings=candidateFindings;
      run.narrativeReview={status:'completed',readOnly:true,source:'candidate',...reviewed.execution};
    }
    await transition(candidate.preparedOnly ? 'prepared' : 'incomplete');
    service._emitEvent({type:'writing_preparation_completed',runId:run.runId,conversationId:run.conversationId});
    if (!candidate.preparedOnly) throw contractError('候选尚缺必需资源，不能启动原生提交', 'preparation_incomplete');
    return candidate;
  } catch (error) {
    if(controller.signal.aborted||run.interruptionRequested)error=contractError('候选阶段已停止','turn_interrupted');
    stage.phase = error.code==='turn_interrupted' ? 'interrupted' : 'failed';
    stage.error = { code: error.code || 'preparation_failed', message: error.message };
    try { await service._checkpointRun(run.runId); }
    catch (checkpointError) { stage.checkpointError = checkpointError.message; }
    throw error;
  } finally {
    if (service.intentControllers.get(run.runId) === controller) service.intentControllers.delete(run.runId);
  }
}
async function materialFor(run) {
  const ref = run.preparationStage?.candidate;
  const record = await runs.get(run.runId);
  const material = ref && record?.writingPreparations?.[ref.preparationId];
  if (!material || material.revision !== ref.revision) throw contractError('冻结候选已变化', 'preparation_revision_changed');
  return material;
}
async function assertDependencies(run) {
  for(const source of run.preparationStage?.dependencies||[]) {
    const actual=await readResource(run.entry,source.resourceRef).catch(error=>error.code==='ENOENT'||error.details?.reason==='resource_not_found'?null:Promise.reject(error));
    if((actual?.sourceHash||null)!==source.hash)throw contractError('候选依据资料已变化：'+source.resourceRef,'preparation_dependency_changed');
  }
}
async function commitInput(service, run) {
  const stage = run.preparationStage;
  if (stage?.phase !== 'prepared') throw contractError('没有准备完成的候选', 'preparation_incomplete');
  let revision = stage.revision;
  let phase = 'prepared';
  const assertCurrent = () => {
    if (run.interruptionRequested) throw contractError('候选任务已停止', 'turn_interrupted');
    if (run.preparationStage !== stage || stage.revision !== revision || stage.phase !== phase) throw contractError('候选阶段结果已过期', 'preparation_stage_stale');
  };
  assertCurrent();
  const material = await materialFor(run);
  await assertDependencies(run);
  // Retrieve through the same preparation checks. This validates formal and
  // mirror baselines without refreshing any frozen version.
  await require('../mcp/writingTools').prepareNovelPatch({ preparationId: material.id, expectedRevision: material.revision }, { expectedRunId: run.runId, novel: run.entry, novelDir: run.entry.dir });
  assertCurrent();
  stage.phase = phase = 'native_commit';
  revision = ++stage.revision;
  await service._checkpointRun(run.runId);
  assertCurrent();
  service._emitEvent({type:'writing_commit_started',runId:run.runId,conversationId:run.conversationId});
  return [{ type: 'text', text: '提交本任务已冻结的候选，不重新创作。调用 novel_tools.prepare_novel_patch，参数 ' + JSON.stringify({ preparationId: material.id, expectedRevision: material.revision }) + '，把返回的 structuredContent.patch 原样交给原生 apply_patch；沿用正常批准流程。完成后读回正式资源。'+(run.taskConstraints.reviewRequired?'调用 novel_tools.check_writing_task 核对正式版本与独立候选审查的一致性；同一版本沿用已有审查，不重新分析。':'')+'拒绝、冲突、停止或没有正式保存时如实说明；最终草稿仍有缺项须报告，不额外改写冻结候选。\n原始用户任务仅作本对话上下文，当前写入仍限上述冻结版本：'+JSON.stringify({request:run.requestText,originalRequest:run.taskRequestText}) }];
}
async function assertCommitCandidate(run, evidence) {
  if (!run.preparationStage) return;
  if (run.interruptionRequested || run.preparationStage.phase !== 'native_commit') throw contractError('当前阶段不允许提交', 'preparation_commit_not_active');
  const material = await materialFor(run);
  await assertDependencies(run);
  if (evidence.length !== material.expectedResources.length || evidence.some(actual => !material.expectedResources.some(expected => expected.resourceRef === actual.resourceRef && expected.mirrorHash === actual.afterHash))) throw contractError('原生补丁与冻结候选内容不同', 'preparation_content_mismatch');
  // Bind original formal baselines as well as output bytes. Re-read immediately
  // before approval and again before the host transaction; no approval transfer.
  for (const change of material.changes) {
    const actual = await readResource(run.entry, change.resourceRef).catch(error => error.code === 'ENOENT' || error.details?.reason === 'resource_not_found' ? null : Promise.reject(error));
    const expected = change.baseHash === 'absent' ? hash(null) : change.baseHash;
    if ((actual?.sourceHash || hash(null)) !== expected) throw contractError('候选依据版本已变化：' + change.resourceRef, 'preparation_baseline_changed');
    if (!evidence.some(item => item.resourceRef === change.resourceRef && item.beforeHash === expected)) throw contractError('原生补丁原版本与候选不同', 'preparation_baseline_changed');
  }
}
async function settleStage(run, terminal) {
  const stage = run.preparationStage;
  if (!stage) return;
  if (terminal !== 'completed') { stage.phase = terminal; return; }
  if(stage.phase==='rejected')return;
  try {
    const material = await materialFor(run);
    for (const expected of material.expectedResources) {
      const actual = await readResource(run.entry, expected.resourceRef);
      if (actual.sourceHash !== expected.hash || !run.committedResources.some(c => c.resourceRef === expected.resourceRef && c.newHash === actual.sourceHash && c.nativeItemId)) throw contractError('没有与候选相符的正式提交及读回', 'preparation_readback_missing');
    }
    stage.phase = 'readback_complete';
  } catch (error) { stage.phase = 'incomplete'; stage.error = { code: error.code || 'preparation_readback_failed', message: error.message }; }
  stage.revision++;
}
function presentReceipt(run, taskResult) {
  if(run.preparationStage?.phase!=='readback_complete')return;
  const current=new Set(taskResult.evidence?.currentSavedResourceRefs||[]);
  const saved=run.committedResources.filter(resource=>current.has(resource.resourceRef));
  if(!saved.length||saved.length!==run.committedResources.length)return;
  if(run.preparationStage.resultOrigin!=='host_commit_receipt')run.activityText=[run.activityText,run.text].filter(Boolean).join('\n\n');
  run.preparationStage.resultOrigin='host_commit_receipt';
  const chapters=saved.filter(resource=>resource.resourceRef.startsWith('chapter:'));
  run.text=`已保存并读回 ${saved.length} 项资源。`+(chapters.length?`正文 ${chapters.reduce((sum,resource)=>sum+resource.bodyChineseCharacterCount,0)} 字。`:'');
}
module.exports = { prepareStage, commitInput, assertCommitCandidate, settleStage, presentReceipt };
