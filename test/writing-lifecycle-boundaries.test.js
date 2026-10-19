'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const jobs = require('../src/main/codex-runtime/narrativeReviewJobs');
const stage = require('../src/main/codex-runtime/writingPreparationStage');
const { normalizeTaskConstraints } = require('../src/main/codex-runtime/taskLedger');

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
async function until(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('boundary test timed out')), 5000); })]); }
  finally { clearTimeout(timer); }
}
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mana-writing-boundaries-'));
  const previousRoot = process.env.MANA_USER_DATA_ROOT;
  process.env.MANA_USER_DATA_ROOT = path.join(root, 'data');
  const cleanups = [];
  t.after(async () => {
    for (const clean of cleanups.reverse()) await clean();
    if (previousRoot === undefined) delete process.env.MANA_USER_DATA_ROOT;
    else process.env.MANA_USER_DATA_ROOT = previousRoot;
    await fs.rm(root, { recursive: true, force: true });
  });
  const data = require('../src/main/store/novelData');
  const entry = await require('../src/main/store/novels').createNovel({ title: '写作异步边界', dir: path.join(root, 'novel') });
  await data.writeChapter(entry.dir, 'chapter-001.md', '她在雨停之后推开门。');
  return { root, entry, data, cleanup: clean => cleanups.push(clean) };
}
function reviewParent(entry) {
  return { runId: 'review-parent', entry, items: [], committedResources: [], reviewFindings: [], memoryBaselines: {},
    taskConstraints: normalizeTaskConstraints({ operation: 'review', reviewRequired: true, narrativeAuditRequired: true, reviewTargetResourceRefs: ['chapter:chapter-001.md'] }) };
}
function reviewService(parent, runOneShot) {
  const service = new EventEmitter();
  service.activeRuns = new Map([[parent.runId, parent]]);
  service.events = []; service.checkpoints = 0;
  service._emitEvent = event => service.events.push(event);
  service._checkpointRun = async () => { service.checkpoints++; };
  service.runOneShot = runOneShot;
  return service;
}
const response = { text: JSON.stringify({ reviews: [{ resourceRef: 'chapter:chapter-001.md', aspects: ['timeline'], conclusion: '边界测试夹具。', limitations: [] }], issues: [], resolutions: [] }), modelId: 'fixture' };

test('a preparation checkpoint failure releases its cancellation controller and preserves the original error', async () => {
  const initial = new Error('initial checkpoint unavailable');
  const later = new Error('failure checkpoint also unavailable');
  let calls = 0;
  const service = { intentControllers: new Map(), _checkpointRun: async () => { throw calls++ ? later : initial; } };
  const run = { runId: 'prepare-failure', turnId: '' };
  await assert.rejects(stage.prepareStage(service, run, { text: '保存草稿' }), error => error === initial);
  assert.equal(service.intentControllers.size, 0);
  assert.equal(run.preparationStage.phase, 'failed');
});

test('stopping during context delivery prevents the preparation model call', async t => {
  const { entry } = await fixture(t);
  const context = require('../src/main/codex-runtime/writingContext');
  const original = context.buildWritingContext;
  const entered = deferred(), release = deferred();
  context.buildWritingContext = async (...args) => { const value = await original(...args); entered.resolve(); await release.promise; return value; };
  t.after(() => { context.buildWritingContext = original; });
  let calls = 0;
  const service = { intentControllers: new Map(), _checkpointRun: async () => {}, runOneShot: async () => { calls++; return { text: '{}' }; } };
  const run = { runId: 'context-cancel', entry, items: [], taskConstraints: {} };
  const preparing = stage.prepareStage(service, run, { text: '保存草稿' });
  const rejected = assert.rejects(preparing, error => error.code === 'turn_interrupted');
  await until(entered.promise); run.interruptionRequested = true; release.resolve(); await rejected;
  assert.equal(calls, 0);
  assert.equal(service.intentControllers.size, 0);
});

test('stopping during the handoff checkpoint cannot return native commit input', async t => {
  const { root, entry } = await fixture(t);
  const runs = require('../src/main/store/chatRuns');
  const workspace = await require('../src/main/codex-runtime/nativeNovelWorkspace').syncNativeNovelWorkspace(entry, path.join(root, 'workspaces'));
  const constraints = normalizeTaskConstraints({ operation: 'write' });
  const run = { runId: 'commit-handoff', entry, workspace, items: [], committedResources: [], taskConstraints: constraints };
  await runs.save({ runId: run.runId, novelId: entry.id, status: 'running', version: 1, workspaceRoot: workspace.root, taskConstraints: constraints });
  const candidate = await require('../src/main/mcp/writingTools').prepareNovelPatch({ changes: [{ resourceRef: 'chapter:chapter-002.md', content: '她收好了潮表。' }] }, { novel: entry, novelDir: entry.dir, expectedRunId: run.runId });
  run.preparationStage = { phase: 'prepared', revision: 2, candidate: { preparationId: candidate.preparationId, revision: candidate.preparationRevision } };
  const service = { _checkpointRun: async () => { run.interruptionRequested = true; } };
  await assert.rejects(stage.commitInput(service, run), error => error.code === 'turn_interrupted');
});

