'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runManagedCase } = require('../scripts/electron-test-runner');

const ROOT = path.resolve(__dirname, '..');
const fixture = path.join(ROOT, 'test/fixtures/electron-runner-child.js');

async function run(mode, overrides = {}) {
  const artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mana-runner-artifacts-'));
  return runManagedCase({
    executable: process.execPath,
    args: [fixture, mode],
    cwd: ROOT,
    label: `runner-${mode}`,
    artifactRoot,
    startupTimeoutMs: 500,
    testTimeoutMs: 500,
    teardownTimeoutMs: 500,
    keepUserDataOnFailure: true,
    ...overrides,
  });
}

(async () => {
  const passed = await run('pass');
  assert.equal(passed.status, 'passed');
  assert.equal(passed.markers.passed.length, 1);
  assert.match(fs.readFileSync(passed.logPath, 'utf8'), /fixture stderr captured/u);
  assert.equal(fs.existsSync(passed.userDataRoot), false, 'successful case removes its isolated temporary root');

  const failed = await run('fail-marker');
  assert.equal(failed.status, 'failed');
  assert.equal(failed.errorCode, 'assertion_failed');
  assert.equal(fs.existsSync(failed.userDataRoot), true, 'failed case retains its isolated user data');

  const noTerminal = await run('no-terminal');
  assert.equal(noTerminal.status, 'failed');
  assert.equal(noTerminal.errorCode, 'terminal_marker_missing');

  const timedOut = await run('hang', { startupTimeoutMs: 150 });
  assert.equal(timedOut.status, 'timed_out');
  assert.equal(timedOut.errorCode, 'startup_timeout');

  console.log('TEST_PASS electron-test-runner-regression');
})().catch((error) => {
  console.error('TEST_FAIL electron-test-runner-regression', error?.stack || error);
  process.exitCode = 1;
});
