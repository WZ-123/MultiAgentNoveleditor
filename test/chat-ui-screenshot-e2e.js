'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fireChatEvent(sessionId, kind, data) {
  const { webContents } = require('electron');
  const payload = { sessionId, kind, data, ts: Date.now() };
  for (const wc of webContents.getAllWebContents()) {
    try {
      wc.send('chatAgent:event', payload);
    } catch {
      // Ignore renderer disposal during shutdown.
    }
  }
}

async function runChatUiScreenshotRegressionTest(mainWindow) {
  const ROOT = path.resolve(__dirname, '..');
  const { paths } = require(path.join(ROOT, 'src/main/store/paths'));
  const chatAgent = require(path.join(ROOT, 'src/main/runtime/chatAgent'));
  const outbox = paths().feedbackOutbox;
  const results = { total: 0, passed: 0, failed: 0, screenshotPath: '' };

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

  const originalCreateSession = chatAgent.createSession;
  let latestSessionId = null;
  chatAgent.createSession = (...args) => {
    const sessionId = originalCreateSession(...args);
    latestSessionId = sessionId;
    return sessionId;
  };

  try {
    await fs.rm(outbox, { recursive: true, force: true });
    await fs.mkdir(outbox, { recursive: true });
    try {
      mainWindow.setSize(820, 980);
      mainWindow.setMinimumSize(700, 720);
      mainWindow.show();
      mainWindow.focus();
    } catch {
      // The screenshot still works in headless CI-style runs.
    }
    await delay(600);

    const ready = await mainWindow.webContents.executeJavaScript(`
      (async () => {
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const startedAt = Date.now();
        while (Date.now() - startedAt < 12000) {
          const input = document.querySelector('textarea[placeholder="向 AI 提问…"], input[placeholder="向 AI 提问…"]');
          if (input) return { ok: true };
          const buttons = Array.from(document.querySelectorAll('button'));
          const chatBtn = buttons.find((button) => {
            const text = button.textContent || '';
            const svg = button.querySelector('svg');
            return text.includes('AI') || svg?.getAttribute('data-lucide') === 'message-square' || svg?.classList.contains('lucide-message-square');
          });
          if (chatBtn) chatBtn.click();
          await sleep(250);
        }
        return { ok: false, body: (document.body.innerText || '').slice(0, 500) };
      })()
    `);
    if (ready?.ok) pass('CHAT_UI_SCREENSHOT_chat_ready', 'chat composer visible');
    else {
      fail('CHAT_UI_SCREENSHOT_chat_ready', JSON.stringify(ready));
      throw new Error('chat UI was not ready');
    }

    const created = await mainWindow.webContents.executeJavaScript(`
      (() => {
        const button = Array.from(document.querySelectorAll('button[title="新建对话"]'))[0] || null;
        if (!button) return { ok: false, step: 'find_new_thread_button' };
        button.click();
        return { ok: true };
      })()
    `);
    if (created?.ok) pass('CHAT_UI_SCREENSHOT_thread_created', 'new thread selected');
    else {
      fail('CHAT_UI_SCREENSHOT_thread_created', JSON.stringify(created));
      throw new Error('new thread button not found');
    }

    const compactList = await mainWindow.webContents.executeJavaScript(`
      (async () => {
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const waitFor = async (predicate, timeout = 5000) => {
          const startedAt = Date.now();
          while (Date.now() - startedAt < timeout) {
            const value = predicate();
            if (value) return value;
            await sleep(100);
          }
          return null;
        };
        const hideButton = await waitFor(() => document.querySelector('button[aria-label="隐藏侧边栏"]'));
        if (!hideButton) return { ok: false, step: 'hide_button_missing', body: (document.body.innerText || '').slice(0, 500) };
        hideButton.click();
        await sleep(100);
        return { ok: true };
      })()
    `);
    if (!compactList?.ok) {
      fail('CHAT_UI_SCREENSHOT_prepare_compact_list', JSON.stringify(compactList));
      throw new Error('could not hide sidebar before compact check');
    }

    try {
      mainWindow.setMinimumSize(420, 640);
      mainWindow.setSize(560, 780);
    } catch {
      // Continue with DOM-level verification when the window manager ignores sizing.
    }
    await delay(300);

    const compactReturn = await mainWindow.webContents.executeJavaScript(`
      (async () => {
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const waitFor = async (predicate, message, timeout = 6000) => {
          const startedAt = Date.now();
          while (Date.now() - startedAt < timeout) {
            const value = predicate();
            if (value) return value;
            await sleep(100);
          }
          throw new Error(message);
        };
        const shell = await waitFor(() => document.querySelector('[data-testid="chat-shell"][data-compact="true"]'), 'compact shell not detected');
        const returnButton = await waitFor(() => document.querySelector('button[aria-label="返回对话列表"]'), 'return list button missing');
        returnButton.click();
        await waitFor(() => document.body.innerText.includes('对话历史') && shell.getAttribute('data-compact-sidebar') === 'true', 'thread list did not return');
        const row = await waitFor(() => document.querySelector('.mana-chat-thread-item'), 'thread row missing');
        row.click();
        await waitFor(() => document.querySelector('[data-testid="chat-composer"]') && shell.getAttribute('data-compact-sidebar') === 'false', 'chat composer did not return');
        return {
          ok: true,
          compact: shell.getAttribute('data-compact'),
          compactSidebar: shell.getAttribute('data-compact-sidebar'),
          width: window.innerWidth,
          hasComposer: !!document.querySelector('[data-testid="chat-composer"]'),
        };
      })()
    `);
    if (compactReturn?.ok) pass('CHAT_UI_SCREENSHOT_compact_return_to_thread_list', JSON.stringify(compactReturn));
    else {
      fail('CHAT_UI_SCREENSHOT_compact_return_to_thread_list', JSON.stringify(compactReturn));
      throw new Error('compact return-to-list flow failed');
    }

    try {
      mainWindow.setMinimumSize(700, 720);
      mainWindow.setSize(820, 980);
    } catch {
      // The screenshot still works in headless CI-style runs.
    }
    await delay(300);

    const startedAt = Date.now();
    while (!latestSessionId && Date.now() - startedAt < 5000) {
      await delay(50);
    }
    if (latestSessionId) pass('CHAT_UI_SCREENSHOT_session_captured', latestSessionId);
    else {
      fail('CHAT_UI_SCREENSHOT_session_captured', 'session id missing');
      throw new Error('session id missing');
    }

    fireChatEvent(latestSessionId, 'turn_start', { userText: '截图验收：展示自动执行链和进度反馈' });
    fireChatEvent(latestSessionId, 'progress', { stage: 'intent', message: '识别到「确认写入大纲并继续写第八章」：进入受控自动执行链。' });
    fireChatEvent(latestSessionId, 'progress', { stage: 'outline', message: '已保存大纲，正在读取上一章、世界观、角色状态和时间线。' });
    fireChatEvent(latestSessionId, 'progress', { stage: 'roleplay', message: '导演视角：恶毒、拉菲莉、小天鹅进入书房；第 1/3 轮深度互动开始。' });
    fireChatEvent(latestSessionId, 'progress', { stage: 'roleplay', message: '角色动作：恶毒按住门把，拉菲莉检查兔耳，小天鹅记录气味线索。' });
    fireChatEvent(latestSessionId, 'tool_use', {
      id: 'tool-screenshot-draft',
      name: 'draft_chapter_with_roleplay',
      input: {
        chapter: '第8章',
        mode: 'character_driven',
        deepInteractionRounds: 3,
      },
    });
    fireChatEvent(latestSessionId, 'tool_result', {
      id: 'tool-screenshot-draft',
      text: JSON.stringify({
        message: '已生成第8章草稿，等待用户确认写入。',
        changedFiles: [
          {
            kind: 'chapter',
            label: '第8章：驱逐舰区的早晨',
            chapterName: '第8章：驱逐舰区的早晨',
            beforeContent: '',
            afterContent: '第二天早上十点，书房走廊里的脚步声同时停住。四道身影并排站在深色木门前。',
          },
        ],
      }),
      isError: false,
    });
    fireChatEvent(latestSessionId, 'text_delta', {
      delta: [
        '我会继续按自动链路推进，不再停在「已切换到写作阶段」。',
        '',
        '当前正在写第8章草稿：先进行角色驱动互动，再由导演视角汇总行动、对白和场面调度，最后产出可确认写入的章节草稿。',
        '',
        '片段预览：第二天早上十点，书房走廊里的脚步声同时停住。四道身影并排站在那扇深色木门前，像四尊被特意摆放在那里的瓷偶，每个人都不太确定自己是该先推门，还是该先深呼吸。晨光透过走廊尽头的窗格斜斜照进来，在地板上切出几道细长的光影。',
      ].join(String.fromCharCode(10)),
    });

    const domState = await mainWindow.webContents.executeJavaScript(`
      (async () => {
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const startedAt = Date.now();
        while (Date.now() - startedAt < 4000) {
          const body = document.body.innerText || '';
          const shell = document.querySelector('[data-testid="chat-shell"]');
          const scroll = document.querySelector('[data-testid="chat-message-scroll"]');
          if (shell && scroll && body.includes('自动执行中') && body.includes('draft_chapter_with_roleplay')) {
            scroll.scrollTop = Math.max(0, scroll.scrollHeight - scroll.clientHeight - 180);
            return {
              ok: true,
              width: window.innerWidth,
              height: window.innerHeight,
              scrollHeight: scroll.scrollHeight,
              clientHeight: scroll.clientHeight,
              body: body.slice(0, 600),
            };
          }
          await sleep(100);
        }
        return { ok: false, body: (document.body.innerText || '').slice(0, 800) };
      })()
    `);
    if (domState?.ok) pass('CHAT_UI_SCREENSHOT_sample_rendered', `${domState.width}x${domState.height}, scroll=${domState.scrollHeight}/${domState.clientHeight}`);
    else {
      fail('CHAT_UI_SCREENSHOT_sample_rendered', JSON.stringify(domState));
      throw new Error('sample chat state not rendered');
    }

    const feedbackResult = await mainWindow.webContents.executeJavaScript(`
      window.mana.feedback.submit({
        userInput: {
          issueTitle: '聊天 UI 截图验收',
          description: '用一键反馈截图链路保存当前 AI 聊天面板的真实渲染效果。',
          feedbackMode: 'context-with-logs'
        },
        route: { screen: 'ai-chat', scenario: 'ui-screenshot-regression' },
        recentConversation: [
          { role: 'user', text: '确认写入大纲并继续写第八章' },
          { role: 'assistant', text: '自动执行链路推进中，并显示进度反馈。' }
        ]
      }, { includeScreenshot: true })
    `);

    const screenshotPath = feedbackResult?.attachments?.find((item) => item.kind === 'window-screenshot')?.localPath || '';
    if (screenshotPath) {
      const stat = await fs.stat(screenshotPath);
      if (stat.size > 10000) {
        results.screenshotPath = screenshotPath;
        pass('CHAT_UI_SCREENSHOT_feedback_saved_png', `${screenshotPath} (${stat.size} bytes)`);
        console.log(`TEST_SCREENSHOT ${screenshotPath}`);
      } else {
        fail('CHAT_UI_SCREENSHOT_feedback_saved_png', `screenshot too small: ${stat.size}`);
      }
    } else {
      fail('CHAT_UI_SCREENSHOT_feedback_saved_png', JSON.stringify(feedbackResult));
    }
  } catch (err) {
    fail('CHAT_UI_SCREENSHOT_harness', err.message || String(err));
  } finally {
    chatAgent.createSession = originalCreateSession;
  }

  console.log('');
  console.log(`TEST_SUMMARY ${results.passed}/${results.total} passed, ${results.failed} failed`);
  console.log('TEST_DONE');
  return results;
}

module.exports = { runChatUiScreenshotRegressionTest };
