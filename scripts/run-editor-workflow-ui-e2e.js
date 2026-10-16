'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const ROOT = path.resolve(__dirname, '..');
async function run() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mana-editor-workflow-ui-'));
  process.env.MANA_USER_DATA_ROOT = root;
  try {
    const novels = require('../src/main/store/novels');
    const data = require('../src/main/store/novelData');
    const config = require('../src/main/store/appConfig');
    const a = await novels.createNovel({ title: '编辑安全验收甲', dir: path.join(root, 'novel-a') });
    const b = await novels.createNovel({ title: '编辑安全验收乙', dir: path.join(root, 'novel-b') });
    for (const entry of [a, b]) await data.writeChapterWithMeta(entry.dir, 'chapter-001.md', entry === a ? '甲项目原稿' : '乙项目原稿', { volume: 1, section: 2 }, { baseContent: '' });
    await novels.saveNovelMeta(a.id, { structure: { version: 2, volumes: [
      { id: 'qa-v1', name: '同名卷', sections: [{ id: 'qa-s1', name: '同名节', chapterFiles: [] }, { id: 'qa-s2', name: '同名节', chapterFiles: ['chapter-001.md'] }] },
      { id: 'qa-v2', name: '同名卷', sections: [{ id: 'qa-s3', name: '同名节', chapterFiles: [] }] },
      { id: 'qa-empty', name: '空卷', sections: [] },
    ] } });
    await config.save({ lastNovelId: a.id, lastNovelDir: a.dir, feishuSync: { enabled: false } });
    const binary = path.join(ROOT, 'node_modules/electron/dist', process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : process.platform === 'win32' ? 'electron.exe' : 'electron');
    for (const phase of ['1', '2']) await new Promise((resolve, reject) => {
      const child = spawn(binary, ['.', '--test-editor-workflow-ui', '--mute-audio'], { cwd: ROOT, stdio: 'inherit', env: {
        ...process.env, ELECTRON_RUN_AS_NODE: undefined, MANA_AUTOMATED_TEST: '1', NODE_ENV: 'production',
        MANA_EDITOR_UI_A: a.id, MANA_EDITOR_UI_B: b.id, MANA_EDITOR_UI_PHASE: phase,
      } });
      const timeout = setTimeout(() => { child.kill(); reject(new Error('Editor workflow UI timeout')); }, 150000);
      child.once('error', error => { clearTimeout(timeout); reject(error); });
      child.once('exit', code => { clearTimeout(timeout); code === 0 ? resolve() : reject(new Error(`Editor workflow UI phase ${phase} exited ${code}`)); });
    });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
