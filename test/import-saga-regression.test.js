'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ImportRunStore } = require('../src/main/import/importRunStore');
const { ImportSagaService } = require('../src/main/import/importSaga');

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mana-import-saga-'));
  const staged = new Map();
  let importSeq = 0;
  let analysisStarts = 0;
  let analysisFinalizes = 0;
  let capturedSignal = null;
  let promotionCalls = 0;
  const conflicts = new Map();
  const staging = {
    checkDuplicateImport: async () => ({ isDuplicate: false, fingerprint: 'fingerprint-1' }),
    createStagingProject: async ({ chapters, targetNovelId }) => {
      const importId = `import-${++importSeq}`;
      staged.set(importId, { importId, chapters, characters: [], world: { lore: '' }, outline: '', novelMeta: { importMeta: { targetNovelId } } });
      return { importId, chapterCount: chapters.length };
    },
    getStagingProject: async (id) => staged.get(id) || null,
    promoteToNovel: async (id, target) => { promotionCalls += 1; return { id: `novel-${id}`, title: target.title, dir: target.dir }; },
  };
  const analyzer = {
    startAnalyses: async (_dir, { abortSignal }) => { analysisStarts += 1; capturedSignal = abortSignal; return { runIds: ['role-1'], taskIds: ['world'] }; },
    finalizeAnalyses: async () => { analysisFinalizes += 1; return { characters: 1, outline: 'ok' }; },
  };
  const merge = {
    createMergeSession: async () => {
      conflicts.set('merge-1', [{ id: 'a', status: 'pending' }, { id: 'b', status: 'pending' }]);
      return { sessionId: 'merge-1', summary: { total: 2, resolved: 0, disputed: 0, pending: 2 } };
    },
    getMergeSummary: (id) => {
      const items = conflicts.get(id) || [];
      return { total: items.length, resolved: items.filter((item) => item.status === 'resolved').length, disputed: items.filter((item) => item.status === 'disputed').length, pending: items.filter((item) => item.status === 'pending').length };
    },
    resolveConflict: (id, itemId) => { conflicts.get(id).find((item) => item.id === itemId).status = 'resolved'; },
    finalizeMerge: async (id) => {
      const summary = merge.getMergeSummary(id);
      if (summary.pending || summary.disputed) throw Object.assign(new Error('unresolved'), { code: 'unresolved_conflicts' });
      return { written: 2 };
    },
  };
  const novels = { pathsFor: async () => ({ root: path.join(root, 'target') }) };
  const store = new ImportRunStore({ root: path.join(root, 'runs') });
  const makeService = () => new ImportSagaService({
    store, staging, analyzer, merge, novels, stagingRoot: path.join(root, 'staging'),
    fileParser: { parseNovelFiles: async () => ({ chapters: [{ title: '一', content: '正文' }], metadata: { title: '书' } }) },
    deadlines: { parse: 100, analyze: 100, promote: 100 },
  });

  try {
    const service = makeService();
    let snapshot = await service.start({ filePaths: ['/source/book.md'] });
    assert.equal(snapshot.state, 'staged');
    assert.equal(snapshot.inputFingerprint, 'fingerprint-1');
    assert.deepEqual(snapshot.checkpoints.map((item) => item.phase), ['parsed', 'staged']);

    snapshot = await service.resume(snapshot.runId);
    assert.equal(snapshot.state, 'analyzing');
    assert.equal(analysisStarts, 1);
    snapshot = await service.resume(snapshot.runId);
    assert.equal(snapshot.state, 'review');
    assert.equal(analysisFinalizes, 1);

    const restarted = makeService();
    snapshot = await restarted.get(snapshot.runId);
    assert.equal(snapshot.state, 'review');
    assert.equal(analysisStarts, 1, 'a durable review checkpoint is not charged/analyzed again after restart');
    snapshot = await restarted.finalize(snapshot.runId, { target: { title: '新书', dir: path.join(root, 'promoted') } });
    assert.equal(snapshot.state, 'completed');
    assert.equal(promotionCalls, 1);
    assert.deepEqual(snapshot.phases.map((item) => item.phase), ['picked', 'parsed', 'staged', 'analyzing', 'review', 'merging', 'promoting', 'completed']);
    assert.ok(snapshot.phases.every((item) => Number.isInteger(item.revision) && Object.hasOwn(item, 'inputFingerprint') && item.checkpoint && item.startedAt && item.completedAt));

    let cancelRun = await service.start({ filePaths: ['/source/cancel.md'] });
    cancelRun = await service.resume(cancelRun.runId);
    assert.equal(cancelRun.state, 'analyzing');
    cancelRun = await service.cancel(cancelRun.runId);
    assert.equal(cancelRun.state, 'cancelled');
    assert.equal(capturedSignal.aborted, true, 'cancel propagates to the root AbortSignal');

    let recoveryRun = await service.start({ filePaths: ['/source/recover.md'] });
    recoveryRun = await service.resume(recoveryRun.runId);
    assert.equal(recoveryRun.state, 'analyzing');
    const resumedService = makeService();
    recoveryRun = await resumedService.get(recoveryRun.runId);
    assert.equal(recoveryRun.state, 'interrupted');
    assert.equal(recoveryRun.error.code, 'provider_state_lost');
    recoveryRun = await resumedService.resume(recoveryRun.runId);
    assert.equal(recoveryRun.state, 'analyzing');
    assert.deepEqual(recoveryRun.phases.slice(-3).map((item) => item.phase), ['interrupted', 'staged', 'analyzing']);
    recoveryRun = await resumedService.cancel(recoveryRun.runId);
    await service.cancel(recoveryRun.runId);
    assert.equal((await resumedService.resume(recoveryRun.runId)).state, 'cancelled', 'cancelled imports cannot silently restart');

    let mergeRun = await service.start({ filePaths: ['/source/merge.md'], targetNovelId: 'target-novel' });
    mergeRun = await service.resume(mergeRun.runId);
    mergeRun = await service.resume(mergeRun.runId);
    mergeRun = await service.finalize(mergeRun.runId);
    assert.equal(mergeRun.state, 'merging');
    assert.equal(mergeRun.error.code, 'unresolved_conflicts');
    mergeRun = await service.resolveConflict(mergeRun.runId, { itemId: 'a', decision: 'left' });
    mergeRun = await service.resolveConflict(mergeRun.runId, { itemId: 'b', decision: 'right' });
    mergeRun = await service.finalize(mergeRun.runId);
    assert.equal(mergeRun.state, 'completed');
    assert.equal(mergeRun.checkpoints.at(-1).mergeReceipt.written, 2);
    assert.deepEqual(mergeRun.phases.map((item) => item.phase), ['picked', 'parsed', 'staged', 'analyzing', 'review', 'merging', 'promoting', 'completed']);

    const missing = await store.create({ importId: 'missing-staging', state: 'staged' });
    const missingSnapshot = await service.resume(missing.runId);
    assert.equal(missingSnapshot.state, 'interrupted');
    assert.equal(missingSnapshot.error.code, 'staging_missing');
    assert.equal(missingSnapshot.phases.at(-1).phase, 'interrupted');

    const timeoutService = new ImportSagaService({
      store: new ImportRunStore({ root: path.join(root, 'timeout-runs') }), staging,
      fileParser: { parseNovelFiles: async () => new Promise(() => {}) },
      analyzer, merge, novels, stagingRoot: path.join(root, 'staging'), deadlines: { parse: 15 },
    });
    const timedOut = await timeoutService.start({ filePaths: ['/source/timeout.md'] });
    assert.equal(timedOut.state, 'interrupted');
    assert.equal(timedOut.error.code, 'import_timeout');
    assert.equal(timedOut.checkpoints.length, 0, 'parse timeout cannot create a staging checkpoint');
    assert.deepEqual(timedOut.phases.map((item) => item.phase), ['picked', 'interrupted']);
    console.log('TEST_PASS import-saga-regression');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

if (require.main === module) run().catch((error) => { console.error(`TEST_FAIL import-saga-regression: ${error.stack || error}`); process.exitCode = 1; });
module.exports = { run };
