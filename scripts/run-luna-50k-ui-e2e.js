'use strict';

const path = require('node:path');
const { runElectronCase } = require('./electron-test-runner');
const { auditLunaAcceptance } = require('./audit-luna-acceptance');

const root = path.resolve(__dirname, '..');
const artifactRoot = path.join(root, 'artifacts', 'luna-50k-acceptance');
runElectronCase({
  label: 'luna-50k-ui', appRoot: root, flags: ['--test-luna-50k-ui'],
  userDataRoot: path.join(artifactRoot, 'user-data'), artifactRoot,
  env: { NODE_ENV: 'production' }, startupTimeoutMs: 60_000,
  testTimeoutMs: 65 * 60 * 1000, teardownTimeoutMs: 20_000,
}).then(async (receipt) => {
  const audit = await auditLunaAcceptance(artifactRoot);
  console.log(JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify({ acceptanceAudit: audit.report, reportFile: audit.reportFile }, null, 2));
  if (receipt.status !== 'passed' || audit.report.overallStatus === 'failed') process.exitCode = 1;
}).catch((error) => { console.error(error); process.exitCode = 1; });
