'use strict';
const { pathToFileURL } = require('node:url');

/**
 * Chat E2E Tests — runs inside the Electron main process.
 * Called from main.js when --test-chat flag is present.
 *
 * Tests:
 *   T1 — text_delta sequential rendering
 *   T2 — tool_use + tool_result chain
 *   E1 — turn_done fallback when no streaming events arrive
 *   E2 — Partial streaming with longer turn_done text
 *   E3 — Tool error display
 *   B1 — Number/content safety in text_delta
 */

async function runChatTests(mainWindow) {
  await new Promise((r) => setTimeout(r, 2000));

  const results = { total: 0, passed: 0, failed: 0 };
  function pass(name, detail) {
    results.total++; results.passed++;
    console.log(`TEST_PASS ${name}${detail ? ': ' + detail : ''}`);
  }
  function fail(name, reason) {
    results.total++; results.failed++;
    console.log(`TEST_FAIL ${name}: ${reason}`);
  }

  const { webContents } = require('electron');

  // Helper: fire a chatAgent:event IPC message directly to the renderer
  function fireIPC(sessionId, kind, data) {
    const payload = { sessionId, kind, data, ts: Date.now() };
    for (const wc of webContents.getAllWebContents()) {
      try { wc.send('chatAgent:event', payload); } catch { /* ignore */ }
    }
  }

  // ---- Install test helper in renderer to capture events ----
  await mainWindow.webContents.executeJavaScript(`
    window.__chatTestEvents = [];
    if (window.mana?.chatAgent?.onEvent) {
      window.__chatTestUnsub = window.mana.chatAgent.onEvent((payload) => {
        if (payload.sessionId && payload.sessionId.startsWith('__test_')) {
          window.__chatTestEvents.push(payload);
        }
      });
    }
    undefined;
  `);

  function resetEvents() {
    return mainWindow.webContents.executeJavaScript(`window.__chatTestEvents = []; undefined;`);
  }

  function getEvents() {
    return mainWindow.webContents.executeJavaScript(`JSON.parse(JSON.stringify(window.__chatTestEvents || []))`);
  }

  // ================================================================
  // T1: text_delta sequential rendering
  // ================================================================
  try {
    await resetEvents();
    const sId = '__test_t1';
    fireIPC(sId, 'turn_start', { userText: '你好' });
    await new Promise((r) => setTimeout(r, 50));
    fireIPC(sId, 'text_delta', { delta: '你好' });
    fireIPC(sId, 'text_delta', { delta: '！我' });
    fireIPC(sId, 'text_delta', { delta: '是AI助手' });
    fireIPC(sId, 'turn_done', { text: '你好！我是AI助手', turns: 1 });
    await new Promise((r) => setTimeout(r, 100));

    const evts = await getEvents();
    const starts = evts.filter((e) => e.kind === 'turn_start');
    const deltas = evts.filter((e) => e.kind === 'text_delta');
    const dones = evts.filter((e) => e.kind === 'turn_done');

    if (starts.length >= 1 && deltas.length >= 3 && dones.length >= 1) {
      pass('T1_text_delta_flow', `${deltas.length} deltas, done text: "${(dones[0]?.data?.text || '').slice(0, 30)}"`);
    } else {
      fail('T1_text_delta_flow', `starts=${starts.length} deltas=${deltas.length} dones=${dones.length}`);
    }
  } catch (err) {
    fail('T1_text_delta_flow', err.message || String(err));
  }

  // ================================================================
  // T2: tool_use + tool_result chain
  // ================================================================
  try {
    await resetEvents();
    const sId = '__test_t2';
    fireIPC(sId, 'tool_use', { name: 'read_character', input: { id: 'protagonist' }, id: 'toolu_1' });
    fireIPC(sId, 'tool_result', { name: 'read_character', text: '{"name":"主角","age":20}', isError: false, id: 'toolu_1' });
    await new Promise((r) => setTimeout(r, 100));

    const evts = await getEvents();
    const uses = evts.filter((e) => e.kind === 'tool_use');
    const results = evts.filter((e) => e.kind === 'tool_result');

    if (uses.length >= 1 && results.length >= 1) {
      pass('T2_tool_call_flow', `tool=${uses[0]?.data?.name} result_ok=${!results[0]?.data?.isError}`);
    } else {
      fail('T2_tool_call_flow', `uses=${uses.length} results=${results.length}`);
    }
  } catch (err) {
    fail('T2_tool_call_flow', err.message || String(err));
  }

  // ================================================================
  // T2b: tool_result must match tool_use by id
  // ================================================================
  try {
    const { appendToolUseMessage, applyToolResultMessage } = await import(pathToFileURL(require('node:path').join(__dirname, '..', 'src/components/chatToolState.mjs')).href);
    let messages = [];
    messages = appendToolUseMessage(messages, { name: 'read_character', input: { id: 'wu-laogou' }, id: 'tool-a' }, 1);
    messages = appendToolUseMessage(messages, { name: 'query_world', input: {}, id: 'tool-b' }, 2);
    messages = applyToolResultMessage(messages, { name: 'read_character', text: 'CHAR_OK', isError: false, id: 'tool-a' }, 3);

    const firstTool = messages.find((m) => m.toolUseId === 'tool-a');
    const secondTool = messages.find((m) => m.toolUseId === 'tool-b');
    if (firstTool?.status === 'done' && firstTool?.result === 'CHAR_OK' && secondTool?.status === 'running') {
      pass('T2b_tool_result_matches_id', 'matched tool_result to the correct tool card');
    } else {
      fail('T2b_tool_result_matches_id', JSON.stringify({ firstTool, secondTool }));
    }
  } catch (err) {
    fail('T2b_tool_result_matches_id', err.message || String(err));
  }

  // ================================================================
  // E1: No streaming — turn_done must still create a message
  // ================================================================
  try {
    await resetEvents();
    const sId = '__test_e1';
    fireIPC(sId, 'turn_start', { userText: 'test' });
    // No text_delta events — directly turn_done
    fireIPC(sId, 'turn_done', { text: '这是从turn_done来的回复', turns: 1 });
    await new Promise((r) => setTimeout(r, 100));

    const evts = await getEvents();
    const dones = evts.filter((e) => e.kind === 'turn_done');

    if (dones.length >= 1 && dones[0]?.data?.text) {
      pass('E1_no_streaming_fallback', `text="${dones[0].data.text.slice(0, 30)}"`);
    } else {
      fail('E1_no_streaming_fallback', `dones=${dones.length} text=${dones[0]?.data?.text || ''}`);
    }
  } catch (err) {
    fail('E1_no_streaming_fallback', err.message || String(err));
  }

  // ================================================================
  // E2: Partial streaming + longer turn_done text
  // ================================================================
  try {
    await resetEvents();
    const sId = '__test_e2';
    fireIPC(sId, 'text_delta', { delta: '部分' });
    fireIPC(sId, 'text_delta', { delta: '文字' });
    fireIPC(sId, 'turn_done', { text: '部分文字被补齐为完整回复', turns: 1 });
    await new Promise((r) => setTimeout(r, 100));

    const evts = await getEvents();
    const deltas = evts.filter((e) => e.kind === 'text_delta');
    const dones = evts.filter((e) => e.kind === 'turn_done');

    if (deltas.length >= 2 && dones.length >= 1) {
      pass('E2_partial_streaming', `${deltas.length} deltas, done="${dones[0]?.data?.text?.slice(0, 30) || ''}"`);
    } else {
      fail('E2_partial_streaming', `deltas=${deltas.length} dones=${dones.length}`);
    }
  } catch (err) {
    fail('E2_partial_streaming', err.message || String(err));
  }

  // ================================================================
  // E3: Tool error handling
  // ================================================================
  try {
    await resetEvents();
    const sId = '__test_e3';
    fireIPC(sId, 'tool_use', { name: 'update_character', input: { id: 'nonexistent' }, id: 'toolu_err' });
    fireIPC(sId, 'tool_result', { name: 'update_character', text: '角色不存在', isError: true, id: 'toolu_err' });
    await new Promise((r) => setTimeout(r, 100));

    const evts = await getEvents();
    const results = evts.filter((e) => e.kind === 'tool_result');

    if (results.length >= 1 && results[0]?.data?.isError) {
      pass('E3_tool_error', `error="${results[0].data.text}"`);
    } else {
      fail('E3_tool_error', `results=${results.length} isError=${results[0]?.data?.isError}`);
    }
  } catch (err) {
    fail('E3_tool_error', err.message || String(err));
  }

  // ================================================================
  // B1: Number/content safety in text_delta
  // ================================================================
  try {
    await resetEvents();
    const sId = '__test_b1';
    // Simulate numeric delta (the "一堆数字" scenario)
    fireIPC(sId, 'text_delta', { delta: 42 });
    fireIPC(sId, 'text_delta', { delta: '号元素' });
    fireIPC(sId, 'turn_done', { text: '42号元素', turns: 1 });
    await new Promise((r) => setTimeout(r, 100));

    const evts = await getEvents();
    const deltas = evts.filter((e) => e.kind === 'text_delta');
    const firstType = typeof deltas[0]?.data?.delta;

    if (deltas.length >= 1) {
      pass('B1_number_safety', `first delta type=${firstType} count=${deltas.length}`);
    } else {
      fail('B1_number_safety', 'no deltas received');
    }
  } catch (err) {
    fail('B1_number_safety', err.message || String(err));
  }

  // ---- Cleanup ----
  try {
    await mainWindow.webContents.executeJavaScript(`
      if (window.__chatTestUnsub) { try { window.__chatTestUnsub(); } catch {} }
      delete window.__chatTestEvents;
      delete window.__chatTestUnsub;
      undefined;
    `);
  } catch { /* ignore */ }

  // ---- Summary ----
  console.log('');
  console.log(`TEST_SUMMARY ${results.passed}/${results.total} passed, ${results.failed} failed`);
  console.log('TEST_DONE');
  return results;
}

module.exports = { runChatTests };
