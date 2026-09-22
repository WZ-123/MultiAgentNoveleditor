'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function seedLargeNovel(root) {
  const novels = require(path.join(root, 'src/main/store/novels'));
  const novelData = require(path.join(root, 'src/main/store/novelData'));
  const mcpClient = require(path.join(root, 'src/main/mcp/mcpClientStdio'));
  const tempRoot = path.join(root, 'tmp-test-large-project-ui');
  await fs.rm(tempRoot, { recursive: true, force: true });
  await fs.mkdir(tempRoot, { recursive: true });
  const dir = path.join(tempRoot, `小说 🌙 测试 项目-${Date.now()}`);
  await fs.mkdir(dir, { recursive: true });
  const novel = await novels.createNovel({ title: '五百章 🌙 UI 边界验收小说', dir });
  for (let index = 1; index <= 501; index += 1) {
    const id = `chapter-${String(index).padStart(3, '0')}.md`;
    await novelData.writeChapterWithMeta(dir, id, `# 第${index}章\n\n第${index}章的隔离测试正文。`, { title: `第${index}章` });
  }
  await novels.openNovel(novel.id);
  await mcpClient.setActiveNovel(novel.id, dir);
  return { novel, tempRoot };
}

async function runLargeProjectUiE2E(mainWindow) {
  const root = path.resolve(__dirname, '..');
  const results = { total: 0, passed: 0, failed: 0 };
  const pass = (name, detail = '') => { results.total += 1; results.passed += 1; console.log(`TEST_PASS ${name}${detail ? `: ${detail}` : ''}`); };
  const fail = (name, detail) => { results.total += 1; results.failed += 1; console.log(`TEST_FAIL ${name}: ${detail}`); };
  let fixture;
  try {
    fixture = await seedLargeNovel(root);
    pass('LARGE_UI1_seed_501_chapters_unicode_path', `${fixture.novel.id} ${fixture.novel.dir || ''}`);
    mainWindow.setSize(1440, 1000);
    mainWindow.show();
    await delay(350);
    const check = await mainWindow.webContents.executeJavaScript(`
      (async () => {
        const novelId = ${JSON.stringify(fixture.novel.id)};
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        await window.mana.novel.open(novelId);
        const deadline = Date.now() + 30000;
        let count = 0;
        while (Date.now() < deadline) {
          const items = [...document.querySelectorAll('[data-testid="chapter-tree-item"]')];
          count = items.length;
          if (count >= 501) break;
          await sleep(150);
        }
        const target = document.querySelector('[data-testid="chapter-tree-item"][data-chapter-file="chapter-501.md"]');
        target?.scrollIntoView({ block: 'center' });
        await sleep(250);
        const rect = target?.getBoundingClientRect();
        const click = target && rect && rect.width > 0 && rect.height > 0;
        if (click) target.click();
        await sleep(400);
        const body = document.body.innerText || '';
        return {
          count,
          targetPresent: !!target,
          targetVisible: !!rect && rect.top >= 0 && rect.bottom <= innerHeight,
          targetClick: !!click,
          targetText: target?.textContent || '',
          opened: body.includes('第501章') || body.includes('chapter-501'),
          bodyWidth: document.body.scrollWidth,
          viewportWidth: innerWidth,
          bodyTail: body.slice(-800)
        };
      })()
    `);
    const ok = check?.count >= 501 && check?.targetPresent && check?.targetVisible && check?.targetClick && check?.opened && check?.bodyWidth <= check?.viewportWidth + 2;
    if (ok) pass('LARGE_UI2_tree_scroll_and_open_chapter_501', JSON.stringify(check));
    else fail('LARGE_UI2_tree_scroll_and_open_chapter_501', JSON.stringify(check));
    const autosave = await mainWindow.webContents.executeJavaScript(`
      (async () => {
        const novelId = ${JSON.stringify(fixture.novel.id)};
        const fileName = 'chapter-501.md';
        const view = window.__manaChapterEditorView;
        if (!view) return { ok: false, reason: 'editor-view-missing' };
        const original = view.state.doc.toString();
        const revised = original.replace('隔离测试正文。', '隔离测试正文已保存。');
        const from = original.indexOf('隔离测试正文。');
        if (from < 0) return { ok: false, reason: 'target-text-missing' };
        view.dispatch({ changes: { from, to: from + '隔离测试正文。'.length, insert: '隔离测试正文已保存。' } });
        const deadline = Date.now() + 12000;
        let disk = '';
        while (Date.now() < deadline) {
          disk = await window.mana.novel.readChapter(novelId, fileName);
          if (disk.includes('隔离测试正文已保存。')) break;
          await new Promise((resolve) => setTimeout(resolve, 160));
        }
        await window.mana.novel.open(novelId);
        const afterReopen = await window.mana.novel.readChapter(novelId, fileName);
        return { ok: disk.includes('隔离测试正文已保存。') && afterReopen.includes('隔离测试正文已保存。'), diskSaved: disk.includes('隔离测试正文已保存。'), reopened: afterReopen.includes('隔离测试正文已保存。') };
      })()
    `);
    if (autosave?.ok) pass('LARGE_UI3_editor_autosave_and_reopen', JSON.stringify(autosave));
    else fail('LARGE_UI3_editor_autosave_and_reopen', JSON.stringify(autosave));
    const novelData = require(path.join(root, 'src/main/store/novelData'));
    await novelData.writeChapterWithMeta(fixture.novel.dir, 'chapter-empty.md', '', { title: '空章节' });
    const emptyChapter = await mainWindow.webContents.executeJavaScript(`
      (async () => {
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        await window.mana.novel.open(${JSON.stringify(fixture.novel.id)});
        const deadline = Date.now() + 15000;
        let item = null;
        while (Date.now() < deadline) {
          item = document.querySelector('[data-testid="chapter-tree-item"][data-chapter-file="chapter-empty.md"]');
          if (item) break;
          await sleep(100);
        }
        item?.click();
        await sleep(250);
        const view = window.__manaChapterEditorView;
        if (!view) return { ok: false, reason: 'editor-view-missing' };
        const before = view.state.doc.toString();
        const bodyWithoutFrontmatter = before.replace(/^---\\n[\\s\\S]*?\\n---\\n?/u, '').trim();
        if (bodyWithoutFrontmatter !== '') return { ok: false, reason: 'empty-chapter-has-body', before };
        view.dispatch({ changes: { from: view.state.doc.length, to: view.state.doc.length, insert: '空章节第一句。' } });
        let disk = '';
        const saveDeadline = Date.now() + 12000;
        while (Date.now() < saveDeadline) {
          disk = await window.mana.novel.readChapter(${JSON.stringify(fixture.novel.id)}, 'chapter-empty.md');
          if (disk.includes('空章节第一句。')) break;
          await sleep(160);
        }
        return { ok: !!item && disk.includes('空章节第一句。') && !document.body.innerText.includes('undefined'), disk, body: document.body.innerText.slice(-600) };
      })()
    `);
    if (emptyChapter?.ok) pass('LARGE_UI4_empty_chapter_edit_and_save', JSON.stringify(emptyChapter));
    else fail('LARGE_UI4_empty_chapter_edit_and_save', JSON.stringify(emptyChapter));
    const screenshot = await mainWindow.capturePage();
    const screenshotPath = path.join(root, 'knowledge-base/test-evidence/full-product/full-product-2026-08-24/large-project-501-chapters.png');
    await fs.writeFile(screenshotPath, screenshot.toPNG());
    console.log(`TEST_SCREENSHOT ${screenshotPath}`);
  } catch (error) {
    fail('LARGE_UI_harness', error?.stack || error?.message || String(error));
  } finally {
    if (fixture?.tempRoot) await fs.rm(fixture.tempRoot, { recursive: true, force: true }).catch(() => {});
  }
  console.log(`TEST_SUMMARY ${results.passed}/${results.total} passed, ${results.failed} failed`);
  console.log('TEST_DONE');
  return results;
}

module.exports = { runLargeProjectUiE2E };
