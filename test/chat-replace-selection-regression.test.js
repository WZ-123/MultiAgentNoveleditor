'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function seedNovel(ROOT) {
  const novelsStore = require(path.join(ROOT, 'src/main/store/novels'));
  const { novelPaths } = require(path.join(ROOT, 'src/main/store/paths'));

  const tmpRoot = path.join(ROOT, 'tmp-test-chat-replace-regression');
  await fs.rm(tmpRoot, { recursive: true, force: true });
  await fs.mkdir(tmpRoot, { recursive: true });

  const dir = path.join(tmpRoot, 'novel-' + Date.now());
  await fs.mkdir(dir, { recursive: true });

  const entry = await novelsStore.createNovel({ title: '聊天替换回归小说', dir });
  const np = novelPaths(dir);
  await fs.mkdir(np.chapters, { recursive: true });
  await fs.writeFile(path.join(np.chapters, 'chapter-001.md'), `# 天桥摊前

晨光穿过旧窗台，照在斑驳的木桌上。
阿宁把铜钱在指间翻了个花，笑得像没睡醒。
她袖口里还藏着另一枚铜钱，以备临时起卦。
铜钱左右铜钱，一时看不出该敲哪一枚。
街口忽然传来一阵喧哗，像有人打翻了整条早市。
她抬起眼，决定先看看热闹，再决定要不要出手。
`, 'utf8');

  return { entry, cleanupRoot: tmpRoot, chapterFile: 'chapter-001.md' };
}

