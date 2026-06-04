'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function seedNovel(ROOT) {
  const novelsStore = require(path.join(ROOT, 'src/main/store/novels'));
  const { novelPaths } = require(path.join(ROOT, 'src/main/store/paths'));

  const tmpRoot = path.join(ROOT, 'tmp-test-chat-checkpoint-ui');
  await fs.rm(tmpRoot, { recursive: true, force: true });
  await fs.mkdir(tmpRoot, { recursive: true });

  const dir = path.join(tmpRoot, 'novel-' + Date.now());
  await fs.mkdir(dir, { recursive: true });

  const entry = await novelsStore.createNovel({ title: '聊天检查点回归小说', dir });
  const np = novelPaths(dir);
  await fs.mkdir(np.chapters, { recursive: true });
  await fs.writeFile(path.join(np.chapters, 'chapter-001.md'), `# 夜雨将至

屋檐下的风铃轻轻一晃，像是谁在门外停住了脚步。
沈砚抬手按住窗纸，听着长街尽头那阵未落下来的雷声。
`, 'utf8');

  return { entry, cleanupRoot: tmpRoot, chapterFile: 'chapter-001.md' };
}

async function runChatCheckpointUiRegressionTest(mainWindow) {
  const ROOT = path.resolve(__dirname, '..');
  const providerManager = require(path.join(ROOT, 'src/main/providerManager'));
  const modelAliases = require(path.join(ROOT, 'src/main/modelAliases'));
  const workflowOrchestrator = require(path.join(ROOT, 'src/main/runtime/workflowOrchestrator'));
  const anthropicProvider = require(path.join(ROOT, 'src/main/runtime/providers/anthropic'));

  const originalGetActiveProvider = providerManager.getActiveProvider;
  const originalGetAlias = modelAliases.getAlias;
  const originalGetActiveDriverId = workflowOrchestrator.getActiveDriverId;
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
  let entry = null;
  let chapterFile = 'chapter-001.md';

  const originalSentence = '沈砚抬手按住窗纸，听着长街尽头那阵未落下来的雷声。';
  const replacementSentence = '沈砚抬手按住窗纸，指节在微凉的纸面上停了一瞬，像是要把那阵迟迟不落的雷声先按回夜色里。';

  const scriptedResponses = [
    {
      stopReason: 'tool_use',
      content: [
        { type: 'text', text: '我先按你高亮的句子做一次局部润色。' },
        {
          type: 'tool_use',
          id: 'toolu-checkpoint-replace-1',
          name: 'replace_selected_text',
          input: { replacement: replacementSentence },
        },
      ],
    },
    {
      stopReason: 'end_turn',
      content: [
        { type: 'text', text: '局部改写已完成。' },
      ],
    },
  ];

  try {
    const seeded = await seedNovel(ROOT);
    cleanupRoot = seeded.cleanupRoot;
    entry = seeded.entry;
    chapterFile = seeded.chapterFile;
    pass('CHAT_CHECKPOINT_seed_novel', entry.id);

    providerManager.getActiveProvider = async () => ({
      id: 'anthropic',
      name: 'Anthropic',
      type: 'anthropic',
      apiKey: 'chat-checkpoint-regression-key',
      baseUrl: 'https://example.invalid',
      models: [{ id: 'chat-checkpoint-regression-model' }],
    });
    modelAliases.getAlias = async (aliasId) => ({
      id: aliasId || 'sonnet',
      providerId: null,
      modelId: 'chat-checkpoint-regression-model',
      maxOutputTokens: 512,
      temperature: 0,
    });
    workflowOrchestrator.getActiveDriverId = () => 'direct-api';
    anthropicProvider.sendMessage = async ({ onEvent }) => {
      const next = scriptedResponses.shift();
      if (!next) throw new Error('unexpected sendMessage call');
      for (const block of next.content || []) {
        if (block.type === 'text' && block.text) {
          onEvent && onEvent({ kind: 'text', data: { delta: block.text } });
        }
        if (block.type === 'tool_use') {
          onEvent && onEvent({ kind: 'tool_use', data: { id: block.id, name: block.name, input: block.input } });
        }
      }
      return next;
    };

    await delay(1500);

    const r = await mainWindow.webContents.executeJavaScript(`
      (async () => {
        const novelId = ${JSON.stringify(entry.id)};
        const chapterFile = ${JSON.stringify(chapterFile)};
        const originalSentence = ${JSON.stringify(originalSentence)};
        const replacementSentence = ${JSON.stringify(replacementSentence)};
        const chapterButtonHints = ['第一章', '夜雨将至', chapterFile];
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

        async function waitFor(predicate, message, timeout = 15000) {
          const startedAt = Date.now();
          while (Date.now() - startedAt < timeout) {
            const value = await predicate();
            if (value) return value;
            await sleep(100);
          }
          throw new Error(message);
        }

        function setControlValue(control, value) {
          const proto = control.tagName === 'TEXTAREA'
            ? HTMLTextAreaElement.prototype
            : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
          if (setter) setter.call(control, value);
          else control.value = value;
          control.dispatchEvent(new Event('input', { bubbles: true }));
        }

        function selectPhrase(textarea, phrase) {
          const start = textarea.value.indexOf(phrase);
          if (start < 0) throw new Error('phrase not found: ' + phrase);
          const end = start + phrase.length;
          textarea.focus();
          textarea.setSelectionRange(start, end);
          textarea.dispatchEvent(new Event('select', { bubbles: true }));
          textarea.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          textarea.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Shift' }));
          return { start, end };
        }

        function findButtonByText(text) {
          return Array.from(document.querySelectorAll('button')).find((button) => (button.textContent || '').includes(text)) || null;
        }

        await window.mana.novel.open(novelId);

        const chapterButton = await waitFor(() => {
          const buttons = Array.from(document.querySelectorAll('button'));
          return buttons.find((button) => {
            const text = (button.textContent || '').trim();
            return text && chapterButtonHints.some((hint) => text.includes(hint));
          }) || null;
        }, 'chapter button not found', 20000);
        chapterButton.click();

        const chapterEditor = await waitFor(() => {
          const textarea = document.querySelector('textarea');
          if (!textarea) return null;
          return textarea.value.includes(originalSentence) ? textarea : null;
        }, 'chapter editor not ready', 20000);

        selectPhrase(chapterEditor, originalSentence);

        const input = await waitFor(() => document.querySelector('textarea[placeholder="向 AI 提问…"], input[placeholder="向 AI 提问…"]'), 'chat input not found');
        input.focus();
        setControlValue(input, '请把我高亮的这句改得更压抑一点，但只改这句。');
        const sendButton = await waitFor(() => {
          const button = input.parentElement?.querySelector('button');
          return button && !button.disabled ? button : null;
        }, 'chat send button not enabled');
        sendButton.click();

        await waitFor(() => (document.body.innerText || '').includes('局部改写已完成。'), 'assistant completion marker not found', 20000);
        await waitFor(() => chapterEditor.value.includes(replacementSentence), 'replacement not applied in editor', 10000);
        await sleep(2400);
        const diskAfterReplace = await window.mana.novel.readChapter(novelId, chapterFile);

        const changedButton = await waitFor(() => findButtonByText('已更改内容'), 'changed files button missing', 10000);
        const restoreButton = await waitFor(() => findButtonByText('还原检查点'), 'restore checkpoint button missing', 10000);

        changedButton.click();
        await waitFor(
          () => (document.body.innerText || '').includes('变更前') && (document.body.innerText || '').includes('变更后') && (document.body.innerText || '').includes(replacementSentence.slice(0, 12)),
          'changed content diff not shown',
          10000
        );

        const confirmMessages = [];
        const originalConfirm = window.confirm;
        window.confirm = (message) => {
          confirmMessages.push(String(message || ''));
          return true;
        };

        try {
          restoreButton.click();
          await waitFor(() => chapterEditor.value.includes(originalSentence) && !chapterEditor.value.includes(replacementSentence), 'editor did not restore checkpoint', 10000);
          await sleep(2400);
          const diskAfterRestore = await window.mana.novel.readChapter(novelId, chapterFile);
          const body = document.body.innerText || '';

          return {
            changedButtonText: changedButton.textContent || '',
            restoreButtonText: restoreButton.textContent || '',
            body,
            diskAfterReplace,
            diskAfterRestore,
            editorValue: chapterEditor.value,
            confirmMessages,
            changedSummaryVisible: body.includes('已替换当前章节中的') || body.includes('已更改内容'),
            diffVisible: body.includes('变更前') && body.includes('变更后') && body.includes(replacementSentence.slice(0, 12)),
            restoreStatusVisible: body.includes('已还原 chapter-001.md'),
          };
        } finally {
          window.confirm = originalConfirm;
        }
      })()
    `);

    if (
      r?.changedSummaryVisible
      && String(r.diskAfterReplace || '').includes(replacementSentence)
      && !String(r.diskAfterReplace || '').includes(originalSentence)
    ) {
      pass('CHAT_CHECKPOINT_tool_card_exposes_change_summary', 'tool card rendered structured change summary after real editor action');
    } else {
      fail('CHAT_CHECKPOINT_tool_card_exposes_change_summary', JSON.stringify(r));
    }

    if (r?.diffVisible) {
      pass('CHAT_CHECKPOINT_changed_content_expands', '已更改内容 expands into an inline diff view');
    } else {
      fail('CHAT_CHECKPOINT_changed_content_expands', JSON.stringify(r));
    }

    if (
      Array.isArray(r?.confirmMessages)
      && r.confirmMessages.some((message) => message.includes('还原到此检查点'))
      && String(r.diskAfterRestore || '').includes(originalSentence)
      && !String(r.diskAfterRestore || '').includes(replacementSentence)
      && String(r.editorValue || '').includes(originalSentence)
      && !String(r.editorValue || '').includes(replacementSentence)
      && r.restoreStatusVisible
    ) {
      pass('CHAT_CHECKPOINT_restore_reverts_editor_and_disk', 'restore checkpoint reverted both editor state and persisted chapter content');
    } else {
      fail('CHAT_CHECKPOINT_restore_reverts_editor_and_disk', JSON.stringify(r));
    }
  } catch (err) {
    fail('CHAT_CHECKPOINT_harness', err.message || String(err));
  } finally {
    providerManager.getActiveProvider = originalGetActiveProvider;
    modelAliases.getAlias = originalGetAlias;
    workflowOrchestrator.getActiveDriverId = originalGetActiveDriverId;
    anthropicProvider.sendMessage = originalSendMessage;
    try {
      if (cleanupRoot) await fs.rm(cleanupRoot, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }

  console.log('');
  console.log(`TEST_SUMMARY ${results.passed}/${results.total} passed, ${results.failed} failed`);
  console.log('TEST_DONE');
  return results;
}

module.exports = { runChatCheckpointUiRegressionTest };
