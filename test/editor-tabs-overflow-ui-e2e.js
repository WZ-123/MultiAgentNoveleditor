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

  const tmpRoot = path.join(ROOT, 'tmp-test-editor-tabs-overflow');
  await fs.rm(tmpRoot, { recursive: true, force: true });
  await fs.mkdir(tmpRoot, { recursive: true });
  const dir = path.join(tmpRoot, 'novel-' + Date.now());
  await fs.mkdir(dir, { recursive: true });

  const entry = await novelsStore.createNovel({ title: '标签溢出回归小说', dir });
  for (let index = 1; index <= 32; index += 1) {
    const fileName = `chapter-${String(index).padStart(3, '0')}.md`;
    const title = `第${index}章：很长很长的章节标题用于挤压标签栏`;
    await novelData.writeChapterWithMeta(
      dir,
      fileName,
      `# ${title}\n\n第${index}章正文。`,
      { title }
    );
  }

  await novelsStore.openNovel(entry.id);
  await mcpClient.setActiveNovel(entry.id, dir);
  return { entry, cleanupRoot: tmpRoot };
}

async function runEditorTabsOverflowUiRegressionTest(mainWindow) {
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
    pass('ETO1_seed_novel', seeded.entry.id);

    try {
      mainWindow.setSize(1180, 720);
      mainWindow.show();
      mainWindow.focus();
    } catch {
      // Layout checks still work in most headless-style Electron runs.
    }

    await delay(800);
    const result = await mainWindow.webContents.executeJavaScript(`
      (async () => {
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        async function waitFor(predicate, message, timeout = 15000) {
          const startedAt = Date.now();
          while (Date.now() - startedAt < timeout) {
            const value = predicate();
            if (value) return value;
            await sleep(100);
          }
          throw new Error(message);
        }

        await window.mana.novel.open(${JSON.stringify(seeded.entry.id)});
        await waitFor(() => (document.body.innerText || '').includes('标签溢出回归小说'), 'novel title not visible');
        await waitFor(() => (document.body.innerText || '').includes('第32章'), 'chapter list not visible');

        const chapterButtons = Array.from(document.querySelectorAll('button')).filter((button) => {
          const text = (button.textContent || '').trim();
          const rect = button.getBoundingClientRect();
          return /^第\\d+章/.test(text) && rect.left < 360 && rect.width > 60;
        });
        if (chapterButtons.length < 30) {
          return { ok: false, step: 'find_chapter_buttons', count: chapterButtons.length, body: (document.body.innerText || '').slice(0, 800) };
        }

        for (const button of chapterButtons.slice(0, 32)) {
          button.click();
          await sleep(35);
        }

        const layout = await waitFor(() => {
          const fixed = document.querySelector('[data-testid="editor-fixed-actions"]');
          const strip = document.querySelector('[data-testid="editor-tab-strip"]');
          if (!fixed || !strip) return null;
          const fixedRect = fixed.getBoundingClientRect();
          const stripRect = strip.getBoundingClientRect();
          const text = fixed.innerText || '';
          return {
            fixedLeft: fixedRect.left,
            fixedRight: fixedRect.right,
            fixedWidth: fixedRect.width,
            stripLeft: stripRect.left,
            stripRight: stripRect.right,
            stripClientWidth: strip.clientWidth,
            stripScrollWidth: strip.scrollWidth,
            viewportWidth: window.innerWidth,
            fixedText: text,
            tabCount: document.querySelectorAll('[data-testid="editor-tab-strip"] > [role="tab"]').length,
            fixedVisible: fixedRect.left >= 0 && fixedRect.right <= window.innerWidth + 1 && fixedRect.width > 80,
            stripOverflowed: strip.scrollWidth > strip.clientWidth + 20,
            includesNovelButton: text.includes('小说'),
          };
        }, 'tab layout not ready');

        return { ok: true, layout };
      })()
    `);

    const layout = result?.layout || {};
    if (result?.ok && layout.fixedVisible && layout.stripOverflowed && layout.includesNovelButton && layout.tabCount >= 30) {
      pass('ETO2_fixed_actions_survive_many_tabs', JSON.stringify(layout));
    } else {
      fail('ETO2_fixed_actions_survive_many_tabs', JSON.stringify(result));
    }
  } catch (err) {
    fail('ETO3_harness', err.message || String(err));
  } finally {
    if (cleanupRoot) {
      try { await fs.rm(cleanupRoot, { recursive: true, force: true }); } catch {}
    }
  }

  console.log('');
  console.log(`TEST_SUMMARY ${results.passed}/${results.total} passed, ${results.failed} failed`);
  console.log('TEST_DONE');
  return results;
}

module.exports = { runEditorTabsOverflowUiRegressionTest };
