'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function run() {
  const ROOT = path.resolve(__dirname, '..');
  const tmpRoot = path.join(ROOT, 'tmp-test-harness-postwrite-state');
  process.env.MANA_USER_DATA_ROOT = path.join(tmpRoot, 'userdata');
  process.env.MANA_USE_STDIO_MCP = '0';
  await fs.rm(tmpRoot, { recursive: true, force: true });
  const novelDir = path.join(tmpRoot, 'novel');
  await fs.mkdir(novelDir, { recursive: true });
  const activeContextPath = path.join(ROOT, 'src/main/runtime/activeNovelContext.js');
  const coordinatorPath = path.join(ROOT, 'src/main/runtime/chapterPostWriteCoordinator.js');
  const originalContextCache = require.cache[activeContextPath];
  const originalCoordinatorCache = require.cache[coordinatorPath];
  try {
    require.cache[activeContextPath] = {
      id: activeContextPath,
      filename: activeContextPath,
      loaded: true,
      exports: { getActiveNovelContext: () => ({ novelId: 'benchmark', novelDir }) },
    };
    delete require.cache[coordinatorPath];
    const jobs = require('../src/main/store/chapterPostWriteJobs');
    const draft = {
      name: 'chapter-001.md',
      text: '确认写入后的正文。',
      eventLedger: { events: [] },
      stateVerifications: [{ sceneId: 'chapter', merged: { worldState: { doorOpen: true } }, status: 'verified', confidence: 1 }],
    };
    await jobs.ensureJob({ draftId: 'draft-state', draft });
    await jobs.updateStep('draft-state', 'chapterWrite', 'done');
    for (const step of ['summary', 'timeline', 'outline', 'characterMemory', 'deAiReview']) await jobs.updateStep('draft-state', step, 'skipped');
    const coordinator = require(coordinatorPath);
    const first = await coordinator.runPostWriteJob({ draftId: 'draft-state' });
    assert.equal(first.job.steps.harnessState.status, 'done');
    assert.equal(first.job.status, 'complete');
    const stateStore = require('../src/main/store/chapterHarnessState');
    const saved = await stateStore.readChapterState(novelDir, draft.name, { expectedContent: draft.text });
    assert.equal(saved.worldState.doorOpen, true);
    const attempts = first.job.steps.harnessState.attempts;
    const second = await coordinator.runPostWriteJob({ draftId: 'draft-state' });
    assert.equal(second.job.steps.harnessState.attempts, attempts);
    console.log('TEST_PASS chapter-harness-postwrite-state');
  } finally {
    if (originalContextCache) require.cache[activeContextPath] = originalContextCache;
    else delete require.cache[activeContextPath];
    if (originalCoordinatorCache) require.cache[coordinatorPath] = originalCoordinatorCache;
    else delete require.cache[coordinatorPath];
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
}

if (require.main === module) run().catch((err) => { console.error(err); process.exitCode = 1; });

module.exports = { run };
