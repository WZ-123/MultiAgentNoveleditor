'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function seedNovel(ROOT) {
  const novelsStore = require(path.join(ROOT, 'src/main/store/novels'));
  const novelData = require(path.join(ROOT, 'src/main/store/novelData'));

  const tmpRoot = path.join(ROOT, 'tmp-test-editor-review-ui');
  await fs.rm(tmpRoot, { recursive: true, force: true });
  await fs.mkdir(tmpRoot, { recursive: true });
  const dir = path.join(tmpRoot, 'novel-' + Date.now());
  await fs.mkdir(dir, { recursive: true });
  const entry = await novelsStore.createNovel({ title: '编辑器预览验收小说', dir });
  await novelData.writeChapterWithMeta(
    dir,
    'chapter-001.md',
    '# 第一章\n\n林夜把杯子推远，没有解释。\n\n然后她笑了。那是一个很淡的笑。\n\n“不必。”林夜把话截断，视线仍落在杯沿。',
    { title: '第一章' }
  );
  await novelData.writeStyleMemory(dir, '句子短，停顿硬。不要主动补景物或心理。');
  await novelData.writeCharacter(dir, {
    id: 'lin-ye', name: '林夜', personality: '克制，不解释', speechStyle: '短句，少修饰', quotes: '不必。',
  });
  return { entry, dir, cleanupRoot: tmpRoot };
}

