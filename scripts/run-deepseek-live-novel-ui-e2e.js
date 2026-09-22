'use strict';

const { spawn } = require('node:child_process');
const fsp = require('node:fs/promises');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const USER_ROOT = path.join(ROOT, 'artifacts', 'deepseek-live-acceptance', 'provider-user-data');
const NOVEL_DIR = process.env.MANA_LIVE_NOVEL_DIR || path.join(ROOT, 'artifacts', 'deepseek-live-acceptance', 'novel');

function electronBinary() {
  if (process.platform === 'darwin') return path.join(ROOT, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron');
  if (process.platform === 'win32') return path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
  return path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron');
}

async function run() {
  await fsp.mkdir(USER_ROOT, { recursive: true });
  process.env.MANA_USER_DATA_ROOT = USER_ROOT;
  const modelConfig = require('../src/main/modelConfig');
  const novels = require('../src/main/store/novels');
  const appConfig = require('../src/main/store/appConfig');
  const state = await modelConfig.load();
  if (!/^deepseek-(?:v4-)?flash$/.test(state.activeSelection?.modelId || '')) throw new Error('Run the DeepSeek live Provider acceptance first; Flash is not active');
  const novel = await novels.createNovel({ title: '潮汐邮局', dir: NOVEL_DIR });
  await appConfig.save({ lastNovelId: novel.id, lastNovelDir: novel.dir });
  await new Promise((resolve, reject) => {
    const child = spawn(electronBinary(), ['.', '--test-deepseek-live-novel'], {
      cwd: ROOT,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, NODE_ENV: 'production', MANA_AUTOMATED_TEST: '1', MANA_USER_DATA_ROOT: USER_ROOT, MANA_LIVE_NOVEL_ID: novel.id },
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`DeepSeek live novel UI exited with code=${code}, signal=${signal || 'none'}`)));
  });
}

run().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
