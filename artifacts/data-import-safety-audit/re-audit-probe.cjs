'use strict';
// Adversarial audit only. Records counterexamples, never counts them as product passes.
// Run from this worktree: node artifacts/data-import-safety-audit/re-audit-probe.cjs
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const repo = path.resolve(__dirname, '../..');
const load = (relative) => require(path.join(repo, relative));
const reviews = load('src/main/import/reviewStore');
const plans = load('src/main/import/resourcePlan');
const data = load('src/main/store/novelData');
const { ensureNovelLayout } = load('src/main/store/paths');
const { ImportSagaService } = load('src/main/import/importSaga');
const staging = load('src/main/import/stagingProject');
const novels = load('src/main/store/novels');
const output = path.join(__dirname, 're-audit-results.json');
const analyzerStub = { startAnalyses: async () => ({ chunkCount: 1 }), finalizeAnalyses: async () => ({ status: 'complete', characters: 0 }) };
async function reviewedRun(target) {
  const saga = new ImportSagaService({ analyzer: analyzerStub });
  const started = await saga.start({ parsed: { chapters: [{ title: '审计', content: '必须完整保留的导入正文' }], metadata: { title: '审计项目' } }, target: { dir: target, title: '审计项目' } });
  await saga.resume(started.runId);
  const run = await saga.resume(started.runId);
  assert.equal(run.state, 'review');
  return { saga, run };
}
async function choose(root, review, rejects) {
  await reviews.decide(root, review.id, Object.fromEntries(review.fields.map((field) => [field.id, rejects.includes(field.id) ? 'reject' : 0])));
  return reviews.finish(root, review.id, true);
}
(async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'mana-re-audit-'));
  process.env.MANA_USER_DATA_ROOT = path.join(temp, 'user-data');
  const results = { auditedAt: new Date().toISOString(), type: 'counterexamples-not-acceptance', fixtureRoot: temp, cases: [] };
  try {
    const timelineRoot = path.join(temp, 'timeline'); ensureNovelLayout(timelineRoot);
    const originalEvents = [{ id: 'old-event', title: '用户原有事件', event: '原文事实' }];
    await data.replaceTimeline(timelineRoot, originalEvents);
    const eventChanges = [{ ...await plans.snapshot(timelineRoot, 'timeline/events.jsonl'), after: JSON.stringify({ id: 'new-event', title: '不接受的候选事件' }) + '\n' }];
    const eventReview = await reviews.create(timelineRoot, { kind: 'analysis', fields: reviews.fieldsForChanges(eventChanges), plan: { changes: eventChanges } });
    await choose(timelineRoot, eventReview, eventReview.fields.map((f) => f.id));
    const actualEvents = await data.listTimeline(timelineRoot);
    results.cases.push({ id: 'RA-01a', status: actualEvents.some((e) => e.id === 'old-event') ? 'not-reproduced' : 'reproduced', expected: '拒绝此项，保留原值：原有事件仍存在', before: originalEvents, after: actualEvents, reviewState: (await reviews.get(timelineRoot, eventReview.id)).state });

    const placesRoot = path.join(temp, 'places'); ensureNovelLayout(placesRoot);
    const originalWorld = { schemaVersion: 1, lore: '原有世界', places: [{ id: 'town', name: '用户原有城镇', description: '原有说明' }] };
    await fs.writeFile(path.join(placesRoot, 'world/meta.json'), JSON.stringify(originalWorld));
    await fs.writeFile(path.join(placesRoot, 'world/places.json'), JSON.stringify({ schemaVersion: 1, places: originalWorld.places }));
    const candidateWorld = { ...originalWorld, places: [{ id: 'town', name: '候选城镇', description: '候选说明', _analysisCandidates: { name: [{ value: '候选城镇' }], description: [{ value: '候选说明' }] } }] };
    const placeChanges = [{ ...await plans.snapshot(placesRoot, 'world/meta.json'), after: JSON.stringify(candidateWorld) }, { ...await plans.snapshot(placesRoot, 'world/places.json'), after: JSON.stringify({ schemaVersion: 1, places: candidateWorld.places }) }];
    const placeReview = await reviews.create(placesRoot, { kind: 'analysis', fields: reviews.fieldsForChanges(placeChanges), plan: { changes: placeChanges } });
    await choose(placesRoot, placeReview, ['world/meta.json:places.0.name']);
    const actualWorld = JSON.parse(await fs.readFile(path.join(placesRoot, 'world/meta.json'), 'utf8'));
    results.cases.push({ id: 'RA-01b', status: actualWorld.places.some((p) => p.id === 'town') ? 'not-reproduced' : 'reproduced', expected: '拒绝已有地点名称，应保留原地点或明确询问整项删除', before: originalWorld.places, after: actualWorld.places, reviewState: (await reviews.get(placesRoot, placeReview.id)).state });

    const crashTarget = path.join(temp, 'crash-promoted');
    const { run: crashRun } = await reviewedRun(crashTarget);
    const childCode = `const fs=require('node:fs/promises'); const rename=fs.rename; fs.rename=async(a,b)=>{await rename(a,b);if(b===process.argv[3])process.exit(73)}; const {ImportSagaService}=require(process.argv[1]);new ImportSagaService().finalize(process.argv[2]).catch(e=>{console.error(e);process.exitCode=2});`;
    const child = spawn(process.execPath, ['-e', childCode, path.join(repo, 'src/main/import/importSaga.js'), crashRun.runId, crashTarget], { stdio: ['ignore', 'pipe', 'pipe'] });
    let childError = ''; child.stderr.on('data', (chunk) => { childError += chunk; });
    assert.equal(await new Promise((resolve) => child.on('exit', resolve)), 73, childError);
    const fresh = new ImportSagaService();
    const beforeRetry = await fresh.get(crashRun.runId);
    const crashRegistry = (await novels.listNovels()).filter((n) => n.dir === crashTarget);
    const retried = await fresh.finalize(crashRun.runId);
    const resumed = await fresh.resume(crashRun.runId);
    const retriedAgain = await fresh.finalize(crashRun.runId);
    results.cases.push({ id: 'RA-02', status: crashRegistry.length === 0 && retriedAgain.state === 'failed' ? 'reproduced' : 'not-reproduced', expected: '重启后识别同一次提升的已改名目录，继续登记并保存完成回执', processExit: 73, targetExists: await fs.access(crashTarget).then(() => true, () => false), chapterText: await fs.readFile(path.join(crashTarget, 'chapters/chapter-001.md'), 'utf8'), registryEntries: crashRegistry.length, beforeRetryState: beforeRetry.state, afterRetry: { state: retried.state, error: retried.error }, afterResumeState: resumed.state, afterSecondRetry: { state: retriedAgain.state, error: retriedAgain.error } });

    const cancelTarget = path.join(temp, 'cancel-promoted');
    const { saga, run: cancelRun } = await reviewedRun(cancelTarget);
    const rename = fs.rename;
    let reached, unblock, completed;
    const ready = new Promise((resolve) => { reached = resolve; });
    const blocked = new Promise((resolve) => { unblock = resolve; });
    const settled = new Promise((resolve) => { completed = resolve; });
    fs.rename = async (a, b) => { await rename(a, b); if (b === cancelTarget) { reached(); await blocked; } };
    const wrappedStaging = { ...staging, promoteToNovel: async (...args) => { try { return await staging.promoteToNovel(...args); } finally { completed(); } } };
    saga.staging = wrappedStaging;
    try {
      const finishing = saga.finalize(cancelRun.runId);
      await ready;
      const cancelled = await saga.cancel(cancelRun.runId);
      unblock();
      const reported = await finishing;
      await settled;
      const durable = await saga.get(cancelRun.runId);
      const registered = (await novels.listNovels()).filter((n) => n.dir === cancelTarget);
      results.cases.push({ id: 'RA-03', status: durable.state === 'cancelled' && registered.length === 1 && !durable.result ? 'reproduced' : 'not-reproduced', expected: '取消与提交的分界唯一；若已经正式创建，运行记录需显示真实提交和回执', cancelResponse: cancelled.state, finalizeResponse: reported.state, durableState: durable.state, registeredProjects: registered.length, promotionReceiptPresent: !!durable.result || durable.checkpoints.some((c) => c.promotion), stagingStatus: (await staging.getStagingProject(cancelRun.importId)).novelMeta.importMeta.status });
    } finally { unblock(); fs.rename = rename; }

    await fs.writeFile(output, JSON.stringify(results, null, 2) + '\n');
    console.log(JSON.stringify(results, null, 2));
    assert.ok(results.cases.every((c) => c.status === 'reproduced'), 'Audit changed: inspect cases that no longer reproduce.');
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