async function runEditorReviewUiRegressionTest(mainWindow) {
  const ROOT = path.resolve(__dirname, '..');
  const providerManager = require(path.join(ROOT, 'src/main/providerManager'));
  const modelAliases = require(path.join(ROOT, 'src/main/modelAliases'));
  const anthropicProvider = require(path.join(ROOT, 'src/main/runtime/providers/anthropic'));
  const originalGetActiveProvider = providerManager.getActiveProvider;
  const originalGetAlias = modelAliases.getAlias;
  const originalSendMessage = anthropicProvider.sendMessage;
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
    providerManager.getActiveProvider = async () => ({
      id: 'editor-review-regression-provider',
      name: 'editor-review-regression-provider',
      type: 'anthropic',
      apiKey: 'editor-review-regression-key',
      baseUrl: 'https://example.invalid',
      models: [{ id: 'editor-review-regression-model' }],
    });
    modelAliases.getAlias = async (aliasId) => ({
      id: aliasId || 'sonnet',
      providerId: null,
      modelId: 'editor-review-regression-model',
      maxOutputTokens: 512,
      temperature: 0,
    });
    let deAiPromptCaptured = '';
    anthropicProvider.sendMessage = async ({ system, messages, subagentId, onEvent }) => {
      const systemText = String(system || '');
      const serialized = JSON.stringify(messages || []);
      let text;
      if (subagentId === 'sa-de-ai-ifier') {
        deAiPromptCaptured = serialized;
        text = '她轻轻笑了一下。';
      } else if (systemText.includes('中文小说正文编辑助手') || serialized.includes('中文小说正文编辑助手')) {
        text = 'mock plain text completion';
      } else if (systemText.includes('章节场景状态抽取器')) {
        text = JSON.stringify({ extracted: {}, discrepancies: [], confidence: 0.99, evidenceParagraphIds: ['p-0'], sourceUsage: [] });
      } else if (systemText.includes('章节逐约束独立验证器')) {
        const constraintIds = [...serialized.matchAll(/\\"constraintId\\"\s*:\s*\\"([^\\"]+)\\"/gu)].map((match) => match[1]);
        text = JSON.stringify({ checks: [...new Set(constraintIds)].map((constraintId) => ({
          constraintId,
          status: 'satisfied',
          summary: '编辑器 UI 回归固定验证通过。',
          confidence: 0.99,
          evidenceParagraphIds: ['p-0'],
          sourceRefs: [],
        })) });
      } else {
        text = JSON.stringify({ issues: [], annotations: [] });
      }
      onEvent?.({ kind: 'text', data: { delta: text } });
      return { stopReason: 'end_turn', content: [{ type: 'text', text }] };
    };

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
        const runtimeErrors = [];
        window.addEventListener('unhandledrejection', (event) => runtimeErrors.push(event.reason?.stack || event.reason?.message || String(event.reason)));
        window.addEventListener('error', (event) => runtimeErrors.push(event.error?.stack || event.message || 'renderer error'));
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
        const chapterButton = await waitFor(() => document.querySelector('[data-testid="chapter-tree-item"][data-chapter-file="chapter-001.md"]'), 'chapter tree item not visible');
        chapterButton.click();
        await sleep(1200);
        if (!document.querySelector('[data-testid="chapter-editor-codemirror"]') && runtimeErrors.length) {
          throw new Error('chapter open renderer error: ' + runtimeErrors.join(' | '));
        }
        await waitFor(
          () => document.querySelector('[data-testid="chapter-editor-codemirror"]'),
          'CodeMirror editor not visible; active tabs=' + JSON.stringify(Array.from(document.querySelectorAll('[data-testid="editor-tab-strip"] button')).map((item) => item.textContent)) + '; body=' + (document.body.innerText || '').slice(0, 1800)
        );
        await waitFor(() => (document.body.innerText || '').includes('然后她笑了'), 'chapter text not visible');

        const view = await waitFor(() => window.__manaChapterEditorView, 'CodeMirror view not exposed');
        const text = view.state.doc.toString();
        const target = '然后她笑了。那是一个很淡的笑。';
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
        clickButton('去 AI 味润色');
        await waitFor(() => document.querySelector('[data-testid="editor-ai-preview"]') && (document.body.innerText || '').includes('严格验证：通过'), 'strictly verified AI preview not visible', 60000);
        await waitFor(() => {
          const button = document.querySelector('[data-testid="editor-ai-accept"]');
          return button && !button.disabled ? button : null;
        }, 'strictly verified accept button not enabled', 60000);
        clickButton('接受并保存');
        try {
          await waitFor(async () => {
            const disk = await window.mana.novel.readChapter(novelId, 'chapter-001.md');
            return disk.includes('她轻轻笑了一下。') ? disk : null;
          }, 'accepted AI text not saved to disk');
        } catch (error) {
          const disk = await window.mana.novel.readChapter(novelId, 'chapter-001.md');
          throw new Error(error.message + '; disk=' + disk + '; body=' + (document.body.innerText || '').slice(-1600));
        }

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
        await waitFor(() => Array.from(document.querySelectorAll('button')).some((button) => (button.textContent || '').includes('去 AI 味润色')), 'AI revision not listed');
        clickButton('去 AI 味润色');
        await waitFor(() => (document.body.innerText || '').includes('当前正文'), 'history diff not visible');
        clickButton('恢复此版本');
        await waitFor(async () => {
          const disk = await window.mana.novel.readChapter(novelId, 'chapter-001.md');
          return disk.includes('她轻轻笑了一下。') ? disk : null;
        }, 'history restore did not write disk');

        return { ok: true, body: (document.body.innerText || '').slice(0, 1000) };
      })()
    `);

    if (result?.ok && deAiPromptCaptured.includes('句子短，停顿硬') && deAiPromptCaptured.includes('短句，少修饰') && deAiPromptCaptured.includes('作者当前保留的相邻段落')) {
      pass('ERU2_editor_ai_conflict_history_flow_visible_and_persistent', 'style-aware minimal de-ai preview, conflict panel, and history restore passed');
    }
    else fail('ERU2_editor_ai_conflict_history_flow_visible_and_persistent', JSON.stringify(result));
  } catch (err) {
    fail('ERU_harness', err?.stack || err?.message || String(err));
  } finally {
    providerManager.getActiveProvider = originalGetActiveProvider;
    modelAliases.getAlias = originalGetAlias;
    anthropicProvider.sendMessage = originalSendMessage;
    if (cleanupRoot) await fs.rm(cleanupRoot, { recursive: true, force: true }).catch(() => {});
  }

  console.log('');
  console.log(`TEST_SUMMARY ${results.passed}/${results.total} passed, ${results.failed} failed`);
  console.log('TEST_DONE');
  return results;
}

module.exports = { runEditorReviewUiRegressionTest };
