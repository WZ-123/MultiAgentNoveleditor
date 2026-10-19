'use strict';

// A small handoff adapter for the existing run, one-shot executor and patch
// preparation tool. No candidate store, scheduler, approval or writer lives here.
const { contractError, hash } = require('./contracts');
const runs = require('../store/chatRuns');
const { readResource } = require('../mcp/novelResources');

async function prepareStage(service, run, { text, outputSchema }) {
  if (run.turnId || run.preparationStage) throw contractError('候选阶段只能在原生提交开始前执行一次', 'preparation_stage_started');
  const stage = run.preparationStage = { version: 1, revision: 1, phase: 'preparing', execution: null, candidate: null };
  const controller = new AbortController();
  service.intentControllers.set(run.runId, controller);
  const assertCurrent = () => {
    if (controller.signal.aborted || run.interruptionRequested) throw contractError('候选阶段已停止', 'turn_interrupted');
    if (run.preparationStage !== stage || stage.revision !== 1) throw contractError('候选阶段结果已过期', 'preparation_stage_stale');
  };
  try {
    await service._checkpointRun(run.runId);
    assertCurrent();
    const context=await require('./writingContext').buildWritingContext(run.entry,run);
    assertCurrent();
    const result = await service.runOneShot({ text:text+'\n'+JSON.stringify(context), outputSchema, readOnly: true, purpose: 'writing_preparation', parentRunId: run.runId, route: run.route, abortSignal: controller.signal,
      onStarted: async execution => {
        assertCurrent();
        stage.execution = execution;
        run.items.push(...require('./writingContext').contextResources(context).filter(source=>source.exists!==false).map(source=>({type:'writingSourceDelivery',origin:'host',purpose:'writing_preparation',executionRunId:execution.runId,id:execution.runId+':'+source.resourceRef,status:'completed',result:{structuredContent:source}})));
        await service._checkpointRun(run.runId);
        assertCurrent();
      } });
    assertCurrent();
    const authored = JSON.parse(result.text);
    const sources=require('./writingContext').contextResources(context);
    if(Array.isArray(authored.changes))authored.changes=authored.changes.map(change=>{
      const source=sources.find(source=>source.resourceRef===change.resourceRef&&source.exists!==false);
      return {...change,...(source?.hash?{baseHash:source.hash}:{})};
    });
    // The same implementation assembles, canonicalizes, binds versions and
    // persists candidates whether called from MCP or from a host stage.
    const candidate = await require('../mcp/writingTools').prepareNovelPatch(authored, { expectedRunId: run.runId, novel: run.entry, novelDir: run.entry.dir });
    assertCurrent();
    stage.candidate = { preparationId: candidate.preparationId, revision: candidate.preparationRevision };
    stage.phase = candidate.preparedOnly ? 'prepared' : 'incomplete';
    stage.revision++;
    await service._checkpointRun(run.runId);
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
  // Retrieve through the same preparation checks. This validates formal and
  // mirror baselines without refreshing any frozen version.
  await require('../mcp/writingTools').prepareNovelPatch({ preparationId: material.id, expectedRevision: material.revision }, { expectedRunId: run.runId, novel: run.entry, novelDir: run.entry.dir });
  assertCurrent();
  stage.phase = phase = 'native_commit';
  revision = ++stage.revision;
  await service._checkpointRun(run.runId);
  assertCurrent();
  return [{ type: 'text', text: '提交本任务已冻结的候选，不重新创作。调用 novel_tools.prepare_novel_patch，参数 ' + JSON.stringify({ preparationId: material.id, expectedRevision: material.revision }) + '，把返回的 structuredContent.patch 原样交给原生 apply_patch；沿用正常批准流程。完成后如实说明提交结果。' }];
}
async function assertCommitCandidate(run, evidence) {
  if (!run.preparationStage) return;
  if (run.interruptionRequested || run.preparationStage.phase !== 'native_commit') throw contractError('当前阶段不允许提交', 'preparation_commit_not_active');
  const material = await materialFor(run);
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
