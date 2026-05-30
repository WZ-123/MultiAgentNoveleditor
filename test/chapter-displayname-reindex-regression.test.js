'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function runChapterDisplaynameReindexRegressionTest() {
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
    const appCode = await fs.readFile(path.join(ROOT, 'src/App.jsx'), 'utf8');
    assert.ok(appCode.includes('const refreshAllChapterDisplayNames = useCallback(async (novelId, baseNovel) => {'));
    assert.ok(appCode.includes('window.mana.novel.computeChapterDisplayName(novelId, index + 1, chapter._title || \'\')'));
    pass('CDR1_app_defines_shared_reindex_helper', 'renderer has a single helper to recompute display names after structural chapter changes');

    assert.ok(appCode.includes('refreshAllChapterDisplayNames(activeNovelId, nextNovel).catch(() => {});'));
    assert.ok(appCode.includes('refreshAllChapterDisplayNames(activeEntry.id, nextNovel).catch(() => {});'));
    assert.ok(appCode.includes('refreshAllChapterDisplayNames(activeNovelId, updated).catch(() => {});'));
    pass('CDR2_reindex_runs_on_create_delete_and_push_updates', 'create/delete flows and incremental chapter sync all trigger a full display-name refresh');
  } catch (err) {
    fail('CDR_harness', err?.stack || String(err));
  }

  console.log('');
  console.log(`TEST_SUMMARY ${results.passed}/${results.total} passed, ${results.failed} failed`);
  console.log('TEST_DONE');
  return results;
}

module.exports = { runChapterDisplaynameReindexRegressionTest };

if (require.main === module) {
  runChapterDisplaynameReindexRegressionTest().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
