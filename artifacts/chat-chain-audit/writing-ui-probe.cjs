'use strict';
// Run with Electron. Uses the production renderer, preload, IPC and isolated disk.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const ROOT = path.resolve(__dirname, '../..');
const temp = fsSync.mkdtempSync(path.join(os.tmpdir(), 'mana-writing-ui-audit-'));
process.env.MANA_USER_DATA_ROOT = path.join(temp, 'data');
process.env.MANA_AUTOMATED_TEST = '1';
app.setPath('userData', process.env.MANA_USER_DATA_ROOT);
app.commandLine.appendSwitch('mute-audio');
app.on('web-contents-created', (_event, contents) => contents.setAudioMuted(true));
let fake;
let win;
async function wait(expression) {
  const start = Date.now();
  while (Date.now() - start < 45000) {
    if (await win.webContents.executeJavaScript('Boolean(' + expression + ')')) return;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('UI probe timeout: ' + expression);
}
async function shot(name) {
  await win.webContents.executeJavaScript('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
  await fs.writeFile(path.join(__dirname, 'writing-evidence', name), (await win.capturePage()).toPNG());
}
async function send(text) {
  await win.webContents.executeJavaScript(`(() => {const el=document.querySelector('[data-testid="codex-input"]'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,${JSON.stringify(text)});el.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await new Promise(r => setTimeout(r, 100));
  await win.webContents.executeJavaScript(`document.querySelector('button[aria-label="发送"]').click()`);
}
app.whenReady().then(async () => {
  const { createFakeResponsesServer } = require(path.join(ROOT, 'test/fixtures/fake-responses-server'));
  let plan = [];
  fake = await createFakeResponsesServer({ respond: () => plan.shift() || { text: '替身回合结束。' } });
  const data = require(path.join(ROOT, 'src/main/store/novelData'));
  const novel = await require(path.join(ROOT, 'src/main/store/novels')).createNovel({ title: '写作功能审计', dir: path.join(temp, 'novel') });
  await data.writeCharacter(novel.dir, { id: 'lin', name: '林岚', personality: '谨慎', relationships: { su: '信任，但尚未告知旧案真相' } });
  await data.writeChapterWithMeta(novel.dir, 'chapter-001.md', '城门九点关闭。', {}, { baseContent: '' });
  await data.writeChapterWithMeta(novel.dir, 'chapter-002.md', '十点时守门人说城门从未关闭。', {}, { baseContent: '' });
  await data.writeWorld(novel.dir, { lore: '城门每晚九点关闭。' });
  await require(path.join(ROOT, 'src/main/store/appConfig')).save({ lastNovelId: novel.id, lastNovelDir: novel.dir });
  const model = require(path.join(ROOT, 'src/main/modelConfig'));
  await model.saveCredential({ id: 'fixture', apiKey: 'audit-fixture-secret' });
  await model.saveConnection({ id: 'fixture', name: 'Audit Fixture', credentialId: 'fixture', baseUrl: fake.origin, templateId: 'deepseek', auth: { mode: 'bearer' }, models: [{ id: 'deepseek-v4-flash', name: 'Fixture', verification: { responses: 'ok', tools: 'ok' } }] });
  await model.setActive({ connectionId: 'fixture', modelId: 'deepseek-v4-flash', reasoningEffort: null });
  await require(path.join(ROOT, 'src/main/index')).initBackend();
  win = new BrowserWindow({ width: 1400, height: 1000, webPreferences: { preload: path.join(ROOT, 'preload.js'), nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  await win.loadFile(path.join(ROOT, 'dist/index.html'));
  await wait(`document.querySelector('[data-testid="codex-input"]') && !document.querySelector('[data-testid="codex-input"]').disabled`);
  await win.webContents.executeJavaScript(`document.querySelector('button[title="在编辑器中打开角色卡"]').click()`);
  await wait(`document.querySelector('button[aria-label="编辑角色卡 林岚"]')`);
  await win.webContents.executeJavaScript(`document.querySelector('button[aria-label="编辑角色卡 林岚"]').click()`);
  await wait(`document.body.innerText.includes('暂无关系记录')`);
  await win.webContents.executeJavaScript(`[...document.querySelectorAll('div')].find(el=>el.innerText==='暂无关系记录')?.scrollIntoView({block:'center'})`);
  await shot('relationships-hidden-in-editor.png');
  await win.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(b=>b.innerText==='保存角色卡').click()`);
  await wait(`document.body.innerText.includes('已保存角色「林岚」')`);
  const after = await data.readCharacter(novel.dir, 'lin');
  assert.deepEqual(after.relationships, []);
  console.log('TEST_PASS actual character edit save silently erases object relationships; formal disk readback []');
  plan = [{ namespace: 'mcp__novel_tools', toolName: 'read_novel_resource', arguments: { resourceRef: 'chapter:chapter-001.md' } }, { text: '替身审校报告：只读取第一章。\n```json\n{"coveredResourceRefs":["chapter:chapter-001.md"],"issues":[]}\n```' }];
  await send('审校全书的人物和世界观一致性');
  await wait(`[...document.querySelectorAll('[data-testid="task-objective-status"]')].at(-1)?.innerText.includes('检查通过')`);
  await shot('whole-review-false-complete.png');
  console.log('TEST_PASS actual chat entry accepts whole novel review after one chapter only');
  plan = [{ namespace: 'mcp__novel_tools', toolName: 'read_novel_resource', arguments: { resourceRef: 'character:missing' } }, { text: '尝试恢复查询。' }];
  await send('读取不存在的角色卡，找不到时修正查询');
  await wait(`document.querySelector('[data-testid="codex-error"]')?.innerText.includes('mcpToolCall执行失败')`);
  await shot('missing-character-generic-error.png');
  console.log('TEST_PASS actual chat entry shows generic internal tool type and aborts a recoverable lookup');
  await fs.writeFile(path.join(__dirname, 'writing-ui-probe-results.json'), JSON.stringify({ date: '2026-10-18', evidence: 'production renderer/preload/IPC + native App Server + fake Responses; isolated disk', characterRelationshipsAfterSave: after.relationships, checks: 3, screenshots: ['relationships-hidden-in-editor.png', 'whole-review-false-complete.png', 'missing-character-generic-error.png'] }, null, 2) + '\n');
  await fake.close();
  win.destroy();
  await fs.rm(temp, { recursive: true, force: true });
  app.exit(0);
}).catch(async error => {
  console.error(error);
  if (win) await shot('ui-probe-failure.png').catch(() => {});
  if (fake) await fake.close();
  app.exit(1);
});