test('a review request already aborted before entry does not enqueue an inference', async t => {
  const { root, entry } = await fixture(t);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(jobs.requestReview(reviewParent(entry), entry, { signal: controller.signal }), error => error.code === 'narrative_review_cancelled');
  const names = await fs.readdir(path.join(root, 'data', 'narrative-review-jobs')).catch(() => []);
  assert.deepEqual(names, []);
});

for (const outcome of ['success', 'failure']) {
  test(`late review ${outcome} after stop cannot mutate the parent or publish a completed review`, async t => {
    const { entry, cleanup } = await fixture(t);
    const parent = reviewParent(entry), entered = deferred(), release = deferred();
    const service = reviewService(parent, async () => { entered.resolve(); await release.promise; if (outcome === 'failure') throw new Error('late failure'); return response; });
    const stopHost = jobs.attachJobHost(service);
    cleanup(stopHost);
    const controller = new AbortController();
    const request = jobs.requestReview(parent, entry, { signal: controller.signal });
    const rejected = assert.rejects(request, error => error.code === 'narrative_review_cancelled');
    await until(entered.promise);
    parent.interruptionRequested = true; parent.narrativeReview = { status: 'cancelled' };
    service.activeRuns.delete(parent.runId); controller.abort();
    release.resolve(); await stopHost(); await rejected;
    // Also makes the original implementation's detached continuation observable.
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(parent.reviewSubmission, undefined);
    assert.deepEqual(parent.items, []);
    assert.deepEqual(parent.narrativeReview, { status: 'cancelled' });
    assert.equal(service.checkpoints, 0);
    assert.equal(service.events.filter(event => event.type === 'narrative_review_completed').length, 0);
  });
}

test('a canonical source changed during assessment cannot become a successful review', async t => {
  const { entry, data, cleanup } = await fixture(t);
  const ledger = require('../src/main/codex-runtime/reviewLedger');
  const original = ledger.assessReview;
  ledger.assessReview = async (...args) => { const result = await original(...args); await data.writeChapter(entry.dir, 'chapter-001.md', '用户在审查期间改了正文。'); return result; };
  t.after(() => { ledger.assessReview = original; });
  const parent = reviewParent(entry), service = reviewService(parent, async () => response);
  const stopHost = jobs.attachJobHost(service); cleanup(stopHost);
  const result = await jobs.requestReview(parent, entry, { timeoutMs: 5000 });
  await stopHost();
  assert.equal(result.ok, false);
  assert.equal(result.error, 'review_sources_changed');
  assert.equal(parent.reviewSubmission, undefined);
  assert.deepEqual(parent.items, []);
});

test('stopping while the task catalogue loads prevents even the intent model request', async t => {
  const { root, entry, cleanup } = await fixture(t);
  const intent = require('../src/main/codex-runtime/taskIntent');
  const original = intent.intentInput;
  const entered = deferred(), release = deferred();
  intent.intentInput = async (...args) => { const input = await original(...args); entered.resolve(); await release.promise; return input; };
  t.after(() => { intent.intentInput = original; });
  const model = require('../src/main/modelConfig');
  const priorRoute = model.activeRoute;
  model.activeRoute = async () => ({ fingerprint: 'fixture', connection: { id: 'fixture', kind: 'api', templateId: 'custom' }, model: { id: 'fixture', verification: { tools: 'ok' } } });
  t.after(() => { model.activeRoute = priorRoute; });
  const { CodexSessionService } = require('../src/main/codex-runtime/codexSessionService');
  const service = new CodexSessionService();
  cleanup(() => service.dispose());
  service._ensureProcess = async () => { service.processManager = { workspacesDirectory: path.join(root, 'workspaces'), stop: async () => {} }; return {}; };
  service._bindConversation = async () => 'author-thread';
  let calls = 0;
  service.runOneShot = async () => { calls++; return { text: JSON.stringify({ participants: { selection: 'unspecified', characterRefs: [] }, perspective: { mode: 'unspecified' }, requiredReadResourceRefs: [] }) }; };
  const started = service.startTurn({ runId: 'catalogue-cancel', novelId: entry.id, text: '写下一章', skillName: 'mana-fiction-writing', persistence: 'one-shot' });
  const rejected = assert.rejects(started, error => error.code === 'turn_interrupted');
  await until(entered.promise); await service.interrupt({ runId: 'catalogue-cancel' }); release.resolve(); await rejected;
  assert.equal(calls, 0);
});
