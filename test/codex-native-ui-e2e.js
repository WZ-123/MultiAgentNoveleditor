'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const novelData = require('../src/main/store/novelData');
const novels = require('../src/main/store/novels');

const ROOT = path.resolve(__dirname, '..');
const shots = path.join(ROOT, 'qa-screenshots');

async function waitFor(win, expression, timeout = 45_000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await win.webContents.executeJavaScript(`Boolean(${expression})`)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`UI wait timed out: ${expression}`);
}
async function send(win, text) {
  await waitFor(win, `document.querySelector('[data-testid="codex-input"]') && !document.querySelector('[data-testid="codex-input"]').disabled`);
  await win.webContents.executeJavaScript(`(() => { const el=document.querySelector('[data-testid="codex-input"]'); const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set; setter.call(el, ${JSON.stringify(text)}); el.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  await new Promise((resolve) => setTimeout(resolve, 100));
  await win.webContents.executeJavaScript(`document.querySelector('button[aria-label="发送"]').click()`);
}
async function sendWithSkill(win, text, skillName) {
  await waitFor(win, `document.querySelector('[data-testid="codex-input"]') && !document.querySelector('[data-testid="codex-input"]').disabled`);
  await win.webContents.executeJavaScript(`window.dispatchEvent(new CustomEvent('mana:codex-prompt',{detail:{text:${JSON.stringify(text)},skillName:${JSON.stringify(skillName)}}}))`);
  await waitFor(win, `document.querySelector('[data-testid="codex-input"]')?.value === ${JSON.stringify(text)}`);
  await win.webContents.executeJavaScript(`document.querySelector('button[aria-label="发送"]').click()`);
}
async function screenshot(win, name) {
  await fsp.mkdir(shots, { recursive: true });
  await win.webContents.executeJavaScript('new Promise((resolve)=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  await new Promise((resolve) => setTimeout(resolve, 100));
  const image = await win.capturePage();
  const file = path.join(shots, name);
  await fsp.writeFile(file, image.toPNG());
  return file;
}
async function waitText(win, text) {
  await waitFor(win, `document.body.innerText.includes(${JSON.stringify(text)}) && !document.querySelector('[data-testid="codex-streaming-message"]')`);
}

async function runCodexNativeUiE2E(win) {
  const phase = process.env.MANA_CODEX_UI_PHASE || '1';
  await waitFor(win, `document.querySelector('[data-testid="codex-chat-panel"]')`);
  await waitFor(win, `document.querySelector('[data-testid="codex-input"]') && !document.querySelector('[data-testid="codex-input"]').disabled`);
  if (phase === '2') {
    await send(win, '重启后继续刚才的对话');
    await waitText(win, '重启后已从原生 thread 继续对话。');
    await screenshot(win, 'codex-native-restart-resume.png');
    return { failed: 0 };
  }

  await win.webContents.executeJavaScript(`document.querySelector('[data-testid="workspace-switcher-trigger"]').click()`);
  await waitFor(win, `document.querySelector('[data-testid="new-novel-writing-authorization"]')?.getBoundingClientRect().width > 0`);
  const newNovelAuthorization = await win.webContents.executeJavaScript(`(() => {
    const group=document.querySelector('[data-testid="new-novel-writing-authorization"]');
    return {text:group?.innerText||'',checked:group?.querySelector('input:checked')?.value||''};
  })()`);
  if (newNovelAuthorization.checked !== 'confirm-each-change' || !newNovelAuthorization.text.includes('允许在本项目内新增正文')) throw new Error('new novel authorization choices are missing or have the wrong default');
  await screenshot(win, 'codex-writing-authorization-choice.png');
  await win.webContents.executeJavaScript(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);

  await waitFor(win, `document.querySelector('[data-testid="writing-authorization-toggle"]')?.innerText.includes('逐次确认')`);
  await win.webContents.executeJavaScript(`document.querySelector('[data-testid="writing-authorization-toggle"]').click()`);
  await waitFor(win, `document.querySelector('[data-testid="writing-authorization-toggle"]')?.innerText.includes('新增正文已允许')`);
  await sendWithSkill(win, '连续创作三个完整场景，每个场景自然收束后保存，并在同一回合继续。', 'mana-fiction-writing');
  await waitText(win, '三个完整场景均已在同一回合中逐章保存。');
  await waitFor(win, `document.querySelector('[data-testid="codex-chat-panel"]')?.dataset.runState === 'completed' && document.querySelector('[data-testid="writing-progress"]')?.innerText.includes('chapter-004.md')`);
  await screenshot(win, 'codex-continuous-writing-progress.png');
  const continuousNovel = await novels.getNovelById(process.env.MANA_UI_NOVEL_ID);
  for (const chapter of ['chapter-002.md', 'chapter-003.md', 'chapter-004.md']) {
    if (!(await novelData.readChapter(continuousNovel.dir, chapter)).trim()) throw new Error(`${chapter} was not saved by the continuous native turn`);
  }
  await win.webContents.executeJavaScript(`document.querySelector('[data-testid="writing-authorization-toggle"]').click()`);
  await waitFor(win, `document.querySelector('[data-testid="writing-authorization-toggle"]')?.innerText.includes('逐次确认')`);

  await send(win, '普通问答：说明当前执行链');
  await waitText(win, '原生 Codex 问答已完成。');
  await screenshot(win, 'codex-native-chat.png');

  await win.webContents.executeJavaScript(`document.querySelector('button[title="在编辑器中打开角色卡"]').click()`);
  await waitFor(win, `document.body.innerText.includes('角色卡')`);
  await send(win, '人物卡修改：新增测试人物');
  await waitFor(win, `document.querySelector('[data-testid="codex-confirmation-card"]')`);
  await win.webContents.executeJavaScript(`[...document.querySelectorAll('[data-testid="codex-confirmation-card"] button')].find(b=>b.innerText.includes('确认写入')).click()`);
  await waitText(win, '人物卡已保存。');
  await waitFor(win, `document.body.innerText.includes('验收角色')`);
  if ((await novelData.readCharacter(continuousNovel.dir, 'qa-person')).name !== '验收角色') throw new Error('character not committed');
  await screenshot(win, 'chat-chain-character-refreshed.png');

  await send(win, '人物卡更新：修改现有人物的性格');
  await waitFor(win, `document.querySelector('[data-testid="codex-confirmation-card"]')`);
  await win.webContents.executeJavaScript(`[...document.querySelectorAll('[data-testid="codex-confirmation-card"] button')].find(b=>b.innerText.includes('确认写入')).click()`);
  await waitText(win, '已有人物卡更新完成。');
  await waitFor(win, `document.body.innerText.includes('果断')`);
  if ((await novelData.readCharacter(continuousNovel.dir, 'qa-person')).personality !== '果断') throw new Error('existing character update not committed');
  await screenshot(win, 'chat-chain-existing-character-updated.png');

  await win.webContents.executeJavaScript(`document.querySelector('button[title="在编辑器中打开世界观"]').click()`);
  await waitFor(win, `document.body.innerText.includes('沿海城邦。')`);
  await send(win, '资料页世界观修改：把沿海城邦改为群山城邦');
  await waitFor(win, `document.querySelector('[data-testid="codex-confirmation-card"]')`);
  await win.webContents.executeJavaScript(`[...document.querySelectorAll('[data-testid="codex-confirmation-card"] button')].find(b=>b.innerText.includes('确认写入')).click()`);
  await waitText(win, '世界观修改已完成。');
  await waitFor(win, `document.body.innerText.includes('群山城邦。') && !document.body.innerText.includes('沿海城邦。')`);
  if (!(await novelData.readWorld(continuousNovel.dir)).lore.includes('群山城邦。')) throw new Error('world not committed');
  await screenshot(win, 'chat-chain-world-refreshed.png');

  await win.webContents.executeJavaScript(`document.querySelector('[data-testid="data-tab-edit"]').click()`);
  await waitFor(win, `document.querySelector('[data-testid="data-tab-editor-textarea"]')`);
  await win.webContents.executeJavaScript(`(() => { const el=document.querySelector('[data-testid="data-tab-editor-textarea"]'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,'我的世界观草稿'); el.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  await send(win, '世界观脏稿冲突：把群山城邦改为沙漠城邦');
  await waitFor(win, `document.querySelector('[data-testid="codex-confirmation-card"]')`);
  await win.webContents.executeJavaScript(`[...document.querySelectorAll('[data-testid="codex-confirmation-card"] button')].find(b=>b.innerText.includes('确认写入')).click()`);
  await waitFor(win, `document.querySelector('[data-testid="codex-chat-panel"]')?.dataset.runState === 'completed' && document.querySelector('[data-testid="data-tab-save"]')?.disabled`);
  if (await win.webContents.executeJavaScript(`document.querySelector('[data-testid="data-tab-editor-textarea"]').value`) !== '我的世界观草稿') throw new Error('dirty world draft overwritten');
  await screenshot(win, 'chat-chain-world-dirty-conflict.png');
  await win.webContents.executeJavaScript(`[...document.querySelectorAll('[data-testid="data-tab-editor"] button')].find(b=>b.innerText.includes('取消')).click()`);
  await waitFor(win, `document.body.innerText.includes('沙漠城邦。')`);

  await send(win, '去 AI 味：对当前章节做最小改写');
  await waitFor(win, `document.querySelector('[data-testid="codex-confirmation-card"]')`);
  await win.webContents.executeJavaScript(`(() => { const el=document.querySelector('[data-testid="codex-input"]'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,'甲项目未发送草稿'); el.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  await win.webContents.reload();
  await waitFor(win, `document.querySelector('[data-testid="codex-confirmation-card"]') && document.querySelector('[data-testid="codex-input"]')?.value === '甲项目未发送草稿'`);
  await screenshot(win, 'codex-native-de-ai.png');
  // A pending approval must survive switching projects and conversations.
  const secondId = process.env.MANA_UI_SECOND_NOVEL_ID;
  await win.webContents.executeJavaScript(`document.querySelector('[data-testid="workspace-switcher-trigger"]').click()`);
  await waitFor(win, `document.querySelector('[data-novel-id="${secondId}"] [data-testid="switch-novel"]')`);
  await win.webContents.executeJavaScript(`document.querySelector('[data-novel-id="${secondId}"] [data-testid="switch-novel"]').click()`);
  await waitFor(win, `document.querySelector('[data-testid="workspace-switcher-trigger"]')?.innerText.includes('链路隔离乙')`);
  await waitFor(win, `!document.querySelector('[data-testid="codex-confirmation-card"]')`);
  await send(win, '乙项目问答');
  await waitText(win, '乙项目独立回答。');
  await screenshot(win, 'chat-chain-project-b.png');
  const originalId = process.env.MANA_UI_NOVEL_ID;
  await win.webContents.executeJavaScript(`document.querySelector('[data-testid="workspace-switcher-trigger"]').click()`);
  await waitFor(win, `document.querySelector('[data-novel-id="${originalId}"] [data-testid="switch-novel"]')`);
  await win.webContents.executeJavaScript(`document.querySelector('[data-novel-id="${originalId}"] [data-testid="switch-novel"]').click()`);
  await waitFor(win, `document.querySelector('[data-testid="codex-confirmation-card"]')`);
  if (await win.webContents.executeJavaScript(`document.querySelector('[data-testid="codex-input"]').value`) !== '甲项目未发送草稿') throw new Error('project draft was lost or crossed projects');
  await screenshot(win, 'chat-chain-restored-approval.png');

  await win.webContents.executeJavaScript(`document.querySelector('[data-testid="codex-confirmation-card"] details')?.setAttribute('open','')`);
  await waitFor(win, `document.querySelector('[data-testid="native-patch-line-added"]') && document.querySelector('[data-testid="native-patch-line-removed"]')`);
  const patchLineClasses = await win.webContents.executeJavaScript(`({
    added: document.querySelector('[data-testid="native-patch-line-added"]')?.className || '',
    removed: document.querySelector('[data-testid="native-patch-line-removed"]')?.className || '',
  })`);
  if (!patchLineClasses.added.includes('text-emerald') || !patchLineClasses.removed.includes('text-rose')) throw new Error('native patch diff does not distinguish added and removed lines');
  await screenshot(win, 'codex-native-write-confirmation.png');
  await win.webContents.executeJavaScript(`[...document.querySelectorAll('[data-testid="codex-confirmation-card"] button')].find((button)=>button.innerText.includes('确认写入')).click()`);
  await waitText(win, '改写已确认并写入。');

  const novel = await novels.getNovelById(process.env.MANA_UI_NOVEL_ID);
  if ((await novelData.readChapter(novel.dir, process.env.MANA_UI_CHAPTER_NAME)) !== '她很疲惫。\n') throw new Error('accepted mutation was not written');

  await sendWithSkill(win, '拒绝测试：提议再次覆盖当前章节', 'mana-de-ai');
  await waitFor(win, `document.querySelector('[data-testid="codex-confirmation-card"]')`);
  await win.webContents.executeJavaScript(`[...document.querySelectorAll('[data-testid="codex-confirmation-card"] button')].find((button)=>button.innerText.includes('拒绝')).click()`);
  await waitText(win, '写入已取消，正文保持不变。');
  if ((await novelData.readChapter(novel.dir, process.env.MANA_UI_CHAPTER_NAME)) !== '她很疲惫。\n') throw new Error('rejected mutation changed the chapter');
  const retainedSaveStatus = await win.webContents.executeJavaScript(`document.querySelector('[data-testid="writing-progress"]')?.innerText || ''`);
  if (!retainedSaveStatus.includes('最近保存：') || retainedSaveStatus.includes('最近保存：尚未保存')) throw new Error('a no-save follow-up erased the last successful save record');
  await screenshot(win, 'codex-native-rejected-write.png');
  await send(win, '缓慢回答停止测试');
  await waitFor(win, `document.querySelector('[data-testid="codex-streaming-message"]')?.innerText.includes('停止后应保留')`);
  await win.webContents.executeJavaScript(`document.querySelector('button[aria-label="停止"]').click()`);
  await waitFor(win, `!document.querySelector('[data-testid="codex-streaming-message"]') && document.body.innerText.includes('停止后应保留这段已显示文字。') && document.body.innerText.includes('已停止')`);
  await screenshot(win, 'chat-chain-stopped-history.png');

  await send(win, '保存后停止：先保存一处，再继续下一处');
  await waitFor(win, `document.querySelector('[data-testid="codex-confirmation-card"]')`);
  await win.webContents.executeJavaScript(`[...document.querySelectorAll('[data-testid="codex-confirmation-card"] button')].find(b=>b.innerText.includes('确认写入')).click()`);
  await waitFor(win, `document.querySelector('[data-testid="codex-streaming-message"]')?.innerText.includes('第一处已保存')`);
  await win.webContents.executeJavaScript(`document.querySelector('button[aria-label="停止"]').click()`);
  await waitFor(win, `document.querySelector('[data-testid="codex-chat-panel"]')?.dataset.runState === 'interrupted' && document.body.innerText.includes('此前保存已保留，后续内容未完成')`);
  if (!(await novelData.readChapter(novel.dir, 'chapter-005.md')).includes('已经正式保存的第一处。')) throw new Error('stop rolled back committed content');
  await screenshot(win, 'chat-chain-partial-save-stopped.png');

  async function queueEditorCommand(start, end, label) {
    await win.webContents.executeJavaScript(`document.querySelector('[data-chapter-file="chapter-006.md"]').click()`);
    await waitFor(win, `document.querySelector('[data-testid="chapter-editor-compat-textarea"]')?.value.includes('甲')`);
    await win.webContents.executeJavaScript(`document.querySelector('[data-testid="chapter-editor-compat-textarea"]').setSelectionRange(${start},${end})`);
    await new Promise(resolve => setTimeout(resolve, 100));
    await win.webContents.executeJavaScript(`document.querySelector('.cm-content').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:500,clientY:200}))`);
    await waitFor(win, `document.querySelector('[role="menu"]')`);
    await win.webContents.executeJavaScript(`[...document.querySelectorAll('[role="menu"] button')].find(b=>b.innerText.includes(${JSON.stringify(label)})).click()`);
    await waitFor(win, `document.querySelector('[data-testid="chat-edit-scope"]')?.innerText.includes('chapter-006.md')`);
  }
  await queueEditorCommand(1, 2, 'AI 重写选中段落');
  await win.webContents.executeJavaScript(`document.querySelector('[data-chapter-file="chapter-001.md"]').click()`);
  await waitFor(win, `document.querySelector('[data-testid="chapter-editor-compat-textarea"]')?.value.includes('她很疲惫')`);
  await win.webContents.executeJavaScript(`document.querySelector('button[aria-label="发送"]').click()`);
  await waitFor(win, `document.querySelector('[data-testid="codex-confirmation-card"]')`);
  await screenshot(win, 'chat-chain-bound-selection.png');
  await win.webContents.executeJavaScript(`[...document.querySelectorAll('[data-testid="codex-confirmation-card"] button')].find(b=>b.innerText.includes('确认写入')).click()`);
  await waitFor(win, `document.querySelector('[data-testid="codex-chat-panel"]')?.dataset.runState === 'completed'`);
  if (await novelData.readChapter(novel.dir, 'chapter-006.md') !== '甲丁丙。\n') throw new Error('queued selection target changed');
  if (await novelData.readChapter(novel.dir, 'chapter-001.md') !== '她很疲惫。\n') throw new Error('switching chapter redirected queued edit');

  await queueEditorCommand(2, 2, '在光标处续写');
  await win.webContents.executeJavaScript(`document.querySelector('button[aria-label="发送"]').click()`);
  await waitFor(win, `document.querySelector('[data-testid="codex-confirmation-card"]')`);
  await win.webContents.executeJavaScript(`[...document.querySelectorAll('[data-testid="codex-confirmation-card"] button')].find(b=>b.innerText.includes('确认写入')).click()`);
  await waitFor(win, `document.querySelector('[data-testid="codex-chat-panel"]')?.dataset.runState === 'completed'`);
  if (await novelData.readChapter(novel.dir, 'chapter-006.md') !== '甲丁新增丙。\n') throw new Error('insertion changed content outside the cursor');
  await waitFor(win, `document.querySelector('[data-testid="chapter-editor-compat-textarea"]')?.value === '甲丁新增丙。\\n'`);
  await screenshot(win, 'chat-chain-insertion.png');

  await queueEditorCommand(1, 2, 'AI 重写选中段落');
  await win.webContents.executeJavaScript(`(() => { const el=document.querySelector('[data-testid="chapter-editor-compat-textarea"]'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,'新的章节版本。\\n'); el.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  await win.webContents.executeJavaScript(`document.querySelector('button[aria-label="发送"]').click()`);
  await waitFor(win, `document.querySelector('[data-testid="codex-error"]')?.innerText.includes('版本')`);
  await screenshot(win, 'chat-chain-stale-selection.png');

  return { failed: 0 };
}

module.exports = { runCodexNativeUiE2E };
