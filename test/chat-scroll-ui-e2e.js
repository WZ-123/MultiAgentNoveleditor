'use strict';

const path = require('node:path');

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeStreamingChunk(index) {
  return [
    `滚动回归片段 ${index}`,
    '北雾港夜色沉沉，海风拍打石阶。',
    '主角沿着堤岸急行，反复核对线索与时间。',
    '这一段专门用于制造足够的滚动高度与流式增量。',
    '',
  ].join('\n');
}

async function runChatScrollUiRegressionTest(mainWindow) {
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

  const { webContents } = require('electron');
  const chatAgent = require(path.join(ROOT, 'src/main/runtime/chatAgent'));

  const originalCreateSession = chatAgent.createSession;
  let latestSessionId = null;

  function fireChatEvent(sessionId, kind, data) {
    const payload = { sessionId, kind, data, ts: Date.now() };
    for (const wc of webContents.getAllWebContents()) {
      try {
        wc.send('chatAgent:event', payload);
      } catch {
        // ignore renderer disposal during shutdown
      }
    }
  }

  async function streamChunks(sessionId, startIndex, count) {
    for (let index = startIndex; index < startIndex + count; index += 1) {
      fireChatEvent(sessionId, 'text_delta', { delta: makeStreamingChunk(index) });
      await delay(30);
    }
  }

  chatAgent.createSession = (...args) => {
    const sessionId = originalCreateSession(...args);
    latestSessionId = sessionId;
    return sessionId;
  };

  try {
    const ready = await mainWindow.webContents.executeJavaScript(`
      (async () => {
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
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        return { ok: false, body: (document.body.innerText || '').slice(0, 400) };
      })()
    `);
    if (ready?.ok) {
      pass('CS1_ui_ready', 'chat input visible');
    } else {
      fail('CS1_ui_ready', JSON.stringify(ready));
      throw new Error('chat input not ready');
    }

    const created = await mainWindow.webContents.executeJavaScript(`
      (() => {
        const buttons = Array.from(document.querySelectorAll('button[title="新建对话"]'));
        const button = buttons[0] || null;
        if (!button) return { ok: false, step: 'find_new_thread_button' };
        button.click();
        return { ok: true, buttonCount: buttons.length };
      })()
    `);
    if (created?.ok) {
      pass('CS2_create_thread', `buttons=${created.buttonCount}`);
    } else {
      fail('CS2_create_thread', JSON.stringify(created));
      throw new Error('new thread button not found');
    }

    const sessionStartedAt = Date.now();
    while (!latestSessionId && Date.now() - sessionStartedAt < 5000) {
      await delay(50);
    }
    if (latestSessionId) {
      pass('CS3_session_captured', latestSessionId);
    } else {
      fail('CS3_session_captured', 'session id was not captured after createThread');
      throw new Error('session not captured');
    }

    fireChatEvent(latestSessionId, 'turn_start', { userText: '滚动回归测试' });
    await streamChunks(latestSessionId, 1, 18);
    const overflowState = await mainWindow.webContents.executeJavaScript(`
      (() => {
        const container = document.querySelector('div.h-full.overflow-y-auto.p-3.space-y-3');
        if (!container) return { ok: false, step: 'find_container' };
        return {
          ok: true,
          clientHeight: container.clientHeight,
          scrollHeight: container.scrollHeight,
          scrollTop: container.scrollTop,
          overflowed: container.scrollHeight > container.clientHeight + 120,
        };
      })()
    `);
    if (overflowState?.overflowed) {
      pass('CS4_stream_overflows_container', `height=${overflowState.scrollHeight}/${overflowState.clientHeight}`);
    } else {
      fail('CS4_stream_overflows_container', JSON.stringify(overflowState));
      throw new Error('chat container did not overflow');
    }

    const scrolledAway = await mainWindow.webContents.executeJavaScript(`
      (async () => {
        const container = document.querySelector('div.h-full.overflow-y-auto.p-3.space-y-3');
        if (!container) return { ok: false, step: 'find_container' };
        container.scrollTop = 0;
        container.dispatchEvent(new Event('scroll', { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 120));
        const button = document.querySelector('button[title="回到底部"]');
        return {
          ok: true,
          scrollTop: container.scrollTop,
          distanceFromBottom: container.scrollHeight - container.scrollTop - container.clientHeight,
          buttonVisible: !!button,
        };
      })()
    `);
    if (scrolledAway?.ok && scrolledAway.scrollTop === 0 && scrolledAway.buttonVisible) {
      pass('CS5_user_scroll_shows_jump_button', `distance=${scrolledAway.distanceFromBottom}`);
    } else {
      fail('CS5_user_scroll_shows_jump_button', JSON.stringify(scrolledAway));
    }

    await streamChunks(latestSessionId, 19, 8);
    const pausedFollow = await mainWindow.webContents.executeJavaScript(`
      (() => {
        const container = document.querySelector('div.h-full.overflow-y-auto.p-3.space-y-3');
        const button = document.querySelector('button[title="回到底部"]');
        if (!container) return { ok: false, step: 'find_container' };
        return {
          ok: true,
          scrollTop: container.scrollTop,
          distanceFromBottom: container.scrollHeight - container.scrollTop - container.clientHeight,
          buttonVisible: !!button,
        };
      })()
    `);
    if (pausedFollow?.ok && pausedFollow.scrollTop <= 20 && pausedFollow.buttonVisible && pausedFollow.distanceFromBottom > 120) {
      pass('CS6_streaming_does_not_steal_scroll', `distance=${pausedFollow.distanceFromBottom}`);
    } else {
      fail('CS6_streaming_does_not_steal_scroll', JSON.stringify(pausedFollow));
    }

    const returnedToBottom = await mainWindow.webContents.executeJavaScript(`
      (async () => {
        const container = document.querySelector('div.h-full.overflow-y-auto.p-3.space-y-3');
        const button = document.querySelector('button[title="回到底部"]');
        if (!container || !button) return { ok: false, step: 'find_button_or_container' };
        button.click();
        const startedAt = Date.now();
        while (Date.now() - startedAt < 1200) {
          const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
          const visibleButton = document.querySelector('button[title="回到底部"]');
          if (distanceFromBottom <= 48 && !visibleButton) {
            return { ok: true, scrollTop: container.scrollTop, distanceFromBottom };
          }
          await new Promise((resolve) => setTimeout(resolve, 40));
        }
        return {
          ok: false,
          scrollTop: container.scrollTop,
          distanceFromBottom: container.scrollHeight - container.scrollTop - container.clientHeight,
          buttonStillVisible: !!document.querySelector('button[title="回到底部"]'),
        };
      })()
    `);
    if (returnedToBottom?.ok) {
      pass('CS7_jump_button_returns_to_bottom', `distance=${returnedToBottom.distanceFromBottom}`);
    } else {
      fail('CS7_jump_button_returns_to_bottom', JSON.stringify(returnedToBottom));
    }

    await streamChunks(latestSessionId, 27, 8);
    const resumedFollow = await mainWindow.webContents.executeJavaScript(`
      (() => {
        const container = document.querySelector('div.h-full.overflow-y-auto.p-3.space-y-3');
        const button = document.querySelector('button[title="回到底部"]');
        if (!container) return { ok: false, step: 'find_container' };
        return {
          ok: true,
          scrollTop: container.scrollTop,
          distanceFromBottom: container.scrollHeight - container.scrollTop - container.clientHeight,
          buttonVisible: !!button,
        };
      })()
    `);
    if (resumedFollow?.ok && resumedFollow.distanceFromBottom <= 48 && !resumedFollow.buttonVisible) {
      pass('CS8_jump_button_restores_auto_follow', `distance=${resumedFollow.distanceFromBottom}`);
    } else {
      fail('CS8_jump_button_restores_auto_follow', JSON.stringify(resumedFollow));
    }

    fireChatEvent(latestSessionId, 'turn_done', { text: '滚动回归测试结束。' });
    await delay(120);
  } catch (err) {
    fail('CS9_harness', err.message || String(err));
  } finally {
    chatAgent.createSession = originalCreateSession;
  }

  console.log('');
  console.log(`TEST_SUMMARY ${results.passed}/${results.total} passed, ${results.failed} failed`);
  console.log('TEST_DONE');
  return results;
}

module.exports = { runChatScrollUiRegressionTest };
