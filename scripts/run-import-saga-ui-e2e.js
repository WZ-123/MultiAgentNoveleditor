#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { runElectronCase } = require('./electron-test-runner');

const root = path.resolve(__dirname, '..');
runElectronCase({
  appRoot: root,
  label: 'import-saga-ui',
  flag: '--test-import-saga-ui-regression',
  startupTimeoutMs: 60_000,
  testTimeoutMs: 120_000,
  teardownTimeoutMs: 10_000,
  keepUserDataOnFailure: true,
}).then((receipt) => {
  console.log(`${receipt.status === 'passed' ? 'TEST_PASS' : 'TEST_FAIL'} IMPORT_SAGA_UI_RUNNER ${JSON.stringify(receipt)}`);
  process.exitCode = receipt.status === 'passed' ? 0 : 1;
}).catch((error) => {
  console.error('TEST_FAIL IMPORT_SAGA_UI_RUNNER', error?.stack || error);
  process.exitCode = 1;
});