async function runChatReplaceSelectionRegressionTest(mainWindow) {
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

  const unsavedOriginal = '阿宁把铜钱在指间翻了个花，笑得像没睡醒。';
  const unsavedEditedLine = '阿宁把铜钱在指间翻了个花，笑意却没到眼底。';
  const unsavedReplacement = '阿宁把铜钱在指间翻了个花，笑意收住，只剩眼底一点冷光。';
  const autoOriginal = '她抬起眼，决定先看看热闹，再决定要不要出手。';
  const autoReplacement = '她抬起眼，决定先把那阵异样的喧哗看个分明。';
  const firstOriginal = '晨光穿过旧窗台，照在斑驳的木桌上。';
  const firstReplacement = '晨光像碎金一样落在旧窗台上。';
  const duplicateTarget = '铜钱';
  const duplicateReplacement = '铜铃';
  const duplicateFirstLine = unsavedReplacement;
  const duplicateSecondLine = '她袖口里还藏着另一枚铜钱，以备临时起卦。';
  const equidistantLine = '铜钱左右铜钱，一时看不出该敲哪一枚。';
  const secondOriginal = '街口忽然传来一阵喧哗，像有人打翻了整条早市。';
  const manualReplacement = '街口忽然传来一阵喧哗，卖鱼摊的木桶被人撞翻在地。';
  const blockedReplacement = '这句不该被插进去。';

  const scriptedResponses = [
    {
      stopReason: 'tool_use',
      content: [
        { type: 'text', text: '我先按你刚改过的最新句子继续细修。' },
        {
          type: 'tool_use',
          id: 'toolu-unsaved-replace-1',
          name: 'replace_chapter_text',
          input: { name: chapterFile, targetText: unsavedEditedLine, replacement: unsavedReplacement },
        },
      ],
    },
    {
      stopReason: 'end_turn',
      content: [
        { type: 'text', text: '未保存改动后的替换已完成。' },
      ],
    },
    {
      stopReason: 'tool_use',
      content: [
        { type: 'text', text: '我先直接定位当前章节里那句动作描写。' },
        {
          type: 'tool_use',
          id: 'toolu-auto-replace-1',
          name: 'replace_chapter_text',
          input: { name: chapterFile, targetText: autoOriginal, replacement: autoReplacement },
        },
      ],
    },
    {
      stopReason: 'end_turn',
      content: [
        { type: 'text', text: '自动定位替换已完成。' },
      ],
    },
    {
      stopReason: 'tool_use',
      content: [
        { type: 'text', text: '我先替换你选中的第一句。' },
        {
          type: 'tool_use',
          id: 'toolu-replace-1',
          name: 'replace_selected_text',
          input: { replacement: firstReplacement },
        },
      ],
    },
    {
      stopReason: 'end_turn',
      content: [
        { type: 'text', text: '第一处替换已完成。' },
      ],
    },
    {
      stopReason: 'tool_use',
      content: [
        { type: 'text', text: '我先尝试直接替换这段重复出现的原文。' },
        {
          type: 'tool_use',
          id: 'toolu-duplicate-replace-1',
          name: 'replace_chapter_text',
          input: { name: chapterFile, targetText: duplicateTarget, replacement: duplicateReplacement },
        },
      ],
    },
    {
      stopReason: 'end_turn',
      content: [
        { type: 'text', text: '这段原文命中了多处，请你把光标放到要改的那一处旁边。' },
      ],
    },
    {
      stopReason: 'tool_use',
      content: [
        { type: 'text', text: '我按你刚放好的光标位置，只替换附近那一处。' },
        {
          type: 'tool_use',
          id: 'toolu-near-cursor-replace-1',
          name: 'replace_text_near_cursor',
          input: { targetText: duplicateTarget, replacement: duplicateReplacement },
        },
      ],
    },
    {
      stopReason: 'end_turn',
      content: [
        { type: 'text', text: '已按光标附近的位置替换。' },
      ],
    },
    {
      stopReason: 'tool_use',
      content: [
        { type: 'text', text: '我按你现在的光标位置继续尝试替换。' },
        {
          type: 'tool_use',
          id: 'toolu-near-cursor-replace-2',
          name: 'replace_text_near_cursor',
          input: { targetText: duplicateTarget, replacement: duplicateReplacement },
        },
      ],
    },
    {
      stopReason: 'end_turn',
      content: [
        { type: 'text', text: '这次光标两边的候选距离一样，我先不替换。' },
      ],
    },
    {
      stopReason: 'tool_use',
      content: [
        { type: 'text', text: '我再替换你刚刚选中的第二句。' },
        {
          type: 'tool_use',
          id: 'toolu-replace-2',
          name: 'replace_selected_text',
          input: { replacement: blockedReplacement },
        },
      ],
    },
    {
      stopReason: 'end_turn',
      content: [
        { type: 'text', text: '第二处替换尝试结束。' },
      ],
    },
  ];

  try {
    const seeded = await seedNovel(ROOT);
    cleanupRoot = seeded.cleanupRoot;
    entry = seeded.entry;
    chapterFile = seeded.chapterFile;
    pass('CHAT_REPLACE_seed_novel', entry.id);

    providerManager.getActiveProvider = async () => ({
      id: 'chat-replace-regression-provider',
      name: 'chat-replace-regression-provider',
      type: 'anthropic',
      apiKey: 'chat-replace-regression-key',
      baseUrl: 'https://example.invalid',
      models: [{ id: 'chat-replace-regression-model' }],
    });
    modelAliases.getAlias = async (aliasId) => ({
      id: aliasId || 'sonnet',
      providerId: null,
      modelId: 'chat-replace-regression-model',
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
        const unsavedOriginal = ${JSON.stringify(unsavedOriginal)};
        const unsavedEditedLine = ${JSON.stringify(unsavedEditedLine)};
        const unsavedReplacement = ${JSON.stringify(unsavedReplacement)};
        const autoOriginal = ${JSON.stringify(autoOriginal)};
        const autoReplacement = ${JSON.stringify(autoReplacement)};
        const firstOriginal = ${JSON.stringify(firstOriginal)};
        const firstReplacement = ${JSON.stringify(firstReplacement)};
        const duplicateTarget = ${JSON.stringify(duplicateTarget)};
        const duplicateReplacement = ${JSON.stringify(duplicateReplacement)};
        const duplicateFirstLine = ${JSON.stringify(duplicateFirstLine)};
        const duplicateSecondLine = ${JSON.stringify(duplicateSecondLine)};
        const equidistantLine = ${JSON.stringify(equidistantLine)};
        const secondOriginal = ${JSON.stringify(secondOriginal)};
        const manualReplacement = ${JSON.stringify(manualReplacement)};
        const blockedReplacement = ${JSON.stringify(blockedReplacement)};
        const chapterButtonLabel = '第一章：天桥摊前';
        const chapterButtonHints = [chapterButtonLabel, '天桥摊前', chapterFile, '第一章'];

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

        function placeCursorNearOccurrence(textarea, phrase, occurrenceIndex = 1) {
          let fromIndex = 0;
          let foundAt = -1;
          for (let i = 0; i <= occurrenceIndex; i += 1) {
            foundAt = textarea.value.indexOf(phrase, fromIndex);
            if (foundAt < 0) throw new Error('occurrence not found: ' + phrase + ' #' + occurrenceIndex);
            fromIndex = foundAt + phrase.length;
          }
          const cursorPos = foundAt + phrase.length;
          textarea.focus();
          textarea.setSelectionRange(cursorPos, cursorPos);
          textarea.dispatchEvent(new Event('select', { bubbles: true }));
          textarea.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          textarea.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'ArrowRight' }));
          return cursorPos;
        }

        function placeCursorBetweenOccurrences(textarea, lineText, leftToken, rightToken) {
          const lineStart = textarea.value.indexOf(lineText);
          if (lineStart < 0) throw new Error('line not found: ' + lineText);
          const leftStart = textarea.value.indexOf(leftToken, lineStart);
          const rightStart = textarea.value.indexOf(rightToken, leftStart + leftToken.length);
          if (leftStart < 0 || rightStart < 0) throw new Error('equidistant occurrences not found');
          const cursorPos = Math.floor((leftStart + leftToken.length + rightStart) / 2);
          textarea.focus();
          textarea.setSelectionRange(cursorPos, cursorPos);
          textarea.dispatchEvent(new Event('select', { bubbles: true }));
          textarea.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          textarea.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'ArrowRight' }));
          return cursorPos;
        }

        async function sendPrompt(prompt, doneMarker, options = {}) {
          const input = await waitFor(
            () => document.querySelector('input[placeholder="向 AI 提问…"]'),
            'chat input not found'
          );
          input.focus();
          let selectionOverlayVisible = false;
          if (options.expectSelectionOverlay) {
            await waitFor(
              () => document.querySelector('[data-editor-selection-overlay="visible"]'),
              'selection overlay not visible',
              2000
            );
            selectionOverlayVisible = true;
          }
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
          return {
            body: document.body.innerText || '',
            selectionOverlayVisible,
          };
        }

        await window.mana.novel.open(novelId);

        const chapterButton = await waitFor(() => {
          const buttons = Array.from(document.querySelectorAll('button'));
          return buttons.find((button) => {
            const text = (button.textContent || '').trim();
            return text && chapterButtonHints.some((hint) => text.includes(hint));
          }) || null;
        }, 'chapter button not found: ' + JSON.stringify(Array.from(document.querySelectorAll('button')).map((button) => (button.textContent || '').trim()).filter(Boolean)), 20000);
        chapterButton.click();

        const chapterEditor = await waitFor(() => {
          const textarea = document.querySelector('textarea');
          if (!textarea) return null;
          return textarea.value.includes(firstOriginal) ? textarea : null;
        }, 'chapter editor not ready', 20000);

        setControlValue(chapterEditor, chapterEditor.value.replace(unsavedOriginal, unsavedEditedLine));
        await sleep(150);
        chapterEditor.setSelectionRange(0, 0);
        chapterEditor.blur();
        const unsavedResult = await sendPrompt('我刚把阿宁那句动作自己改了一下，你接着再收紧一点，不用我手动选。', '未保存改动后的替换已完成。');
        await waitFor(
          () => chapterEditor.value.includes(unsavedReplacement) && !chapterEditor.value.includes(unsavedEditedLine),
          'unsaved replacement not applied'
        );
        const diskAfterUnsaved = await window.mana.novel.readChapter(novelId, chapterFile);

        chapterEditor.setSelectionRange(0, 0);
        chapterEditor.blur();
        const autoResult = await sendPrompt('请直接把当前章节最后一句改得更警觉一点，不用我手动选。', '自动定位替换已完成。');
        await waitFor(
          () => chapterEditor.value.includes(autoReplacement) && !chapterEditor.value.includes(autoOriginal),
          'auto replacement not applied'
        );
        await sleep(2400);
        const diskAfterAuto = await window.mana.novel.readChapter(novelId, chapterFile);

        selectPhrase(chapterEditor, firstOriginal);
        const firstResult = await sendPrompt('请把我选中的第一句改得更有画面感。', '第一处替换已完成。', { expectSelectionOverlay: true });
        await waitFor(
          () => chapterEditor.value.includes(firstReplacement) && !chapterEditor.value.includes(firstOriginal),
          'first replacement not applied'
        );
        await sleep(2400);
        const diskAfterFirst = await window.mana.novel.readChapter(novelId, chapterFile);

        chapterEditor.setSelectionRange(0, 0);
        chapterEditor.blur();
        const duplicateResult = await sendPrompt('把文里第二处“铜钱”换成“铜铃”；如果你发现多命中，就先告诉我需要我定位。', '这段原文命中了多处，请你把光标放到要改的那一处旁边。');

        placeCursorNearOccurrence(chapterEditor, duplicateTarget, 1);
        const nearCursorResult = await sendPrompt('我已经把光标放到第二处“铜钱”旁边了，你继续替换。', '已按光标附近的位置替换。');
        await waitFor(
          () => chapterEditor.value.includes(duplicateFirstLine) && chapterEditor.value.includes(duplicateSecondLine.replace(duplicateTarget, duplicateReplacement)),
          'near-cursor replacement not applied to the intended occurrence'
        );
        await sleep(2400);
        const diskAfterNearCursor = await window.mana.novel.readChapter(novelId, chapterFile);

        placeCursorBetweenOccurrences(chapterEditor, equidistantLine, duplicateTarget, duplicateTarget);
        const equalDistanceResult = await sendPrompt('我把光标放在“铜钱左右铜钱”中间了，你继续替换。', '这次光标两边的候选距离一样，我先不替换。');
        await sleep(500);
        const diskAfterEqualDistance = await window.mana.novel.readChapter(novelId, chapterFile);

        selectPhrase(chapterEditor, secondOriginal);
        setControlValue(chapterEditor, chapterEditor.value.replace(secondOriginal, manualReplacement));
        await sleep(150);
        chapterEditor.setSelectionRange(0, 0);
        chapterEditor.blur();

        const secondResult = await sendPrompt('请把我刚才选中的第二句改得更紧张。', '第二处替换尝试结束。');
        await sleep(2400);
        const diskAfterSecond = await window.mana.novel.readChapter(novelId, chapterFile);

        return {
          unsavedBody: unsavedResult.body,
          autoBody: autoResult.body,
          firstBody: firstResult.body,
          secondBody: secondResult.body,
          editorValue: chapterEditor.value,
          diskAfterUnsaved,
          diskAfterAuto,
          diskAfterFirst,
          diskAfterNearCursor,
          diskAfterEqualDistance,
          diskAfterSecond,
          selectionOverlayVisible: firstResult.selectionOverlayVisible,
          unsavedReplaceUi: chapterEditor.value.includes(unsavedReplacement) && !chapterEditor.value.includes(unsavedEditedLine),
          unsavedReplaceDisk: diskAfterUnsaved.includes(unsavedReplacement) && !diskAfterUnsaved.includes(unsavedEditedLine),
          unsavedReplaceToolUsed: unsavedResult.body.includes('调用: replace_chapter_text'),
          autoReplaceUi: chapterEditor.value.includes(autoReplacement) && !chapterEditor.value.includes(autoOriginal),
          autoReplaceDisk: diskAfterAuto.includes(autoReplacement) && !diskAfterAuto.includes(autoOriginal),
          autoReplaceToolUsed: autoResult.body.includes('调用: replace_chapter_text'),
          firstReplaceUi: chapterEditor.value.includes(firstReplacement) && !chapterEditor.value.includes(firstOriginal),
          firstReplaceDisk: diskAfterFirst.includes(firstReplacement) && !diskAfterFirst.includes(firstOriginal),
          duplicatePromptedForCursor: duplicateResult.body.includes('调用: replace_chapter_text') && duplicateResult.body.includes('replace_text_near_cursor'),
          nearCursorToolUsed: nearCursorResult.body.includes('调用: replace_text_near_cursor'),
          nearCursorReplaceUi: chapterEditor.value.includes(duplicateFirstLine) && chapterEditor.value.includes(duplicateSecondLine.replace(duplicateTarget, duplicateReplacement)),
          nearCursorReplaceDisk: diskAfterNearCursor.includes(duplicateFirstLine) && diskAfterNearCursor.includes(duplicateSecondLine.replace(duplicateTarget, duplicateReplacement)) && !diskAfterNearCursor.includes(duplicateFirstLine.replace(duplicateTarget, duplicateReplacement)),
          equalDistanceToolUsed: equalDistanceResult.body.includes('调用: replace_text_near_cursor'),
          equalDistanceRejected: equalDistanceResult.body.includes('错误: Frontend action failed: 当前光标附近仍有多个等距命中，请再把光标放近一点，或直接手动选中文本'),
          equalDistanceDiskUnchanged: diskAfterEqualDistance.includes(equidistantLine),
          staleRejectUi: secondResult.body.includes('错误: Frontend action failed:') && chapterEditor.value.includes(manualReplacement) && !chapterEditor.value.includes(blockedReplacement),
          staleRejectDisk: diskAfterSecond.includes(manualReplacement) && !diskAfterSecond.includes(blockedReplacement),
        };
      })()
    `);

    if (r?.unsavedReplaceUi && r?.unsavedReplaceDisk && r?.unsavedReplaceToolUsed) {
      pass('CHAT_REPLACE_unsaved_editor_flush_before_backend_replace', 'chat send flushed unsaved editor content before replace_chapter_text ran');
    } else {
      fail('CHAT_REPLACE_unsaved_editor_flush_before_backend_replace', JSON.stringify(r));
    }

    if (r?.autoReplaceUi && r?.autoReplaceDisk && r?.autoReplaceToolUsed) {
      pass('CHAT_REPLACE_auto_targeted_replace', 'AI replaced chapter text through replace_chapter_text without requiring a manual selection');
    } else {
      fail('CHAT_REPLACE_auto_targeted_replace', JSON.stringify(r));
    }

    if (r?.firstReplaceUi && r?.firstReplaceDisk) {
      pass('CHAT_REPLACE_real_replace', 'selected text was replaced in editor and persisted to disk');
    } else {
      fail('CHAT_REPLACE_real_replace', JSON.stringify(r));
    }

    if (r?.selectionOverlayVisible) {
      pass('CHAT_REPLACE_selection_overlay', 'selected text remains visibly highlighted after focus moves into the chat input');
    } else {
      fail('CHAT_REPLACE_selection_overlay', JSON.stringify(r));
    }

    if (r?.duplicatePromptedForCursor && r?.nearCursorToolUsed && r?.nearCursorReplaceUi && r?.nearCursorReplaceDisk) {
      pass('CHAT_REPLACE_duplicate_match_requires_cursor', 'duplicate matches now require the user to place the cursor near the intended occurrence before AI performs a near-cursor replacement');
    } else {
      fail('CHAT_REPLACE_duplicate_match_requires_cursor', JSON.stringify(r));
    }

    if (r?.equalDistanceToolUsed && r?.equalDistanceRejected && r?.equalDistanceDiskUnchanged) {
      pass('CHAT_REPLACE_near_cursor_equal_distance_rejected', 'replace_text_near_cursor rejects equidistant candidates instead of guessing');
    } else {
      fail('CHAT_REPLACE_near_cursor_equal_distance_rejected', JSON.stringify(r));
    }

    if (r?.staleRejectUi && r?.staleRejectDisk) {
      pass('CHAT_REPLACE_stale_selection_guard', 'stale cached selection returned frontend failure without corrupting chapter content');
    } else {
      fail('CHAT_REPLACE_stale_selection_guard', JSON.stringify(r));
    }
  } catch (err) {
    fail('CHAT_REPLACE_harness', err.message || String(err));
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

module.exports = { runChatReplaceSelectionRegressionTest };