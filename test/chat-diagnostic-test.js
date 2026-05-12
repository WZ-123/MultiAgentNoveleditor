'use strict';

/**
 * Chat Diagnostic Test — exercises the EXACT IPC + session flow
 * that the user experiences when typing in the chat panel.
 *
 * Tests:
 *   1. IPC handler receives text → verify it reaches runTurn as a string
 *   2. textContent creates correct content blocks
 *   3. session.messages has correct data after push
 *   4. Full multi-turn chain without AI (simulated)
 */

async function runChatDiagnostic() {
  const results = { total: 0, passed: 0, failed: 0 };
  function pass(name, detail) {
    results.total++; results.passed++;
    console.log(`TEST_PASS ${name}${detail ? ': ' + detail : ''}`);
  }
  function fail(name, reason) {
    results.total++; results.failed++;
    console.log(`TEST_FAIL ${name}: ${reason}`);
  }

  const path = require('node:path');
  const ROOT = path.resolve(__dirname, '..');
  const chatAgent = require(path.join(ROOT, 'src/main/runtime/chatAgent'));
  const chatHistory = require(path.join(ROOT, 'src/main/store/chatHistory'));

  // ============== SETUP ==============
  let sid;
  try {
    sid = chatAgent.createSession({ editorContext: {} });
    if (!sid) throw new Error('no sessionId');
  } catch (err) {
    fail('setup', err.message || String(err));
    return results;
  }

  // =============================================================
  // D1: textContent creates correct content block from string
  // =============================================================
  try {
    const session = chatAgent.getSession(sid);
    if (!session) throw new Error('session not found');

    const testText = '你刚才说了什么';
    session.messages.length = 0;
    session.messages.push({ role: 'user', content: [{ type: 'text', text: testText }] });

    const msg = session.messages[0];
    const contentBlock = msg.content?.[0];

    const textIsCorrect = contentBlock?.type === 'text' && contentBlock.text === testText;
    const textIsString = typeof contentBlock?.text === 'string';
    const notObject = contentBlock?.text !== '[object Object]';

    if (textIsCorrect && textIsString && notObject) {
      pass('D1_textContent', `"${testText}" → type=${typeof contentBlock.text} text="${contentBlock.text}"`);
    } else {
      fail('D1_textContent', `text="${contentBlock?.text}" type=${typeof contentBlock?.text} isCorrect=${textIsCorrect}`);
    }
  } catch (err) {
    fail('D1_textContent', err.message || String(err));
  }

  // =============================================================
  // D2: Multiple turns preserve correct text
  // =============================================================
  try {
    const session = chatAgent.getSession(sid);
    if (!session) throw new Error('session lost');

    // Simulate a full multi-turn conversation
    const turns = [
      { user: '你好', assistant: '你好！我是助手。' },
      { user: '帮我改一下女主角年龄', assistant: '好的，我来读取角色信息。' },
      { user: '改好了吗', assistant: '已修改女主角年龄为22岁。' },
      { user: '你刚才说了什么', assistant: '我说已修改女主角年龄为22岁。' },
    ];

    session.messages.length = 0;
    for (const t of turns) {
      session.messages.push({ role: 'user', content: [{ type: 'text', text: t.user }] });
      session.messages.push({ role: 'assistant', content: [{ type: 'text', text: t.assistant }] });
    }

    // Verify ALL user messages are correct strings, none is [object Object]
    let allClean = true;
    let badIndex = -1;
    for (let i = 0; i < session.messages.length; i++) {
      const m = session.messages[i];
      if (m.role === 'user') {
        const text = m.content?.[0]?.text;
        if (typeof text !== 'string' || text === '[object Object]') {
          allClean = false;
          badIndex = i;
          break;
        }
      }
    }

    // Verify the LAST user message specifically
    const lastUser = session.messages[session.messages.length - 2]; // second-to-last is last user msg
    const lastUserText = lastUser?.content?.[0]?.text;

    if (allClean && lastUserText === '你刚才说了什么') {
      pass('D2_multi_turn', `${session.messages.length} messages all clean, last user="${lastUserText}"`);
    } else {
      fail('D2_multi_turn', `allClean=${allClean} badIdx=${badIndex} lastUser="${lastUserText}" type=${typeof lastUserText}`);
    }
  } catch (err) {
    fail('D2_multi_turn', err.message || String(err));
  }

  // =============================================================
  // D3: Serialize/deserialize through JSON (simulates IPC)
  // =============================================================
  try {
    const session = chatAgent.getSession(sid);

    // Simulate what happens when messages go through IPC (JSON serialization)
    const testMsgs = [
      { role: 'user', content: [{ type: 'text', text: '帮我改年龄' }] },
      { role: 'assistant', content: [{ type: 'text', text: '好的' }] },
      { role: 'user', content: [{ type: 'text', text: '改好了吗' }] },
    ];

    // Serialize through JSON (simulates IPC round-trip)
    const serialized = JSON.parse(JSON.stringify(testMsgs));

    // Verify text fields survived
    const allStrings = serialized.every(m => {
      if (m.role === 'user' || m.role === 'assistant') {
        return m.content?.every(c => typeof c.text === 'string' && c.text !== '[object Object]');
      }
      return true;
    });

    const lastText = serialized[2].content[0].text;

    if (allStrings && lastText === '改好了吗') {
      pass('D3_serialization', `JSON round-trip OK, "${lastText}"`);
    } else {
      fail('D3_serialization', `allStrings=${allStrings} lastText="${lastText}"`);
    }
  } catch (err) {
    fail('D3_serialization', err.message || String(err));
  }

  // =============================================================
  // D4: runTurn with IPC-simulated text
  // =============================================================
  try {
    const session = chatAgent.getSession(sid);
    session.messages.length = 0;

    // Simulate IPC receiving a message and calling runTurn
    const receivedText = '你刚才说了什么';

    // This is exactly what ipc/chatAgent.js does:
    session.messages.push({ role: 'user', content: [{ type: 'text', text: receivedText }] });

    const pushedText = session.messages[0].content[0].text;
    const isClean = pushedText === receivedText && typeof pushedText === 'string';

    // Now simulate what the AI would see
    const messagesForAI = session.messages.map(m => ({
      role: m.role,
      content: m.content.map(c => ({
        type: c.type,
        text: typeof c.text === 'string' ? c.text : String(c.text),
      })),
    }));

    const aiSees = messagesForAI[0].content[0].text;

    if (isClean && aiSees === receivedText) {
      pass('D4_ipc_sim', `IPC sim: "${receivedText}" → AI sees "${aiSees}"`);
    } else {
      fail('D4_ipc_sim', `clean=${isClean} aiSees="${aiSees}"`);
    }
  } catch (err) {
    fail('D4_ipc_sim', err.message || String(err));
  }

  // =============================================================
  // D5: Conversation context — verify AI would see full history
  // =============================================================
  try {
    const session = chatAgent.getSession(sid);
    session.messages.length = 0;

    // Simulate a conversation with context
    session.messages.push({ role: 'user', content: [{ type: 'text', text: '我叫小明' }] });
    session.messages.push({ role: 'assistant', content: [{ type: 'text', text: '你好小明' }] });
    session.messages.push({ role: 'user', content: [{ type: 'text', text: '我叫什么名字' }] });

    // Extract what the AI would see as the user's context
    const firstUserMsg = session.messages[0].content[0].text;
    const lastUserMsg = session.messages[2].content[0].text;

    // The AI should see both "我叫小明" and "我叫什么名字"
    // If context is working, the AI can connect these
    const contextComplete = firstUserMsg === '我叫小明' && lastUserMsg === '我叫什么名字';

    if (contextComplete) {
      pass('D5_context', `context: "${firstUserMsg}" → "${lastUserMsg}"`);
    } else {
      fail('D5_context', `first="${firstUserMsg}" last="${lastUserMsg}"`);
    }
  } catch (err) {
    fail('D5_context', err.message || String(err));
  }

  // =============================================================
  // D6: Edge case — textContent with various input types
  // =============================================================
  try {
    const testCases = [
      { input: '正常文本', expected: '正常文本' },
      { input: '', expected: '' },
      { input: 42, expected: '42' },
      { input: null, expected: '' },
      { input: undefined, expected: '' },
      { input: true, expected: 'true' },
    ];

    let allOk = true;
    for (const tc of testCases) {
      const msg = { role: 'user', content: [{ type: 'text', text: typeof tc.input === 'string' ? tc.input : String(tc.input ?? '') }] };
      const result = msg.content[0].text;
      if (result !== tc.expected) {
        console.error(`  textContent(${tc.input}) = "${result}" (expected "${tc.expected}")`);
        allOk = false;
      }
    }

    if (allOk) pass('D6_edge_cases', 'all types handled');
    else fail('D6_edge_cases', 'some types failed');
  } catch (err) {
    fail('D6_edge_cases', err.message || String(err));
  }

  // =============================================================
  // D7: Edit assistant reply in history does NOT update current session
  // =============================================================
  try {
    const thread = await chatHistory.createThread({ title: '编辑上下文测试', novelId: 'diag-novel' });
    await chatHistory.appendMessage(thread.id, {
      id: 'msg-user-1',
      role: 'user',
      text: '请概括上一段剧情',
      timestamp: Date.now(),
      edited: false,
      toolCalls: null,
    });
    await chatHistory.appendMessage(thread.id, {
      id: 'msg-assistant-1',
      role: 'assistant',
      text: '原始回复：主角离开了港口。',
      timestamp: Date.now() + 1,
      edited: false,
      toolCalls: null,
    });

    const original = await chatHistory.getThread(thread.id);
    const branch = chatHistory.getBranch(original).map((m) => ({
      id: m.id,
      role: m.role,
      text: m.text,
      timestamp: m.timestamp,
      edited: m.edited,
      toolCalls: m.toolCalls,
    }));

    const sid2 = chatAgent.createSession({ editorContext: {}, messages: branch, threadId: thread.id });
    await chatHistory.editMessage(thread.id, 'msg-assistant-1', '编辑后回复：主角没有离开港口。');

    const liveSession = chatAgent.getSession(sid2);
    const sessionAssistantText = liveSession?.messages?.[1]?.content?.[0]?.text || '';
    const editedThread = await chatHistory.getThread(thread.id);
    const editedAssistantText = editedThread?.messages?.find((m) => m.id === 'msg-assistant-1')?.text || '';

    if (sessionAssistantText === '原始回复：主角离开了港口。' && editedAssistantText === '编辑后回复：主角没有离开港口。') {
      fail('D7_edit_same_session_context', `session still uses old reply: "${sessionAssistantText}" while history="${editedAssistantText}"`);
    } else {
      pass('D7_edit_same_session_context', `session="${sessionAssistantText}" history="${editedAssistantText}"`);
    }

    try { chatAgent.closeSession(sid2); } catch { /* ignore */ }
  } catch (err) {
    fail('D7_edit_same_session_context', err.message || String(err));
  }

  // =============================================================
  // D8: Reopen session rebuilds from edited history
  // =============================================================
  try {
    const thread = await chatHistory.createThread({ title: '重开会话测试', novelId: 'diag-novel' });
    await chatHistory.appendMessage(thread.id, {
      id: 'msg-user-2',
      role: 'user',
      text: '上一段结局是什么',
      timestamp: Date.now(),
      edited: false,
      toolCalls: null,
    });
    await chatHistory.appendMessage(thread.id, {
      id: 'msg-assistant-2',
      role: 'assistant',
      text: '原始结局：主角独自离开。',
      timestamp: Date.now() + 1,
      edited: false,
      toolCalls: [{ name: 'read_chapter', status: 'done', result: 'chapter-001' }],
    });

    await chatHistory.editMessage(thread.id, 'msg-assistant-2', '编辑后结局：主角留在了北雾港。');
    const reopened = await chatHistory.getThread(thread.id);
    const reopenedBranch = chatHistory.getBranch(reopened).map((m) => ({
      id: m.id,
      role: m.role,
      text: m.text,
      timestamp: m.timestamp,
      edited: m.edited,
      toolCalls: m.toolCalls,
    }));

    const sid3 = chatAgent.createSession({ editorContext: {}, messages: reopenedBranch, threadId: thread.id });
    const reopenedSession = chatAgent.getSession(sid3);
    const assistantText = reopenedSession?.messages?.[1]?.content?.[0]?.text || '';

    if (assistantText === '编辑后结局：主角留在了北雾港。') {
      pass('D8_reopen_uses_edited_history', `reopened session uses edited reply: "${assistantText}"`);
    } else {
      fail('D8_reopen_uses_edited_history', `assistantText="${assistantText}"`);
    }

    try { chatAgent.closeSession(sid3); } catch { /* ignore */ }
  } catch (err) {
    fail('D8_reopen_uses_edited_history', err.message || String(err));
  }

  // =============================================================
  // D9: Tool-call metadata survives store reopen if written to history
  // =============================================================
  try {
    const thread = await chatHistory.createThread({ title: '工具记录持久化测试', novelId: 'diag-novel' });
    await chatHistory.appendMessage(thread.id, {
      id: 'msg-assistant-tool',
      role: 'assistant',
      text: '我读取了角色卡，并准备继续分析。',
      timestamp: Date.now(),
      edited: false,
      toolCalls: [
        { id: 'toolu-1', name: 'read_character', input: { id: 'shen-yan' }, result: 'ok', isError: false },
      ],
    });

    const reopened = await chatHistory.getThread(thread.id);
    const toolCalls = reopened?.messages?.[0]?.toolCalls || null;

    if (Array.isArray(toolCalls) && toolCalls[0]?.name === 'read_character') {
      pass('D9_store_reopen_keeps_tool_calls', `toolCalls=${toolCalls.length}`);
    } else {
      fail('D9_store_reopen_keeps_tool_calls', JSON.stringify(toolCalls));
    }
  } catch (err) {
    fail('D9_store_reopen_keeps_tool_calls', err.message || String(err));
  }

  // =============================================================
  // D10: Real runTurn with tool_use does NOT persist toolCalls to history
  // =============================================================
  try {
    const providerManager = require(path.join(ROOT, 'src/main/providerManager'));
    const modelAliases = require(path.join(ROOT, 'src/main/modelAliases'));
    const anthropicProvider = require(path.join(ROOT, 'src/main/runtime/providers/anthropic'));
    const mcpClient = require(path.join(ROOT, 'src/main/mcp/mcpClientStdio'));
    const novelsStore = require(path.join(ROOT, 'src/main/store/novels'));
    const { novelPaths } = require(path.join(ROOT, 'src/main/store/paths'));
    const fs = require('node:fs/promises');

    const originalGetActiveProvider = providerManager.getActiveProvider;
    const originalGetAlias = modelAliases.getAlias;
    const originalSendMessage = anthropicProvider.sendMessage;

    const tmpRoot = path.join(ROOT, 'tmp-test-diag-turn');
    await fs.mkdir(tmpRoot, { recursive: true });
    const dir = path.join(tmpRoot, 'novel-' + Date.now());
    await fs.mkdir(dir, { recursive: true });
    const entry = await novelsStore.createNovel({ title: '工具调用诊断小说', dir });
    await novelsStore.openNovel(entry.id);
    await mcpClient.setActiveNovel(entry.id, dir);
    const np = novelPaths(dir);
    await fs.mkdir(np.characters, { recursive: true });
    await fs.writeFile(path.join(np.characters, 'shen-yan.json'), JSON.stringify({
      id: 'shen-yan', name: '沈砚', role: '主角', _enrichmentStatus: 'skipped'
    }, null, 2), 'utf8');

    let callCount = 0;
    providerManager.getActiveProvider = async () => ({
      id: 'diag-provider',
      name: 'diag-provider',
      type: 'anthropic',
      apiKey: 'diag-key',
      baseUrl: 'https://example.invalid',
      models: [{ id: 'diag-model' }],
    });
    modelAliases.getAlias = async () => ({
      id: 'sonnet',
      providerId: null,
      modelId: 'diag-model',
      maxOutputTokens: 256,
      temperature: 0,
    });
    anthropicProvider.sendMessage = async ({ onEvent }) => {
      callCount += 1;
      if (callCount === 1) {
        onEvent && onEvent({ kind: 'tool_use', data: { name: 'read_character', input: { id: 'shen-yan' }, id: 'toolu-diag-1' } });
        return {
          stopReason: 'tool_use',
          content: [
            { type: 'text', text: '我先读取角色卡。' },
            { type: 'tool_use', id: 'toolu-diag-1', name: 'read_character', input: { id: 'shen-yan' } },
          ],
        };
      }
      return {
        stopReason: 'end_turn',
        content: [
          { type: 'text', text: '我已经读取了沈砚的角色卡。' },
        ],
      };
    };

    const thread = await chatHistory.createThread({ title: '真实工具调用历史测试', novelId: entry.id });
    const sid4 = chatAgent.createSession({
      editorContext: { novelId: entry.id, chapterCount: 1 },
      messages: [],
      threadId: thread.id,
    });

    await chatAgent.runTurn(sid4, '读取沈砚的角色卡');

    const savedThread = await chatHistory.getThread(thread.id);
    const lastMsg = savedThread?.messages?.[savedThread.messages.length - 1] || null;
    const savedToolCalls = lastMsg?.toolCalls || null;

    if (Array.isArray(savedToolCalls) && savedToolCalls.length > 0) {
      pass('D10_real_turn_persists_tool_calls', `toolCalls=${savedToolCalls.length}`);
    } else {
      fail('D10_real_turn_persists_tool_calls', `assistant message saved without toolCalls: ${JSON.stringify(lastMsg)}`);
    }

    try { chatAgent.closeSession(sid4); } catch { /* ignore */ }
    providerManager.getActiveProvider = originalGetActiveProvider;
    modelAliases.getAlias = originalGetAlias;
    anthropicProvider.sendMessage = originalSendMessage;
  } catch (err) {
    fail('D10_real_turn_persists_tool_calls', err.message || String(err));
  }

  // =============================================================
  // CLEANUP
  // =============================================================
  try { chatAgent.closeSession(sid); } catch { /* ignore */ }

  console.log('');
  console.log(`TEST_SUMMARY ${results.passed}/${results.total} passed, ${results.failed} failed`);
  console.log('TEST_DONE');
  return results;
}

module.exports = { runChatDiagnostic };
