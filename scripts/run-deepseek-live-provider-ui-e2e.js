'use strict';

const { spawn } = require('node:child_process');
const fsp = require('node:fs/promises');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const USER_ROOT = path.join(ROOT, 'artifacts', 'deepseek-live-acceptance', 'provider-user-data');
const SOURCE_ROOT = process.env.MANA_DEEPSEEK_KEY_SOURCE_ROOT || path.join(process.env.HOME || '', 'Library', 'Application Support', 'MultiAgentNovelAssistant-dev', 'MultiAgentNovelAssistant');

function electronBinary() {
  if (process.platform === 'darwin') return path.join(ROOT, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron');
  if (process.platform === 'win32') return path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
  return path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron');
}

async function run() {
  await fsp.rm(USER_ROOT, { recursive: true, force: true });
  await fsp.mkdir(USER_ROOT, { recursive: true });
  await new Promise((resolve, reject) => {
    const child = spawn(electronBinary(), ['.', '--test-deepseek-live-provider'], {
      cwd: ROOT,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: undefined,
        NODE_ENV: 'production',
        MANA_AUTOMATED_TEST: '1',
        MANA_USER_DATA_ROOT: USER_ROOT,
        MANA_DEEPSEEK_KEY_SOURCE_ROOT: SOURCE_ROOT,
      },
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`DeepSeek live Provider UI exited with ${code}`)));
  });
}

run().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
