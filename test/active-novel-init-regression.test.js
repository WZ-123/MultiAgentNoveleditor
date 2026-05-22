'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function runActiveNovelInitRegressionTest() {
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
    const workspaceSwitcherCode = await fs.readFile(path.join(ROOT, 'src/components/WorkspaceSwitcher.jsx'), 'utf8');

    assert.equal(appCode.includes('setInterval(check, 3000)'), false);
    assert.ok(appCode.includes('hasInitializedActiveNovelRef'));
    assert.ok(appCode.includes('refreshActiveNovelState'));
    pass('ANI1_app_checks_active_novel_once_on_startup', 'App no longer polls novel.active every 3 seconds and now guards the startup check with a one-time ref');

    assert.ok(workspaceSwitcherCode.includes('onActiveNovelChanged'));
    assert.ok(workspaceSwitcherCode.includes('await onActiveNovelChanged?.();'));
    pass('ANI2_workspace_switcher_pushes_active_novel_updates', 'WorkspaceSwitcher explicitly notifies App after open/close/create/import flows');
  } catch (err) {
    fail('ANI_harness', err && err.stack ? err.stack : String(err));
  }

  console.log('');
  console.log(`TEST_SUMMARY ${results.passed}/${results.total} passed, ${results.failed} failed`);
  console.log('TEST_DONE');
  return results;
}

module.exports = { runActiveNovelInitRegressionTest };

if (require.main === module) {
  runActiveNovelInitRegressionTest().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}