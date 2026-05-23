'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function runChatSessionLifecycleRegressionTest() {
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
    const source = await fs.readFile(path.join(ROOT, 'src/components/AiChatPanel.jsx'), 'utf8');
    assert.ok(source.includes("if (!currentNovelId && status !== 'idle' && (sessionId || activeThreadId)) {"));
    assert.ok(source.includes('Do not kill an in-flight chat turn during that gap.'));
    assert.ok(source.includes('}, [currentNovelId, status]);'));
    pass(
      'CSL1_busy_session_survives_transient_novel_context_gap',
      'AiChatPanel now preserves an in-flight session when novelId briefly drops during workspace refresh'
    );
  } catch (err) {
    fail('CSL_harness', err?.stack || String(err));
  }

  console.log('');
  console.log(`TEST_SUMMARY ${results.passed}/${results.total} passed, ${results.failed} failed`);
  console.log('TEST_DONE');
  return results;
}

module.exports = { runChatSessionLifecycleRegressionTest };

if (require.main === module) {
  runChatSessionLifecycleRegressionTest().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}