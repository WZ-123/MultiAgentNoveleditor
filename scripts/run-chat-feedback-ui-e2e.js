'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
async function run() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mana-feedback-ui-'));
  process.env.MANA_USER_DATA_ROOT = root;
  try {
    const novels = require('../src/main/store/novels');
    const novelData = require('../src/main/store/novelData');
    const config = require('../src/main/store/appConfig');
    const history = require('../src/main/store/chatHistory');
    const novel = await novels.createNovel({ title: '反馈隔离验收', dir: path.join(root, 'novel') });
    await novelData.writeChapterWithMeta(novel.dir, 'chapter-001.md', 'PRIVATE_BODY 这是隔离测试正文。', {}, { baseContent: '' });
    await config.save({ lastNovelId: novel.id, lastNovelDir: novel.dir, feishuSync: { enabled: false } });
    const thread = await history.createThread({ title: '反馈验收对话', novelId: novel.id });
    await history.appendMessage(thread.id, { id: 'qa-user', role: 'user', text: 'PRIVATE_CHAT 测试提示词' });
    await history.appendMessage(thread.id, { id: 'qa-assistant', role: 'assistant', text: 'PRIVATE_ANSWER 测试回复', toolCalls: [{ type: 'fileChange', input: { content: 'PRIVATE_TOOL' }, diff: 'PRIVATE_DIFF' }] });
    const binary = path.join(ROOT, 'node_modules/electron/dist', process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : process.platform === 'win32' ? 'electron.exe' : 'electron');
    await new Promise((resolve, reject) => {
      const child = spawn(binary, ['.', '--no-sandbox', '--test-chat-feedback-ui-regression', '--mute-audio'], {
        cwd: ROOT, stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, NODE_ENV: 'production', MANA_AUTOMATED_TEST: '1' },
      });
      const timeout = setTimeout(() => { child.kill(); reject(new Error('Feedback UI timeout')); }, 150000);
      child.once('error', error => { clearTimeout(timeout); reject(error); });
      child.once('exit', code => { clearTimeout(timeout); code === 0 ? resolve() : reject(new Error(`Feedback UI exited ${code}`)); });
    });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
