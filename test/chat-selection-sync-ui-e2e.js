'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function seedNovel(ROOT) {
  const novelsStore = require(path.join(ROOT, 'src/main/store/novels'));
  const { novelPaths } = require(path.join(ROOT, 'src/main/store/paths'));

  const tmpRoot = path.join(ROOT, 'tmp-test-chat-selection-sync-ui');
  await fs.rm(tmpRoot, { recursive: true, force: true });
  await fs.mkdir(tmpRoot, { recursive: true });

  const dir = path.join(tmpRoot, 'novel-' + Date.now());
  await fs.mkdir(dir, { recursive: true });

  const entry = await novelsStore.createNovel({ title: '聊天选区同步回归小说', dir });
  const np = novelPaths(dir);
  await fs.mkdir(np.chapters, { recursive: true });
  await fs.writeFile(path.join(np.chapters, 'chapter-001.md'), `# 楚岚回家

楚岚推门进屋时，天色已经暗了下来。
阿宁把杯子放到桌边，抬头看了他一眼。
楚岚站在门口，想起晚上还要直播，话到嘴边又顿了一下。
他把背包放下，先去洗了把脸。
`, 'utf8');

  return { entry, cleanupRoot: tmpRoot, chapterFile: 'chapter-001.md' };
}

async function runChatSelectionSyncUiRegressionTest(mainWindow) {
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
  let scopedReplaceIssued = false;

  const selectedSentence = '楚岚站在门口，想起晚上还要直播，话到嘴边又顿了一下。';
  const replacementSentence = '楚岚站在门口，想起晚上还要直播，话到嘴边却先绕到阿宁眼里，像是那句告别忽然有了温度，又被他克制地按了回去。';

  try {
    const seeded = await seedNovel(ROOT);
    cleanupRoot = seeded.cleanupRoot;
    entry = seeded.entry;
    chapterFile = seeded.chapterFile;
    pass('CHAT_SELECTION_SYNC_seed_novel', entry.id);

    providerManager.getActiveProvider = async () => ({
      id: 'chat-selection-sync-provider',
      name: 'chat-selection-sync-provider',
      type: 'anthropic',
      apiKey: 'chat-selection-sync-key',
      baseUrl: 'https://example.invalid',
      models: [{ id: 'chat-selection-sync-model' }],
    });
    modelAliases.getAlias = async (aliasId) => ({
      id: aliasId || 'sonnet',
      providerId: null,
      modelId: 'chat-selection-sync-model',
      maxOutputTokens: 512,
      temperature: 0,
    });
    workflowOrchestrator.getActiveDriverId = () => 'direct-api';
    anthropicProvider.sendMessage = async ({ onEvent, system }) => {
      const hasSelectedText = String(system || '').includes(selectedSentence);
      const response = !hasSelectedText
        ? {
            stopReason: 'end_turn',
            content: [
              { type: 'text', text: '错误：系统里没有最新选区。' },
            ],
          }
        : !scopedReplaceIssued
        ? {
            stopReason: 'tool_use',
            content: [
              { type: 'text', text: '我按你刚高亮的句子，只在这里补一小段临别感情戏。' },
              {
                type: 'tool_use',
                id: 'toolu-selection-sync-replace-1',
                name: 'replace_selected_text',
                input: { replacement: replacementSentence },
              },
            ],
          }
        : {
            stopReason: 'end_turn',
            content: [
              { type: 'text', text: '局部改写已完成。' },
            ],
          };
      if (hasSelectedText && !scopedReplaceIssued && response.stopReason === 'tool_use') {
        scopedReplaceIssued = true;
      }
      for (const block of response.content || []) {
        if (block.type === 'text' && block.text) {
          onEvent && onEvent({ kind: 'text', data: { delta: block.text } });
        }
        if (block.type === 'tool_use') {
          onEvent && onEvent({ kind: 'tool_use', data: { id: block.id, name: block.name, input: block.input } });
        }
      }
      return response;
    };

    await delay(1500);

    const r = await mainWindow.webContents.executeJavaScript(`
      (async () => {
        const novelId = ${JSON.stringify(entry.id)};
        const chapterFile = ${JSON.stringify(chapterFile)};
        const selectedSentence = ${JSON.stringify(selectedSentence)};
        const replacementSentence = ${JSON.stringify(replacementSentence)};
        const chapterButtonHints = ['第一章', '楚岚回家', chapterFile];
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

        async function sendPrompt(prompt, doneMarker) {
          const input = await waitFor(
            () => document.querySelector('textarea[placeholder="向 AI 提问…"], input[placeholder="向 AI 提问…"]'),
            'chat input not found'
          );
          await waitFor(
            () => document.querySelector('[data-editor-selection-overlay="visible"]'),
            'selection overlay not visible',
            2000
          );
          input.focus();
          setControlValue(input, prompt);
          const sendButton = await waitFor(
            () => {
              const button = input.parentElement?.querySelector('button');
              return button && !button.disabled ? button : null;
            },
            'chat send button not enabled'
          );
          sendButton.click();
          await waitFor(
            () => (document.body.innerText || '').includes(doneMarker),
            'assistant completion marker not found: ' + doneMarker,
            20000
          );
          await sleep(250);
          return document.body.innerText || '';
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
          return textarea.value.includes(selectedSentence) ? textarea : null;
        }, 'chapter editor not ready', 20000);

        selectPhrase(chapterEditor, selectedSentence);
        const body = await sendPrompt('就在我刚高亮的这句里，给楚岚直播前和阿宁告别时补一小段暧昧但克制的感情戏，不要重写别处。', 'Text replaced successfully');
        await waitFor(
          () => chapterEditor.value.includes(replacementSentence) && !chapterEditor.value.includes(selectedSentence),
          'selection-sync replacement not applied'
        );
        await sleep(2400);
        const diskAfter = await window.mana.novel.readChapter(novelId, chapterFile);

        return {
          body,
          editorValue: chapterEditor.value,
          diskAfter,
          toolUsed: body.includes('调用: replace_selected_text'),
          missingSelection: body.includes('错误：系统里没有最新选区。'),
          replacedInUi: chapterEditor.value.includes(replacementSentence) && !chapterEditor.value.includes(selectedSentence),
          replacedOnDisk: diskAfter.includes(replacementSentence) && !diskAfter.includes(selectedSentence),
          unaffectedNeighbor: chapterEditor.value.includes('他把背包放下，先去洗了把脸。'),
        };
      })()
    `);

    if (r?.toolUsed && r?.replacedInUi && r?.replacedOnDisk && !r?.missingSelection) {
      pass('CHAT_SELECTION_SYNC_latest_selection_reaches_system_prompt', 'latest highlighted sentence was synced before send and edited via replace_selected_text');
    } else {
      fail('CHAT_SELECTION_SYNC_latest_selection_reaches_system_prompt', JSON.stringify(r));
    }

    if (r?.unaffectedNeighbor) {
      pass('CHAT_SELECTION_SYNC_does_not_rewrite_neighboring_text', 'neighboring sentence stayed untouched');
    } else {
      fail('CHAT_SELECTION_SYNC_does_not_rewrite_neighboring_text', JSON.stringify(r));
    }
  } catch (err) {
    fail('CHAT_SELECTION_SYNC_harness', err.message || String(err));
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

module.exports = { runChatSelectionSyncUiRegressionTest };
