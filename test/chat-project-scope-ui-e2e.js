'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function seedNovel(ROOT, title, suffix) {
  const novelsStore = require(path.join(ROOT, 'src/main/store/novels'));
  const { novelPaths } = require(path.join(ROOT, 'src/main/store/paths'));

  const tmpRoot = path.join(ROOT, 'tmp-test-chat-project-scope-ui');
  await fs.mkdir(tmpRoot, { recursive: true });
  const dir = path.join(tmpRoot, `${suffix}-novel-${Date.now()}`);
  await fs.mkdir(dir, { recursive: true });

  const entry = await novelsStore.createNovel({ title, dir });
  const np = novelPaths(dir);
  await fs.mkdir(np.chapters, { recursive: true });
  await fs.writeFile(path.join(np.chapters, 'chapter-001.md'), `# ${title}\n\n${title} 正文。`, 'utf8');
  return { entry, dir, tmpRoot };
}

async function seedThreads(ROOT, novelA, novelB) {
  const chatHistory = require(path.join(ROOT, 'src/main/store/chatHistory'));

  const threadA = await chatHistory.createThread({ title: 'A项目线程', novelId: novelA.entry.id });
  await chatHistory.appendMessage(threadA.id, chatHistory.createMessage({ role: 'assistant', text: 'A项目会话消息' }));

  await delay(10);
  const threadB = await chatHistory.createThread({ title: 'B项目线程', novelId: novelB.entry.id });
  await chatHistory.appendMessage(threadB.id, chatHistory.createMessage({ role: 'assistant', text: 'B项目会话消息' }));

  await delay(10);
  const blankThread = await chatHistory.createThread({ title: '空白项目线程', novelId: null });
  await chatHistory.appendMessage(blankThread.id, chatHistory.createMessage({ role: 'assistant', text: '空白项目会话消息' }));

  return { threadA, threadB, blankThread };
}

async function runChatProjectScopeUiRegressionTest(mainWindow) {
  const ROOT = path.resolve(__dirname, '..');
  const novelsStore = require(path.join(ROOT, 'src/main/store/novels'));
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
    const novelA = await seedNovel(ROOT, '聊天项目A', 'a');
    const novelB = await seedNovel(ROOT, '聊天项目B', 'b');
    cleanupRoot = novelA.tmpRoot;
    const threads = await seedThreads(ROOT, novelA, novelB);
    await novelsStore.openNovel(novelA.entry.id);
    pass('CHAT_PROJECT_SCOPE_seed_data', `${novelA.entry.id}, ${novelB.entry.id}, ${threads.blankThread.id}`);

    await delay(1800);

    const r = await mainWindow.webContents.executeJavaScript(`
      (async () => {
        const novelAId = ${JSON.stringify(novelA.entry.id)};
        const novelBId = ${JSON.stringify(novelB.entry.id)};
        const blankThreadTitle = ${JSON.stringify(threads.blankThread.title)};
        const threadATitle = ${JSON.stringify(threads.threadA.title)};
        const threadBTitle = ${JSON.stringify(threads.threadB.title)};
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

        function threadRows() {
          return Array.from(document.querySelectorAll('div.cursor-pointer.text-xs'));
        }

        function findThreadRow(title) {
          return threadRows().find((node) => (node.innerText || '').includes(title)) || null;
        }

        function findButtonByText(text) {
          return Array.from(document.querySelectorAll('button')).find((button) => (button.textContent || '').includes(text)) || null;
        }

        await window.mana.novel.open(novelAId);

        await waitFor(async () => {
          const active = await window.mana.novel.active();
          return active?.id === novelAId;
        }, 'novel A not active');

        await waitFor(() => findThreadRow(threadATitle), 'thread A row not visible');
        const bodyBeforeExpand = document.body.innerText || '';

        const otherButton = await waitFor(() => findButtonByText('其他项目中的会话'), 'other projects button missing');
        otherButton.click();
        await waitFor(() => findThreadRow(threadBTitle) && findThreadRow(blankThreadTitle), 'other project rows did not expand');

        const confirmMessages = [];
        const originalConfirm = window.confirm;
        window.confirm = (message) => {
          confirmMessages.push(String(message || ''));
          return true;
        };

        try {
          findThreadRow(threadBTitle)?.click();
          await waitFor(async () => {
            const active = await window.mana.novel.active();
            return active?.id === novelBId;
          }, 'novel B not active after switch');
          await waitFor(() => (document.body.innerText || '').includes('B项目会话消息'), 'thread B messages not shown');

          const bodyAfterB = document.body.innerText || '';

          const otherButtonAfterB = await waitFor(() => findButtonByText('其他项目中的会话'), 'other projects button missing after B switch');
          if (!findThreadRow(blankThreadTitle)) {
            otherButtonAfterB.click();
          }
          await waitFor(() => findThreadRow(blankThreadTitle), 'blank thread row missing after B switch');

          findThreadRow(blankThreadTitle)?.click();
          await waitFor(async () => {
            const active = await window.mana.novel.active();
            return !active?.id;
          }, 'blank project not active after switch');
          await waitFor(() => (document.body.innerText || '').includes('空白项目会话消息'), 'blank thread messages not shown');

          const bodyAfterBlank = document.body.innerText || '';
          const activeAfterBlank = await window.mana.novel.active();

          return {
            beforeExpandHasOnlyCurrent: bodyBeforeExpand.includes(threadATitle) && !bodyBeforeExpand.includes(threadBTitle) && !bodyBeforeExpand.includes(blankThreadTitle),
            confirmMessages,
            bodyAfterB,
            bodyAfterBlank,
            activeAfterBlank: activeAfterBlank || null,
          };
        } finally {
          window.confirm = originalConfirm;
        }
      })()
    `);

    if (r?.beforeExpandHasOnlyCurrent) {
      pass('CHAT_PROJECT_SCOPE_current_project_list_is_scoped', 'before expanding others, only current-project thread is visible');
    } else {
      fail('CHAT_PROJECT_SCOPE_current_project_list_is_scoped', JSON.stringify(r));
    }

    if (
      Array.isArray(r?.confirmMessages)
      && r.confirmMessages.length >= 2
      && r.confirmMessages.every((message) => message.includes('切换会话也会切换项目'))
      && String(r.bodyAfterB || '').includes('B项目会话消息')
    ) {
      pass('CHAT_PROJECT_SCOPE_cross_project_click_confirms_and_switches', 'cross-project thread click asked for confirmation and switched to project B');
    } else {
      fail('CHAT_PROJECT_SCOPE_cross_project_click_confirms_and_switches', JSON.stringify(r));
    }

    if (
      !r?.activeAfterBlank?.id
      && String(r.bodyAfterBlank || '').includes('空白项目会话消息')
    ) {
      pass('CHAT_PROJECT_SCOPE_blank_project_thread_is_supported', 'blank-project thread reopened under empty project context');
    } else {
      fail('CHAT_PROJECT_SCOPE_blank_project_thread_is_supported', JSON.stringify(r));
    }
  } catch (err) {
    fail('CHAT_PROJECT_SCOPE_harness', err?.message || String(err));
  } finally {
    try {
      if (cleanupRoot) await fs.rm(cleanupRoot, { recursive: true, force: true });
    } catch {
      // ignore cleanup failure
    }
  }

  console.log('');
  console.log(`TEST_SUMMARY ${results.passed}/${results.total} passed, ${results.failed} failed`);
  console.log('TEST_DONE');
  return results;
}

module.exports = { runChatProjectScopeUiRegressionTest };
