'use strict';

const path = require('node:path');
const { runElectronCase } = require('./electron-test-runner');

const root = path.resolve(__dirname, '..');
const artifactRoot = path.join(root, 'artifacts', 'luna-50k-acceptance');
runElectronCase({
  label: 'codex-subscription-ui',
  appRoot: root,
  flags: ['--test-codex-subscription-ui'],
  userDataRoot: path.join(artifactRoot, 'user-data'),
  artifactRoot,
  env: { NODE_ENV: 'production' },
  startupTimeoutMs: 60_000,
  testTimeoutMs: 300_000,
  teardownTimeoutMs: 15_000,
}).then((receipt) => {
  console.log(JSON.stringify(receipt, null, 2));
  if (receipt.status !== 'passed') process.exitCode = 1;
}).catch((error) => { console.error(error); process.exitCode = 1; });
