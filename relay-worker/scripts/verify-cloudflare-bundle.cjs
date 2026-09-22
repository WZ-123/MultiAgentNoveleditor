'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const prepare = spawnSync(process.execPath, ['scripts/prepare-deploy-config.cjs', '--placeholder'], {
  cwd: ROOT,
  stdio: 'inherit',
});
if (prepare.status !== 0) process.exit(prepare.status || 1);
const wrangler = process.platform === 'win32' ? 'node_modules/.bin/wrangler.cmd' : 'node_modules/.bin/wrangler';
const result = spawnSync(wrangler, ['deploy', '--dry-run', '--config', '.wrangler/generated-release.toml'], {
  cwd: ROOT,
  stdio: 'inherit',
  env: {
    ...process.env,
    WRANGLER_LOG_PATH: path.join(ROOT, '.wrangler', 'logs'),
    WRANGLER_SEND_METRICS: 'false',
  },
  shell: process.platform === 'win32',
});
process.exit(result.status || 0);
