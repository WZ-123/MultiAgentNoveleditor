'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function runChapterSaveSnapshotRegressionTest() {
  const ROOT = path.resolve(__dirname, '..');
  const results = { total: 0, passed: 0, failed: 0 };

  function pass(name, detail) {
    results.total += 1;
    results.passed += 1;
    console.log(`TEST_PASS ${name}${detail ? ': ' + detail : ''}`);
  }

  function fail(name, reason) {
    results.total += 1;
    results.failed += 1;
    console.log(`TEST_FAIL ${name}: ${reason}`);
  }

  try {
    const ipcCode = await fs.readFile(path.join(ROOT, 'src/main/ipc/novel.js'), 'utf8');
    assert.ok(ipcCode.includes('async function buildChapterSaveSnapshot('));
    assert.ok(ipcCode.includes('displayName: novelData.computeChapterDisplayName('));
    assert.ok(ipcCode.includes('metadata: finalMeta,'));
    pass('CSS1_ipc_save_returns_normalized_snapshot', 'saveChapter IPC now returns title/displayName metadata alongside the file result');

    const appCode = await fs.readFile(path.join(ROOT, 'src/App.jsx'), 'utf8');
    assert.ok(appCode.includes('const applySavedChapterSnapshot = useCallback('));
    assert.match(appCode, /const saved = await window\.mana\.novel\.saveChapter\(\s*activeNovelId,\s*name,\s*content,\s*\{ title: chapTitle \}/u);
    assert.ok(appCode.includes('applySavedChapterSnapshot(chapterId, saved, { content, isContentLoaded: true, isDirty: false });'));
    assert.ok(appCode.includes('.then((saved) => applySavedChapterSnapshot(chapterId, saved, { content: ch.content, isContentLoaded: true, isDirty: false }))'));
    pass('CSS2_renderer_reconciles_after_save', 'manual save, autosave, and close-tab save all reapply the canonical title/displayName snapshot');
  } catch (err) {
    fail('CSS_harness', err?.stack || String(err));
  }

  console.log('');
  console.log(`TEST_SUMMARY ${results.passed}/${results.total} passed, ${results.failed} failed`);
  console.log('TEST_DONE');
  return results;
}

module.exports = { runChapterSaveSnapshotRegressionTest };

if (require.main === module) {
  runChapterSaveSnapshotRegressionTest().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
