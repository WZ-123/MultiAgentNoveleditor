'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function runEditorWorkflowUiE2E(win) {
  const data = require('../src/main/store/novelData');
  const novels = require('../src/main/store/novels');
  const config = require('../src/main/store/appConfig');
  const a = await novels.getNovelById(process.env.MANA_EDITOR_UI_A);
  const b = await novels.getNovelById(process.env.MANA_EDITOR_UI_B);
  const file = 'chapter-001.md';
  const originalWrite = data.writeChapterWithMeta;
  const originalMeta = novels.saveNovelMeta;
  let failStructure = false;
  let delayWrites = false, failWrites = false, pending = [], writes = 0, checks = 0;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const js = (fn, ...args) => win.webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`);
  async function wait(predicate, message) {
    const until = Date.now() + 18000;
    while (Date.now() < until) { if (await predicate()) return; await sleep(80); }
    throw new Error(message);
  }
  const uiWait = (fn, message) => wait(() => js(fn), message);
  const editor = () => js(() => window.__manaChapterEditorView?.state.doc.toString());
  const openChapter = async (name = file) => {
    await wait(() => js(name => !!document.querySelector(`[data-chapter-file="${name}"]`), name), 'chapter is missing');
    await js(name => document.querySelector(`[data-chapter-file="${name}"]`).click(), name);
    const active = await novels.getNovelById((await config.load()).lastNovelId);
    const expected = await data.readChapter(active.dir, name);
    await wait(async () => await editor() === expected, 'selected chapter did not finish loading');
  };
  const key = async keyCode => { await win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers: [process.platform === 'darwin' ? 'meta' : 'control'] }); await win.webContents.sendInputEvent({ type: 'keyUp', keyCode }); };
  const type = async text => {
    await js(() => { const view = window.__manaChapterEditorView; view.focus(); view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } }); });
    await win.webContents.insertText(text); await sleep(100);
    assert.equal(await editor(), text);
  };
  const save = () => key('S');
  const switchTo = async id => {
    await js(() => document.querySelector('[data-testid="workspace-switcher-trigger"]').click());
    await wait(() => js(id => !!document.querySelector(`[data-novel-id="${id}"] [data-testid="switch-novel"]`), id), 'switch target missing');
    await js(id => document.querySelector(`[data-novel-id="${id}"] [data-testid="switch-novel"]`).click(), id);
  };
  const shot = async name => {
    await js(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 150)))));
    const dir = path.join(__dirname, '../artifacts/chat-chain-audit'); await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, name), (await win.capturePage()).toPNG());
  };
  const pass = name => { checks++; console.log(`TEST_PASS editor_ui ${name}`); };
  data.writeChapterWithMeta = async (...args) => {
    if (args[0] === a.dir && args[1] === file) {
      writes++;
      if (failWrites) throw new Error('fixture editor disk unavailable');
      if (delayWrites) await new Promise(resolve => pending.push(resolve));
    }
    return originalWrite(...args);
  };
  novels.saveNovelMeta = async (...args) => {
    if (args[0] === a.id && failStructure) throw new Error('fixture structure disk unavailable');
    return originalMeta(...args);
  };
  try {
    await openChapter();
    if (process.env.MANA_EDITOR_UI_PHASE === '2') {
      assert.equal(await editor(), '恢复失败后保留的甲草稿');
      assert.equal(await js(() => document.querySelectorAll('[data-volume-id]').length), 3);
      assert.equal(await js(() => document.querySelector('[data-section-id="qa-s1"] [data-chapter-file]')), null);
      assert.equal(await js(() => document.querySelector('[data-section-id="qa-s3"] [data-chapter-file]')?.dataset.chapterFile), 'chapter-002.md');
      await openChapter('chapter-002.md'); assert.equal(await editor(), '第二卷新章正文');
      await shot('editor-workflow-restart.png'); pass('restart_retains_group_membership_empty_groups_and_text');
      return { failed: 0 };
    }
    delayWrites = true;
    await type('保存中的较早正文'); await save(); await wait(() => pending.length === 1, 'save not delayed');
    await type('保存期间的新输入'); await save();
    assert.equal(pending.length, 1, 'overlapping save was not serialized');
    pending.shift()(); await wait(() => pending.length === 1, 'second queued save missing');
    assert.equal(await editor(), '保存期间的新输入');
    delayWrites = false; pending.shift()();
    await wait(async () => await data.readChapter(a.dir, file) === '保存期间的新输入', 'latest draft not persisted');
    await uiWait(() => !document.querySelector('[data-testid="editor-save-conflict"]'), 'own save raised conflict');
    await shot('editor-workflow-save-race.png'); pass('real_input_overlapping_saves_preserve_new_draft_and_disk');

    const revisions = await data.listChapterRevisions(a.dir, file);
    assert.ok(revisions.length >= 2);
    const revision = revisions.at(-1);
    const restored = await data.readChapterRevision(a.dir, file, revision.id);
    await type('恢复前的未保存草稿');
    await js(() => [...document.querySelectorAll('button')].find(button => button.textContent.trim() === '历史').click());
    await uiWait(() => !!document.querySelector('[data-testid="chapter-history-panel"]'), 'history did not open');
    await uiWait(() => [...document.querySelectorAll('[data-testid="chapter-history-panel"] button')].filter(button => button.querySelector('.truncate')).length >= 2, 'revision list missing');
    await js(() => [...document.querySelectorAll('[data-testid="chapter-history-panel"] button')].filter(button => button.querySelector('.truncate')).at(-1).click());
    await sleep(150);
    await js(() => [...document.querySelectorAll('[data-testid="chapter-history-panel"] button')].find(button => button.textContent === '恢复此版本').click());
    await wait(async () => await editor() === restored.content, 'revision did not reach editor');
    await sleep(2300);
    assert.equal(await data.readChapter(a.dir, file), restored.content, 'stale debounce overwrote restored text');
    assert.equal(await js(() => !!document.querySelector('[data-testid="editor-save-conflict"]')), false);
    await js(() => [...document.querySelectorAll('[data-testid="chapter-history-panel"] button')].find(button => button.textContent === '关闭').click());
    pass('history_restore_cancels_stale_debounce_and_reads_back_formal_text');

    failWrites = true; await type('恢复失败后保留的甲草稿'); await switchTo(b.id);
    await uiWait(() => document.body.innerText.includes('fixture editor disk unavailable'), 'save failure not visible');
    assert.equal((await config.load()).lastNovelId, a.id, 'failed flush changed host project');
    assert.equal(await editor(), '恢复失败后保留的甲草稿');
    await shot('editor-workflow-switch-failed.png'); pass('failed_project_switch_keeps_host_editor_and_draft_together');
    failWrites = false;
    // Dismiss an open project menu, then retry through the same visible control.
    await js(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    await switchTo(b.id);
    await uiWait(() => document.querySelector('[data-testid="workspace-switcher-trigger"]')?.innerText.includes('编辑安全验收乙'), 'switch B did not finish');
    await openChapter(); assert.equal(await editor(), '乙项目原稿');
    assert.equal(await data.readChapter(a.dir, file), '恢复失败后保留的甲草稿');
    await type(''); await save(); await wait(async () => await data.readChapter(b.dir, file) === '', 'empty draft not saved');
    pass('retry_flushes_source_project_and_empty_target_draft_saves');

    await switchTo(a.id);
    await uiWait(() => !!document.querySelector('[data-section-id="qa-s3"]'), 'original structure missing');
    await js(() => [...document.querySelector('[data-section-id="qa-s3"]').querySelectorAll('button')].find(button => button.textContent === '+章').click());
    await uiWait(() => !!document.querySelector('[data-chapter-file="chapter-002.md"]') && !!window.__manaChapterEditorView, 'new chapter missing');
    await type('第二卷新章正文'); await save();
    await wait(async () => { try { return await data.readChapter(a.dir, 'chapter-002.md') === '第二卷新章正文'; } catch { return false; } }, 'new chapter not saved');
    const meta = JSON.parse(await fs.readFile(path.join(a.dir, 'novel.json'), 'utf8'));
    assert.deepEqual(meta.structure.volumes[1].sections[0].chapterFiles, ['chapter-002.md']);
    const withMeta = await data.readChapterWithMeta(a.dir, 'chapter-002.md');
    assert.equal(withMeta.metadata.volume, 2); assert.equal(withMeta.metadata.section, 1);
    failStructure = true;
    await js(() => [...document.querySelector('[data-volume-id="qa-v2"]').querySelectorAll('button')].find(button => button.textContent === '+节').click());
    await uiWait(() => document.body.innerText.includes('fixture structure disk unavailable'), 'structure failure not visible');
    await switchTo(b.id);
    await uiWait(() => [...document.querySelectorAll('[data-novel-id]')].some(row => row.textContent.includes('编辑安全验收甲') && row.textContent.includes('当前')), 'structure failure changed active project');
    assert.equal((await config.load()).lastNovelId, a.id);
    failStructure = false;
    await js(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    await switchTo(b.id);
    await uiWait(() => document.querySelector('[data-testid="workspace-switcher-trigger"]')?.innerText.includes('编辑安全验收乙'), 'structure retry switch failed');
    const recoveredMeta = JSON.parse(await fs.readFile(path.join(a.dir, 'novel.json'), 'utf8'));
    assert.equal(recoveredMeta.structure.volumes[1].sections.length, 2, 'failed empty section was lost');
    await switchTo(a.id);
    await uiWait(() => !!document.querySelector('[data-section-id="qa-s3"]'), 'structure retry return failed');
    pass('failed_structure_save_blocks_switch_and_retries_empty_section');
    await win.webContents.reload();
    await openChapter('chapter-002.md'); assert.equal(await editor(), '第二卷新章正文');
    assert.equal(await js(() => document.querySelector('[data-section-id="qa-s3"] [data-chapter-file]')?.dataset.chapterFile), 'chapter-002.md');
    assert.equal(await js(() => document.querySelectorAll('[data-chapter-file="chapter-002.md"]').length), 1);
    await shot('editor-workflow-structure-reload.png'); pass('new_chapter_real_disk_round_trip_retains_section_and_empty_groups');
    assert.ok(writes >= 3);
    console.log(`TEST_SUMMARY editor_ui ${checks}/${checks} passed`);
    return { failed: 0 };
  } catch (error) {
    await shot('editor-workflow-ui-failure.png').catch(() => {});
    console.error('TEST_FAIL editor_ui:', error.stack || error); return { failed: 1 };
  } finally { delayWrites = false; for (const release of pending) release(); data.writeChapterWithMeta = originalWrite; novels.saveNovelMeta = originalMeta; }
}
module.exports = { runEditorWorkflowUiE2E };
