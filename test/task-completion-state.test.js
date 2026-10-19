'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mana-task-completion-'));
  process.env.MANA_USER_DATA_ROOT = path.join(root, 'data');
  const novels = require('../src/main/store/novels');
  const novelData = require('../src/main/store/novelData');
  const history = require('../src/main/store/chatHistory');
  const model = require('../src/main/modelConfig');
  const { readResource } = require('../src/main/mcp/novelResources');
  const { evaluateTaskResult, wordCountCheck } = require('../src/main/codex-runtime/taskCompletion');
  const { normalizeTaskConstraints } = require('../src/main/codex-runtime/taskLedger');
  const { prepareTaskContinuation } = require('../src/main/codex-runtime/taskContinuation');
  const { CodexSessionService } = require('../src/main/codex-runtime/codexSessionService');
  const service = new CodexSessionService();
  let checks = 0;
  const test = async (name, fn) => { await fn(); checks++; console.log('PASS task-completion ' + name); };
  try {
    const novel = await novels.createNovel({ title: '完成状态验收', dir: path.join(root, 'novel') });
    const ref = 'chapter:chapter-001.md';
    await novelData.writeChapterWithMeta(novel.dir, 'chapter-001.md', '甲'.repeat(95), {}, { baseContent: '' });
    const resource = await readResource(novel, ref);
    const commit = { resourceRef: ref, mode: 'replace', newHash: resource.sourceHash };
    const run = { entry: novel, taskConstraints: { operation: 'write', targetResourceRefs: [ref], minBodyCjk: 100, maxBodyCjk: 100 }, committedResources: [commit], items: [] };
    await test('5 percent tolerance and exact boundaries', async () => {
      const constraints = normalizeTaskConstraints(run.taskConstraints);
      for (const count of [95, 100, 105]) assert.equal(wordCountCheck(count, constraints).status, 'met');
      assert.equal(wordCountCheck(94, constraints).status, 'below_target');
      assert.equal(wordCountCheck(106, constraints).status, 'over_target');
      assert.equal(wordCountCheck(99, normalizeTaskConstraints({ minBodyCjk: 100, wordCountToleranceRatio: 0 })).status, 'below_target');
      const result = await evaluateTaskResult(run, true);
      assert.equal(result.goalVerified, true);
      assert.equal(result.persistence.status, 'saved');
      assert.equal(result.contentReview.characterConsistency.status, 'not_evaluated');
    });
    await test('large shortfall and excess change acceptance without rollback', async () => {
      for (const minimum of [200, 40]) {
        const result = await evaluateTaskResult({ ...run, taskConstraints: { ...run.taskConstraints, minBodyCjk: minimum, maxBodyCjk: minimum } }, true);
        assert.equal(result.goalVerified, false);
        assert.equal(result.goalStatus, 'incomplete');
        assert.equal(result.modelTurnCompleted, true);
        assert.equal(result.savedResources.length, 1);
        assert.equal(result.checks.wordCount.blocking, false);
        assert.equal(await novelData.readChapter(novel.dir, 'chapter-001.md'), '甲'.repeat(95));
      }
    });
    await test('partial target commits remain incomplete', async () => {
      await novelData.writeChapterWithMeta(novel.dir, 'chapter-002.md', '乙', {}, { baseContent: '' });
      const result = await evaluateTaskResult({ ...run, taskConstraints: { operation: 'edit', targetResourceRefs: [ref, 'chapter:chapter-002.md'] } }, true);
      assert.equal(result.goalVerified, false);
      assert.ok(result.objective.unmet.includes('targets_not_saved'));
    });
    await test('normal model ending without a write is not a completed writing task', async () => {
      const result = await evaluateTaskResult({ ...run, committedResources: [] }, true);
      assert.equal(result.goalVerified, false);
      assert.ok(result.objective.unmet.includes('no_current_commit'));
    });
    await test('formal version changes invalidate commit evidence', async () => {
      const result = await evaluateTaskResult({ ...run, committedResources: [{ ...commit, newHash: 'obsolete' }] }, true);
      assert.equal(result.goalVerified, false);
      assert.ok(result.objective.unmet.includes('saved_version_changed'));
    });
    await test('interruption preserves saved evidence and marks partial persistence', async () => {
      const result = await evaluateTaskResult({ ...run, interruptionRequested: true }, false);
      assert.equal(result.goalVerified, false);
      assert.equal(result.execution.status, 'interrupted');
      assert.equal(result.persistence.status, 'partial');
      assert.equal(result.savedResources.length, 1);
    });
    await test('complete ending requires independent review after objective checks pass', async () => {
      const result = await evaluateTaskResult({ ...run, taskConstraints: { ...run.taskConstraints, requiresCompleteEnding: true } }, true);
      assert.equal(result.objective.status, 'met');
      assert.equal(result.goalStatus, 'awaiting-review');
      assert.equal(result.goalVerified, false);
      assert.equal(result.contentReview.ending.status, 'required_not_evaluated');
    });
    const read = { id: 'read', type: 'mcpToolCall', name: 'read_novel_resource', arguments: { resourceRef: ref }, status: 'completed', result: { isError: false, structuredContent: { resourceRef: ref, hash: resource.sourceHash, mode: 'content', offset: 0, content: resource.content } } };
    await test('reading requires actual successful resource reads', async () => {
      const reading = { ...run, committedResources: [], taskConstraints: { operation: 'read', targetResourceRefs: [ref] } };
      assert.equal((await evaluateTaskResult(reading, true)).goalVerified, false);
      assert.equal((await evaluateTaskResult({ ...reading, items: [{ ...read, result: { isError: true } }] }, true)).goalVerified, false);
      assert.equal((await evaluateTaskResult({ ...reading, items: [read] }, true)).goalVerified, true);
      assert.equal((await evaluateTaskResult({ ...reading, items: [{ ...read, result: { structuredContent: { ...read.result.structuredContent, mode: 'metadata', content: undefined } } }] }, true)).goalVerified, false);
      assert.equal((await evaluateTaskResult({ ...reading, items: [{ ...read, result: { structuredContent: { ...read.result.structuredContent, content: '甲' } } }] }, true)).goalVerified, false);
      const pages = [0, 45].map((offset, index) => ({ ...read, id: 'page-' + index, result: { structuredContent: { ...read.result.structuredContent, offset: offset * 3, content: '甲'.repeat(index ? 50 : 45) } } }));
      assert.equal((await evaluateTaskResult({ ...reading, items: pages }, true)).goalVerified, true);
    });
    await test('review requires covered report while quality remains unevaluated', async () => {
      const review = { ...run, committedResources: [], taskConstraints: { operation: 'review', targetResourceRefs: [ref] }, items: [read], text: '审校报告' };
      assert.equal((await evaluateTaskResult(review, true)).goalVerified, false);
      const result = await evaluateTaskResult({ ...review, reviewRecord: { coverageVerified: true, coverageClaimed: [ref] } }, true);
      assert.equal(result.goalVerified, true);
      assert.equal(result.contentReview.style.status, 'not_evaluated');
      assert.equal((await evaluateTaskResult({ ...review, reviewRecord: { coverageVerified: true, coverageClaimed: [] } }, true)).goalVerified, false);
    });
    await test('roleplay and plain text do not invent objective acceptance', async () => {
      assert.equal((await evaluateTaskResult({ ...run, committedResources: [], taskConstraints: { operation: 'roleplay' } }, true)).objective.status, 'not_evaluated');
    });
    const thread = await history.createThread({ novelId: novel.id, title: '继续目标' });
    model.activeRoute = async () => ({ connection: { kind: 'api' }, model: { id: 'fixture', verification: { tools: 'ok' } } });
    service.processManager = { workspacesDirectory: path.join(root, 'workspaces'), request: async () => ({}), stop: async () => {} };
    service._ensureProcess = async () => service.processManager;
    service._bindConversation = async () => 'fixture-thread';
    service.runOneShot=async options=>{assert.equal(options.purpose,'task_intent');return {...require('./fixtures/fake-responses-server').taskIntentFixture([{text:options.text}]),modelId:'fixture'};};
    let inputs;
    service._startNativeTurn = async value => { inputs = value; return { turn: { id: 'fixture-turn' } }; };
    // This fixture isolates the native lifecycle; the staged ordinary writing
    // entrance has its own storage and dispatch tests.
    const first = { runId: 'first', conversationId: thread.id, novelId: novel.id, skillName:'mana-novel-workspace', text: '写作目标200字', taskConstraints: { operation: 'write', targetResourceRefs: [ref], minBodyCjk: 200 } };
    await service.startTurn(first);
    service.activeRuns.get(first.runId).committedResources = [commit];
    await service._finalizeRun(service.activeRuns.get(first.runId), { type: 'turn_completed', runId: first.runId, conversationId: thread.id });
    await test('persisted task result and progress agree after incomplete turn', async () => {
      const state = await service.getRunState({ runId: first.runId });
      assert.equal(state.status, 'completed');
      assert.equal(state.taskResult.goalStatus, 'incomplete');
      assert.equal(state.progress.goalStatus, 'incomplete');
      const message = (await history.getThread(thread.id)).messages.find(message => message.runtimeTaskRunId === first.runId);
      assert.equal(message.execution.taskResult.goalStatus, 'incomplete');
    });
    await test('explicit continuation inherits target and stable task identity', async () => {
      await service.startTurn({ runId: 'continue', conversationId: thread.id, novelId: novel.id,skillName:'mana-novel-workspace', text: '继续未完成任务，保留已保存内容', continueFromRunId: first.runId });
      const continuing = service.activeRuns.get('continue');
      assert.equal(continuing.taskConstraints.minBodyCjk, 200);
      assert.equal(continuing.taskId, service.runRecords.get('first').taskId);
      assert.equal(continuing.reusedSavedResources.length, 1);
      assert.ok(inputs.additionalContext.taskContinuation.value.includes('保留已完成内容'));
      await service._finalizeRun(continuing, { type: 'turn_completed', runId: 'continue', conversationId: thread.id });
      assert.equal((await service.getRunState({ runId: 'continue' })).taskResult.goalVerified, false);
    });
    await test('valid prior commits allow completion without rewriting finished content', async () => {
      await service.startTurn({ runId: 'tolerated', conversationId: thread.id, novelId: novel.id,skillName:'mana-novel-workspace', text: '继续未完成任务，目标95字', continueFromRunId: 'continue', taskConstraints: { minBodyCjk: 95 } });
      await service._finalizeRun(service.activeRuns.get('tolerated'), { type: 'turn_completed', runId: 'tolerated', conversationId: thread.id });
      const result = (await service.getRunState({ runId: 'tolerated' })).taskResult;
      assert.equal(result.goalVerified, true);
      assert.equal(result.savedResources.length, 0);
      assert.equal(result.reusedSavedResources.length, 1);
      assert.equal(await novelData.readChapter(novel.dir, 'chapter-001.md'), '甲'.repeat(95));
    });
    await test('continuation rejects completed goals and other conversations', async () => {
      const another = await history.createThread({ novelId: novel.id, title: '其他对话' });
      await assert.rejects(prepareTaskContinuation({ conversationId: another.id, novelId: novel.id, text: '继续未完成任务', continueFromRunId: first.runId }), error => error.code === 'continuation_mismatch');
      await assert.rejects(prepareTaskContinuation({ conversationId: thread.id, novelId: novel.id, text: '继续未完成任务', continueFromRunId: 'tolerated' }), error => error.code === 'continuation_unavailable');
    });
    await test('ordinary new messages do not inherit an unrelated target', async () => {
      await service.startTurn({ runId: 'ordinary', conversationId: thread.id, novelId: novel.id, text: '普通问题' });
      const ordinary = service.activeRuns.get('ordinary');
      assert.equal(ordinary.taskConstraints.minBodyCjk, null);
      assert.equal(ordinary.progress.target.minimum, null);
      assert.equal(ordinary.reusedSavedResources.length, 0);
      await service._finalizeRun(ordinary, { type: 'turn_completed', runId: 'ordinary', conversationId: thread.id });
    });
    await test('restricted selection continuation requires a fresh user selection', async () => {
      const store = require('../src/main/store/chatRuns');
      const source = await store.get(first.runId);
      await store.save({ ...source, version: source.version + 1, editScope: { mode: 'selection', resourceRef: ref } });
      try {
        await assert.rejects(prepareTaskContinuation({ conversationId: thread.id, novelId: novel.id, text: '继续未完成任务', continueFromRunId: first.runId }), error => error.code === 'continuation_scope_required');
      } finally { await store.save({ ...source, version: source.version + 2 }); }
    });
    await test('continuation retains the logical task original memory baseline rather than freezing unreviewed draft entries',async()=>{
      const store=require('../src/main/store/chatRuns');const source=await store.get(first.runId);
      const baseline={'character-memory:he':{characterId:'he',factsKnown:[{id:'initial',summary:'任务开始前的事实'}]}};
      await store.save({...source,version:source.version+1,memoryBaselines:baseline});
      try {
        const payload=await prepareTaskContinuation({conversationId:thread.id,novelId:novel.id,text:'继续未完成任务',continueFromRunId:first.runId});
        assert.deepEqual(payload.continuation.memoryBaselines,baseline);
      } finally {await store.save({...source,version:source.version+2});}
    });
    await test('continued evidence is invalidated when saved content changes', async () => {
      const payload = await prepareTaskContinuation({ conversationId: thread.id, novelId: novel.id, text: '继续未完成任务', continueFromRunId: first.runId, taskConstraints: { minBodyCjk: 90 } });
      await novelData.writeChapterWithMeta(novel.dir, 'chapter-001.md', '乙'.repeat(95), {}, { baseContent: '甲'.repeat(95) });
      const result = await evaluateTaskResult({ entry: novel, taskConstraints: payload.taskConstraints, committedResources: [], reusedSavedResources: payload.continuation.savedResources }, true);
      assert.equal(result.goalVerified, false);
      assert.ok(result.objective.unmet.includes('saved_version_changed'));
    });
    await test('crash recovery retains partial saves and accurate progress', async () => {
      const source = await service.getRunState({ runId: first.runId });
      const current = await readResource(novel, ref);
      await history.ensureUserMessage(thread.id, novel.id, { id: 'crash-user', text: '继续原写作目标' });
      await require('../src/main/store/chatRuns').save({ ...source, runId: 'crash', userMessageId: 'crash-user', status: 'running', version: 100,
        taskResult: null, savedResources: [{ ...commit, newHash: current.sourceHash }], progress: { ...source.progress, runId: 'crash', phase: 'waiting-model' } });
      const recoveredService = new CodexSessionService();
      try {
        const recovered = await recoveredService.getRunState({ runId: 'crash' });
        assert.equal(recovered.status, 'interrupted');
        assert.equal(recovered.taskResult.savedResources.length, 1);
        assert.equal(recovered.taskResult.persistence.status, 'partial');
        assert.equal(recovered.progress.goalStatus, 'interrupted');
        const continuing = await prepareTaskContinuation({ conversationId: thread.id, novelId: novel.id, text: '继续未完成任务', continueFromRunId: 'crash' });
        assert.equal(continuing.taskConstraints.minBodyCjk, 200);
      } finally { await recoveredService.dispose(); }
    });
    await test('scope cancellation and late successful scope replies cannot start the author',async()=>{
      const originalOneShot=service.runOneShot,originalStart=service._startNativeTurn;
      let authors=0;service._startNativeTurn=async()=>{authors++;return {turn:{id:'must-not-start'}};};
      try {
        for(const lateSuccess of [false,true]) {
          const runId='scope-cancel-'+lateSuccess;let entered;
          const ready=new Promise(resolve=>{entered=resolve;});
          service.runOneShot=async options=>{
            entered();await new Promise(resolve=>options.abortSignal.addEventListener('abort',resolve,{once:true}));
            if(!lateSuccess)throw new Error('native child interrupted');
            return {...require('./fixtures/fake-responses-server').taskIntentFixture([{text:options.text}]),modelId:'fixture'};
          };
          const pending=service.startTurn({runId,conversationId:thread.id,novelId:novel.id,text:'写下一章并保存，写后自查'});
          const rejected=assert.rejects(pending,e=>e.code==='turn_interrupted');await ready;
          await service.interrupt({runId});await rejected;
          assert.equal((await service.getRunState({runId})).status,'interrupted');assert.equal(service.intentControllers.has(runId),false);
        }
        assert.equal(authors,0);
        const update=service._updateProgress;
        service.runOneShot=originalOneShot;
        service._updateProgress=async run=>{if(run.runId==='scope-to-author-cancel')await service.interrupt({runId:run.runId});return update.call(service,run);};
        try {
          await assert.rejects(service.startTurn({runId:'scope-to-author-cancel',conversationId:thread.id,novelId:novel.id,text:'写下一章并保存，写后自查'}),e=>e.code==='turn_interrupted');
          assert.equal(authors,0,'stop between scope parsing and author start must not dispatch an author');
          assert.equal((await service.getRunState({runId:'scope-to-author-cancel'})).status,'interrupted');
        } finally {service._updateProgress=update;}
      } finally {service.runOneShot=originalOneShot;service._startNativeTurn=originalStart;}
    });
    console.log(`task-completion-state: ok (${checks} scenarios)`);
  } finally { await service.dispose(); await fs.rm(root, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
