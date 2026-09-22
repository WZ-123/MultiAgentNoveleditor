'use strict';

const { spawn } = require('node:child_process');
const fsp = require('node:fs/promises');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const USER_ROOT = path.join(ROOT, 'artifacts', 'deepseek-live-acceptance', 'provider-user-data');
const NOVEL_DIR = path.join(ROOT, 'artifacts', 'deepseek-live-acceptance', 'novella-27');
const STATE_FILE = path.join(ROOT, 'artifacts', 'deepseek-live-acceptance', 'novella-27-state.json');
const REWRITE_BLOCKS_FILE = path.join(ROOT, 'artifacts', 'deepseek-live-acceptance', 'novella-27-rewrite-blocks.json');
const CONSISTENCY_REPORTS_FILE = path.join(ROOT, 'artifacts', 'deepseek-live-acceptance', 'novella-27-consistency-reports.json');

function electronBinary() {
  if (process.platform === 'darwin') return path.join(ROOT, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron');
  if (process.platform === 'win32') return path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
  return path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron');
}

async function run() {
  process.env.MANA_USER_DATA_ROOT = USER_ROOT;
  const modelConfig = require('../src/main/modelConfig');
  const novels = require('../src/main/store/novels');
  const appConfig = require('../src/main/store/appConfig');
  const state = await modelConfig.load();
  const selection = state.activeSelection;
  const connection = state.connections.find((item) => item.id === selection?.connectionId);
  if (selection?.modelId !== 'deepseek-v4-flash' || selection?.reasoningEffort !== 'none') throw new Error('DeepSeek V4 Flash no-reasoning mode is not active');
  if (connection?.baseUrl !== 'https://api.deepseek.com') throw new Error('27-chapter acceptance requires the official production DeepSeek connection');
  if (process.env.MANA_NOVELLA_FRESH === '1') {
    await fsp.rm(NOVEL_DIR, { recursive: true, force: true });
    await fsp.rm(STATE_FILE, { force: true });
    await fsp.rm(REWRITE_BLOCKS_FILE, { force: true });
    await fsp.rm(CONSISTENCY_REPORTS_FILE, { force: true });
  }
  let novel = null;
  const prior = JSON.parse(await fsp.readFile(STATE_FILE, 'utf8').catch(() => '{}'));
  if (prior.novelId) novel = await novels.getNovelById(prior.novelId);
  if (!novel || novel.dir !== NOVEL_DIR) {
    novel = await novels.createNovel({ title: '雾港回声', dir: NOVEL_DIR });
    await fsp.writeFile(STATE_FILE, `${JSON.stringify({ novelId: novel.id, novelDir: novel.dir, createdAt: new Date().toISOString() }, null, 2)}\n`, 'utf8');
  }
  await appConfig.save({ lastNovelId: novel.id, lastNovelDir: novel.dir });
  await new Promise((resolve, reject) => {
    const child = spawn(electronBinary(), ['.', '--test-deepseek-live-novel'], {
      cwd: ROOT,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, NODE_ENV: 'production', MANA_AUTOMATED_TEST: '1', MANA_USER_DATA_ROOT: USER_ROOT, MANA_LIVE_NOVEL_ID: novel.id, MANA_LIVE_NOVELLA_27: '1' },
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`DeepSeek 27-chapter acceptance exited with code=${code}, signal=${signal || 'none'}`)));
  });
}

run().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
