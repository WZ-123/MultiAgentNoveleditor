'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function seedNovel(ROOT) {
  const novelsStore = require(path.join(ROOT, 'src/main/store/novels'));
  const novelData = require(path.join(ROOT, 'src/main/store/novelData'));
  const mcpClient = require(path.join(ROOT, 'src/main/mcp/mcpClientStdio'));

  const tmpRoot = path.join(ROOT, 'tmp-test-editor-review-ui');
  await fs.rm(tmpRoot, { recursive: true, force: true });
  await fs.mkdir(tmpRoot, { recursive: true });
  const dir = path.join(tmpRoot, 'novel-' + Date.now());
  await fs.mkdir(dir, { recursive: true });
  const entry = await novelsStore.createNovel({ title: '编辑器预览验收小说', dir });
  await novelData.writeChapterWithMeta(
    dir,
    'chapter-001.md',
    '# 第一章\n\n这是需要润色的句子。后面还有原文。',
    { title: '第一章' }
  );
  await novelsStore.openNovel(entry.id);
  await mcpClient.setActiveNovel(entry.id, dir);
  return { entry, dir, cleanupRoot: tmpRoot };
}

async function runEditorReviewUiRegressionTest(mainWindow) {
  const ROOT = path.resolve(__dirname, '..');
  const results = { total: 0, passed: 0, failed: 0 };
  function pass(name, detail) {
    results.total += 1;
    results.passed += 1;
    console.log(`TEST_PASS ${name}${detail ? ': ' + detail : ''}`);
  }
  function fail(name, reason) {
    results.total += 1;
    results.failed += 1;
    console.log(`TEST_FAIL ${name}: ${reason}`);
  }

  let cleanupRoot = '';
  try {
    const seeded = await seedNovel(ROOT);
    cleanupRoot = seeded.cleanupRoot;
    pass('ERU1_seed_novel', seeded.entry.id);

    try {
      mainWindow.setSize(1280, 820);
      mainWindow.show();
      mainWindow.focus();
    } catch {}

    await delay(800);
    const result = await mainWindow.webContents.executeJavaScript(`
      (async () => {
        const novelId = ${JSON.stringify(seeded.entry.id)};
        const activeDir = ${JSON.stringify(seeded.dir)};
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        async function waitFor(predicate, message, timeout = 18000) {
          const startedAt = Date.now();
          while (Date.now() - startedAt < timeout) {
            const value = await predicate();
            if (value) return value;
            await sleep(120);
          }
          throw new Error(message);
        }
        const clickButton = (label) => {
          const button = Array.from(document.querySelectorAll('button')).find((item) => (item.textContent || '').includes(label));
          if (!button) throw new Error('button not found: ' + label);
          const rect = button.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) throw new Error('button not visible: ' + label);
          button.click();
          return true;
        };

        await window.mana.novel.open(novelId);
        await waitFor(() => (document.body.innerText || '').includes('编辑器预览验收小说'), 'novel not visible');
        clickButton('第一章');
        await waitFor(() => document.querySelector('[data-testid="chapter-editor-codemirror"]'), 'CodeMirror editor not visible');
        await waitFor(() => (document.body.innerText || '').includes('这是需要润色的句子'), 'chapter text not visible');

        const view = await waitFor(() => window.__manaChapterEditorView, 'CodeMirror view not exposed');
        const text = view.state.doc.toString();
        const target = '这是需要润色的句子';
        const start = text.indexOf(target);
        if (start < 0) throw new Error('target text not found in editor');
        view.focus();
        view.dispatch({ selection: { anchor: start, head: start + target.length } });
        await sleep(120);
        const contentDOM = document.querySelector('.cm-content');
        contentDOM.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 520, clientY: 260 }));
        await sleep(250);
        const menuVisible = Array.from(document.querySelectorAll('button')).some((button) => (button.textContent || '').includes('AI 重写选中段落'));
        if (!menuVisible) throw new Error('AI context menu not visible');
        clickButton('AI 重写选中段落');
        await waitFor(() => document.querySelector('[data-testid="editor-ai-preview"]') && (document.body.innerText || '').includes('接受并保存'), 'AI preview not visible');
        clickButton('接受并保存');
        await waitFor(async () => {
          const disk = await window.mana.novel.readChapter(novelId, 'chapter-001.md');
          return disk.includes('mock plain text completion') ? disk : null;
        }, 'accepted AI text not saved to disk');

        await window.mana.fs.writeFile(activeDir + '/chapters/chapter-001.md', '外部磁盘版本', 'utf8');
        const latestView = window.__manaChapterEditorView;
        latestView.dispatch({ changes: { from: latestView.state.doc.length, insert: '\\n本地冲突编辑' } });
        await waitFor(() => document.querySelector('[data-testid="editor-save-conflict"]') && (document.body.innerText || '').includes('保留我的版本并保存'), 'save conflict panel not visible', 7000);
        const conflictButtons = ['复制本地文本', '使用磁盘版本', '保留我的版本并保存'].every((label) =>
          Array.from(document.querySelectorAll('button')).some((button) => (button.textContent || '').includes(label) && button.getBoundingClientRect().width > 0)
        );
        if (!conflictButtons) throw new Error('conflict action buttons not visible');
        clickButton('使用磁盘版本');
        await waitFor(() => (document.body.innerText || '').includes('已使用磁盘版本') || window.__manaChapterEditorView.state.doc.toString().includes('外部磁盘版本'), 'disk conflict choice not reflected');

        clickButton('历史');
        await waitFor(() => document.querySelector('[data-testid="chapter-history-panel"]'), 'history panel not visible');
        await waitFor(() => Array.from(document.querySelectorAll('button')).some((button) => (button.textContent || '').includes('AI 重写选中段落')), 'AI revision not listed');
        clickButton('AI 重写选中段落');
        await waitFor(() => (document.body.innerText || '').includes('当前正文'), 'history diff not visible');
        clickButton('恢复此版本');
        await waitFor(async () => {
          const disk = await window.mana.novel.readChapter(novelId, 'chapter-001.md');
          return disk.includes('mock plain text completion') ? disk : null;
        }, 'history restore did not write disk');

        return { ok: true, body: (document.body.innerText || '').slice(0, 1000) };
      })()
    `);

    if (result?.ok) pass('ERU2_editor_ai_conflict_history_flow_visible_and_persistent', 'AI preview, conflict panel, and history restore passed');
    else fail('ERU2_editor_ai_conflict_history_flow_visible_and_persistent', JSON.stringify(result));
  } catch (err) {
    fail('ERU_harness', err?.stack || err?.message || String(err));
  } finally {
    if (cleanupRoot) await fs.rm(cleanupRoot, { recursive: true, force: true }).catch(() => {});
  }

  console.log('');
  console.log(`TEST_SUMMARY ${results.passed}/${results.total} passed, ${results.failed} failed`);
  console.log('TEST_DONE');
  return results;
}

module.exports = { runEditorReviewUiRegressionTest };
