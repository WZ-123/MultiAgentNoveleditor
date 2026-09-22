#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { runElectronCase } = require('./electron-test-runner');

const ROOT = path.resolve(__dirname, '..');
const CASES = Object.freeze([
  ['ui', '--test-ui'],
  ['datatab-ui', '--test-datatab-edit-ui'],
  ['editor-review', '--test-editor-review-ui-regression'],
  ['assets-ui', '--test-assets-ui-regression'],
  ['chat-timeline', '--test-chat-timeline-regression'],
  ['chat-replace', '--test-chat-replace-regression'],
  ['chat-outline', '--test-chat-outline-ui-regression'],
  ['chat-writing', '--test-chat-writing-ui-regression'],
  ['chat-de-ai', '--test-chat-de-ai-ui-regression'],
  ['chat-feedback', '--test-chat-feedback-ui-regression'],
  ['codex-runtime', '--test-codex-runtime-p4-ui-regression'],
]);

async function main() {
  const selected = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
  const cases = selected.length ? CASES.filter(([label]) => selected.includes(label)) : CASES;
  if (cases.length === 0) throw new Error(`no Electron UI cases matched: ${selected.join(', ')}`);
  const receipts = [];
  for (const [label, flag] of cases) {
    console.log(`[electron-runner] ${label} ${flag}`);
    const receipt = await runElectronCase({
      appRoot: ROOT,
      label,
      flag,
      startupTimeoutMs: 60_000,
      testTimeoutMs: 240_000,
      teardownTimeoutMs: 10_000,
      keepUserDataOnFailure: true,
    });
    receipts.push(receipt);
    console.log(`${receipt.status === 'passed' ? 'TEST_PASS' : 'TEST_FAIL'} ELECTRON_RUNNER_${label} ${JSON.stringify(receipt)}`);
  }
  const failed = receipts.filter((receipt) => receipt.status !== 'passed');
  console.log(`TEST_SUMMARY electron-ui-suite ${receipts.length - failed.length}/${receipts.length} passed`);
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((error) => {
  console.error('TEST_FAIL electron_ui_suite', error?.stack || error);
  process.exitCode = 1;
});
