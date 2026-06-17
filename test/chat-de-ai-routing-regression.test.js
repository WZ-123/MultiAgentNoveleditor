'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');

async function runChatDeAiRoutingRegressionTest() {
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

  const ROOT = path.resolve(__dirname, '..');
  process.env.MANA_USER_DATA_ROOT = path.join(ROOT, 'tmp-test-chat-de-ai-routing-userdata');
  process.env.MANA_USE_STDIO_MCP = '0';

  const emittedEvents = [];
  const electronModulePath = require.resolve('electron');
  const originalElectronCache = require.cache[electronModulePath];
  require.cache[electronModulePath] = {
    id: electronModulePath,
    filename: electronModulePath,
    loaded: true,
    exports: {
      app: null,
      webContents: {
        getAllWebContents: () => [{
          send(channel, payload) {
            emittedEvents.push({ channel, payload });
          },
        }],
      },
    },
  };

  const providerManager = require(path.join(ROOT, 'src/main/providerManager'));
  const modelAliases = require(path.join(ROOT, 'src/main/modelAliases'));
  const workflowOrchestrator = require(path.join(ROOT, 'src/main/runtime/workflowOrchestrator'));
  const anthropicProvider = require(path.join(ROOT, 'src/main/runtime/providers/anthropic'));
  const mcpClient = require(path.join(ROOT, 'src/main/mcp/mcpClientStdio'));
  const driverRegistry = require(path.join(ROOT, 'src/main/runtime/drivers/registry'));
  const { getToolByName } = require(path.join(ROOT, 'src/main/mcp/tools'));

  const originalGetActiveProvider = providerManager.getActiveProvider;
  const originalGetAlias = modelAliases.getAlias;
  const originalGetActiveDriverId = workflowOrchestrator.getActiveDriverId;
  const originalSendMessage = anthropicProvider.sendMessage;
  const originalCallTool = mcpClient.callTool;
  const originalListTools = mcpClient.listTools;
  const originalGetActiveNovel = mcpClient.getActiveNovel;
  const originalRegistryGetActive = driverRegistry.getActive;

  let chatAgent = null;
  let sessionId = '';

  try {
    providerManager.getActiveProvider = async () => ({
      id: 'chat-de-ai-routing-provider',
      name: 'chat-de-ai-routing-provider',
      type: 'anthropic',
      apiKey: 'chat-de-ai-routing-key',
      baseUrl: 'https://example.invalid/anthropic',
      models: [{ id: 'chat-de-ai-routing-model' }],
    });
    modelAliases.getAlias = async () => ({
      id: 'sonnet',
      providerId: null,
      modelId: 'chat-de-ai-routing-model',
      maxOutputTokens: 256,
      temperature: 0,
    });
    workflowOrchestrator.getActiveDriverId = () => 'direct-api';

    let providerCallCount = 0;
    anthropicProvider.sendMessage = async () => {
      providerCallCount += 1;
      return { stopReason: 'end_turn', content: [{ type: 'text', text: 'provider should not run' }] };
    };

    const toolCalls = [];
    mcpClient.callTool = async ({ name, arguments: args }) => {
      toolCalls.push({ name, args });
      if (name === 'de_ai_ify') {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ revisedText: '她笑了一下，笑意很淡，像是把话先按回了心里。', subagentId: 'sa-de-ai-ifier' }),
          }],
        };
      }
      throw new Error(`unexpected tool call: ${name}`);
    };
    mcpClient.getActiveNovel = () => 'novel-de-ai-routing';

    const chatAgentPath = path.join(ROOT, 'src/main/runtime/chatAgent');
    delete require.cache[require.resolve(chatAgentPath)];
    chatAgent = require(chatAgentPath);
    sessionId = chatAgent.createSession({
      editorContext: {
        novelId: 'novel-de-ai-routing',
        type: 'chapter',
        title: 'chapter-001.md',
        selectedText: '然后她笑了。那是一个很淡的笑。',
      },
      messages: [],
    });

    const frontendResolves = [];
    const originalLength = emittedEvents.length;
    const monitor = setInterval(() => {
      for (let index = originalLength; index < emittedEvents.length; index += 1) {
        const event = emittedEvents[index];
        if (event.channel !== 'chatAgent:event') continue;
        if (event.payload?.sessionId !== sessionId) continue;
        if (event.payload?.kind !== 'frontend_action') continue;
        const actionId = event.payload?.data?.actionId;
        if (!actionId || frontendResolves.includes(actionId)) continue;
        frontendResolves.push(actionId);
        chatAgent.resolveFrontendAction(sessionId, actionId, { text: '选区替换成功', isError: false });
      }
    }, 10);

    try {
      await chatAgent.runTurn(sessionId, '把这句去AI味，润色得更像人写。');
    } finally {
      clearInterval(monitor);
    }

    const frontendAction = emittedEvents.find((event) => event.channel === 'chatAgent:event'
      && event.payload?.sessionId === sessionId
      && event.payload?.kind === 'frontend_action');
    const session = chatAgent.getSession(sessionId);
    const lastAssistantText = session?.messages?.[session.messages.length - 1]?.content?.[0]?.text || '';

    assert.equal(providerCallCount, 0);
    assert.equal(toolCalls.length, 1);
    assert.equal(toolCalls[0]?.name, 'de_ai_ify');
    assert.equal(toolCalls[0]?.args?.text, '然后她笑了。那是一个很淡的笑。');
    assert.match(toolCalls[0]?.args?.guidance || '', /去AI味|更像人写/u);
    assert.ok(frontendAction);
    assert.equal(frontendAction?.payload?.data?.name, 'replace_selected_text');
    assert.equal(frontendAction?.payload?.data?.input?.replacement, '她笑了一下，笑意很淡，像是把话先按回了心里。');
    assert.match(lastAssistantText, /已按你当前选中的内容去 AI 味改写/u);
    pass('CDR1_selected_de_ai_request_routes_to_tool_then_replace', 'selected-text de-ai requests bypass the provider and go through de_ai_ify + replace_selected_text');
  } catch (err) {
    fail('CDR1_selected_de_ai_request_routes_to_tool_then_replace', err?.message || String(err));
  } finally {
    if (sessionId && chatAgent) {
      try { chatAgent.closeSession(sessionId); } catch { /* ignore */ }
    }
  }

  try {
    let providerCallCount = 0;
    const toolCalls = [];
    anthropicProvider.sendMessage = async () => {
      providerCallCount += 1;
      return { stopReason: 'end_turn', content: [{ type: 'text', text: 'provider should not run for lowercase ai味 review' }] };
    };
    mcpClient.getActiveNovel = () => 'novel-de-ai-routing';
    mcpClient.callTool = async ({ name, arguments: args }) => {
      toolCalls.push({ name, args });
      if (name === 'list_chapters') {
        return {
          content: [{ type: 'text', text: JSON.stringify(['chapter-008.md']) }],
        };
      }
      if (name === 'list_chapter_displays') {
        return {
          content: [{ type: 'text', text: JSON.stringify([{ name: 'chapter-008.md', displayName: '第八章：测试章', seq: 8 }]) }],
        };
      }
      if (name === 'review_de_ai_style') {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              chapterCount: 1,
              totalAnnotations: 0,
              chapters: [{ chapterName: 'chapter-008.md', annotations: [] }],
            }),
          }],
        };
      }
      throw new Error(`unexpected tool call: ${name}`);
    };

    const chatAgentPath = path.join(ROOT, 'src/main/runtime/chatAgent');
    delete require.cache[require.resolve(chatAgentPath)];
    chatAgent = require(chatAgentPath);
    sessionId = chatAgent.createSession({
      editorContext: { novelId: 'novel-de-ai-routing', type: 'chapter', title: 'chapter-008.md', selectedText: '' },
      messages: [],
    });

    await chatAgent.runTurn(sessionId, '重新审查一下第八章的ai味');

    assert.equal(providerCallCount, 0);
    assert.deepEqual(toolCalls.map((call) => call.name), ['list_chapters', 'list_chapter_displays', 'review_de_ai_style']);
    assert.deepEqual(toolCalls[2]?.args?.chapterNames, ['chapter-008.md']);
    pass('CDR3c_lowercase_aiwei_routes_to_chapter_de_ai_review', 'lowercase ai味 review wording now bypasses provider and calls review_de_ai_style directly');
  } catch (err) {
    fail('CDR3c_lowercase_aiwei_routes_to_chapter_de_ai_review', err?.message || String(err));
  } finally {
    if (sessionId && chatAgent) {
      try { chatAgent.closeSession(sessionId); } catch { /* ignore */ }
    }
  }

  try {
    let capturedToolNames = [];
    anthropicProvider.sendMessage = async ({ tools }) => {
      capturedToolNames = (tools || []).map((tool) => tool.name);
      return { stopReason: 'end_turn', content: [{ type: 'text', text: 'idle tools ok' }] };
    };
    mcpClient.callTool = async (...args) => originalCallTool(...args);
    mcpClient.getActiveNovel = () => null;
    mcpClient.listTools = async () => ([
      { name: 'list_characters', description: 'List characters', inputSchema: { type: 'object', properties: {} } },
      { name: 'de_ai_ify', description: 'De-ai rewrite', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
      { name: 'list_skills', description: 'List skills', inputSchema: { type: 'object', properties: {} } },
      { name: 'read_skill_content', description: 'Read skill content', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
      { name: 'create_novel', description: 'Create novel', inputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] } },
      { name: 'list_novels', description: 'List novels', inputSchema: { type: 'object', properties: {} } },
    ]);

    const chatAgentPath = path.join(ROOT, 'src/main/runtime/chatAgent');
    delete require.cache[require.resolve(chatAgentPath)];
    chatAgent = require(chatAgentPath);
    sessionId = chatAgent.createSession({ editorContext: { type: 'none', title: '', selectedText: '' }, messages: [] });

    await chatAgent.runTurn(sessionId, '现在有哪些工具可用？');

    assert.ok(capturedToolNames.includes('de_ai_ify'));
    assert.ok(capturedToolNames.includes('list_skills'));
    assert.ok(capturedToolNames.includes('read_skill_content'));
    assert.ok(capturedToolNames.includes('create_novel'));
    assert.ok(capturedToolNames.includes('list_novels'));
    assert.equal(capturedToolNames.includes('list_characters'), false);
    pass('CDR2_idle_provider_path_still_exposes_de_ai_tooling', 'direct-api idle mode keeps de_ai_ify and explicit skill tools visible without leaking novel-only tools');
  } catch (err) {
    fail('CDR2_idle_provider_path_still_exposes_de_ai_tooling', err?.message || String(err));
  } finally {
    if (sessionId && chatAgent) {
      try { chatAgent.closeSession(sessionId); } catch { /* ignore */ }
    }
  }

  try {
    let providerCallCount = 0;
    const toolCalls = [];
    anthropicProvider.sendMessage = async () => {
      providerCallCount += 1;
      return { stopReason: 'end_turn', content: [{ type: 'text', text: 'provider should not run for multi-chapter de-ai review' }] };
    };
    mcpClient.getActiveNovel = () => 'novel-de-ai-routing';
    mcpClient.callTool = async ({ name, arguments: args }) => {
      toolCalls.push({ name, args });
      if (name === 'list_chapters') {
        return {
          content: [{ type: 'text', text: JSON.stringify(['chapter-001.md', 'chapter-002.md', 'chapter-003.md']) }],
        };
      }
      if (name === 'list_chapter_displays') {
        return {
          content: [{ type: 'text', text: JSON.stringify([
            { name: 'chapter-001.md', displayName: '第一章：测试一', seq: 1 },
            { name: 'chapter-002.md', displayName: '第二章：测试二', seq: 2 },
            { name: 'chapter-003.md', displayName: '第三章：测试三', seq: 3 },
          ]) }],
        };
      }
      if (name === 'review_de_ai_style') {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              chapterCount: 2,
              totalAnnotations: 1,
              chapters: [
                {
                  chapterName: 'chapter-001.md',
                  annotations: [{ paragraphIndex: 1, paragraphIndexes: [1], note: '独立短反应句和解释句拆段，AI 味重。', kind: 'choppy' }],
                },
                {
                  chapterName: 'chapter-002.md',
                  annotations: [],
                },
              ],
            }),
          }],
        };
      }
      throw new Error(`unexpected tool call: ${name}`);
    };

    const chatAgentPath = path.join(ROOT, 'src/main/runtime/chatAgent');
    delete require.cache[require.resolve(chatAgentPath)];
    chatAgent = require(chatAgentPath);
    sessionId = chatAgent.createSession({
      editorContext: { novelId: 'novel-de-ai-routing', type: 'chapter', title: 'chapter-003.md', selectedText: '' },
      messages: [],
    });

    await chatAgent.runTurn(sessionId, '并行审查第一章到第二章的 AI 味和套话，先给我审查结果，不要直接改正文。');

    const session = chatAgent.getSession(sessionId);
    const lastAssistantText = session?.messages?.[session.messages.length - 1]?.content?.[0]?.text || '';

    assert.equal(providerCallCount, 0);
    assert.deepEqual(toolCalls.map((call) => call.name), ['list_chapters', 'list_chapter_displays', 'review_de_ai_style']);
    assert.deepEqual(toolCalls[2]?.args?.chapterNames, ['chapter-001.md', 'chapter-002.md']);
    assert.match(lastAssistantText, /并行审查/u);
    assert.match(lastAssistantText, /chapter-001\.md：1 处/u);
    assert.match(lastAssistantText, /暂不自动改正文/u);
    pass('CDR3_multi_chapter_de_ai_review_bypasses_provider_and_uses_explicit_batch_tool', 'multi-chapter de-ai review requests bypass provider reasoning and go through list_chapters + review_de_ai_style');
  } catch (err) {
    fail('CDR3_multi_chapter_de_ai_review_bypasses_provider_and_uses_explicit_batch_tool', err?.message || String(err));
  } finally {
    if (sessionId && chatAgent) {
      try { chatAgent.closeSession(sessionId); } catch { /* ignore */ }
    }
  }

  try {
    let providerCallCount = 0;
    const toolCalls = [];
    anthropicProvider.sendMessage = async () => {
      providerCallCount += 1;
      return { stopReason: 'end_turn', content: [{ type: 'text', text: 'provider should not run for 2-6 wording' }] };
    };
    mcpClient.getActiveNovel = () => 'novel-de-ai-routing';
    mcpClient.callTool = async ({ name, arguments: args }) => {
      toolCalls.push({ name, args });
      if (name === 'list_chapters') {
        return {
          content: [{ type: 'text', text: JSON.stringify(['chapter-001.md', 'chapter-002.md', 'chapter-003.md', 'chapter-004.md', 'chapter-005.md', 'chapter-006.md']) }],
        };
      }
      if (name === 'list_chapter_displays') {
        return {
          content: [{ type: 'text', text: JSON.stringify([
            { name: 'chapter-001.md', displayName: '第一章：测试一', seq: 1 },
            { name: 'chapter-002.md', displayName: '第二章：测试二', seq: 2 },
            { name: 'chapter-003.md', displayName: '第三章：测试三', seq: 3 },
            { name: 'chapter-004.md', displayName: '第四章：测试四', seq: 4 },
            { name: 'chapter-005.md', displayName: '第五章：测试五', seq: 5 },
            { name: 'chapter-006.md', displayName: '第六章：测试六', seq: 6 },
          ]) }],
        };
      }
      if (name === 'review_de_ai_style') {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              chapterCount: 5,
              totalAnnotations: 1,
              chapters: [
                { chapterName: 'chapter-002.md', annotations: [] },
                { chapterName: 'chapter-003.md', annotations: [{ paragraphIndex: 1, paragraphIndexes: [1], note: '独立短反应句和解释句拆段，AI 味重。', kind: 'choppy' }] },
                { chapterName: 'chapter-004.md', annotations: [] },
                { chapterName: 'chapter-005.md', annotations: [] },
                { chapterName: 'chapter-006.md', annotations: [] },
              ],
            }),
          }],
        };
      }
      throw new Error(`unexpected tool call: ${name}`);
    };

    const chatAgentPath = path.join(ROOT, 'src/main/runtime/chatAgent');
    delete require.cache[require.resolve(chatAgentPath)];
    chatAgent = require(chatAgentPath);
    sessionId = chatAgent.createSession({
      editorContext: { novelId: 'novel-de-ai-routing', type: 'chapter', title: 'chapter-003.md', selectedText: '' },
      messages: [],
    });

    await chatAgent.runTurn(sessionId, '拿去ai味工具审查2-6章');

    const session = chatAgent.getSession(sessionId);
    const lastAssistantText = session?.messages?.[session.messages.length - 1]?.content?.[0]?.text || '';

    assert.equal(providerCallCount, 0);
    assert.deepEqual(toolCalls.map((call) => call.name), ['list_chapters', 'list_chapter_displays', 'review_de_ai_style']);
    assert.deepEqual(toolCalls[2]?.args?.chapterNames, ['chapter-002.md', 'chapter-003.md', 'chapter-004.md', 'chapter-005.md', 'chapter-006.md']);
    assert.match(lastAssistantText, /我已并行审查 5 章/u);
    assert.match(lastAssistantText, /chapter-003\.md：1 处/u);
    pass('CDR3b_bare_numeric_range_wording_routes_to_multi_chapter_de_ai_review', 'bare 2-6 wording now routes into review_de_ai_style without falling back to provider');
  } catch (err) {
    fail('CDR3b_bare_numeric_range_wording_routes_to_multi_chapter_de_ai_review', err?.message || String(err));
  } finally {
    if (sessionId && chatAgent) {
      try { chatAgent.closeSession(sessionId); } catch { /* ignore */ }
    }
  }

  try {
    let providerCallCount = 0;
    const toolCalls = [];
    anthropicProvider.sendMessage = async () => {
      providerCallCount += 1;
      if (providerCallCount === 1) {
        return {
          stopReason: 'tool_use',
          content: [{
            type: 'tool_use',
            id: 'toolu-de-ai-chat-1',
            name: 'de_ai_ify',
            input: {
              text: '然后她笑了。那是一个很淡的笑。',
              guidance: '保留冷淡感',
            },
          }],
        };
      }
      return {
        stopReason: 'end_turn',
        content: [{ type: 'text', text: '工具改写已完成。' }],
      };
    };
    driverRegistry.getActive = async () => ({
      id: 'test-driver',
      prepare: async (spec) => ({ runId: spec.runId, spec }),
      run: async () => ({ output: '她只淡淡笑了一下，像把原本要出口的话又按了回去。' }),
      dispose: async () => {},
      cancel: async () => {},
      capabilities: () => ({}),
      availability: async () => ({ available: true }),
    });
    mcpClient.getActiveNovel = () => 'novel-de-ai-routing';
    mcpClient.callTool = async ({ name, arguments: args }) => {
      toolCalls.push({ name, args });
      if (name !== 'de_ai_ify') throw new Error(`unexpected tool call: ${name}`);
      const tool = getToolByName('de_ai_ify');
      return tool.handler(args, {
        novel: { id: 'novel-de-ai-routing' },
        novelDir: '/tmp/novel-de-ai-routing',
      });
    };

    const chatAgentPath = path.join(ROOT, 'src/main/runtime/chatAgent');
    delete require.cache[require.resolve(chatAgentPath)];
    chatAgent = require(chatAgentPath);
    sessionId = chatAgent.createSession({
      editorContext: { novelId: 'novel-de-ai-routing', type: 'chapter', title: 'chapter-001.md', selectedText: '' },
      messages: [],
    });

    await chatAgent.runTurn(sessionId, '请直接调用去AI味工具改写这句。');

    const session = chatAgent.getSession(sessionId);
    const lastAssistantText = session?.messages?.[session.messages.length - 1]?.content?.[0]?.text || '';
    assert.equal(providerCallCount, 2);
    assert.deepEqual(toolCalls.map((call) => call.name), ['de_ai_ify']);
    assert.equal(toolCalls[0]?.args?.text, '然后她笑了。那是一个很淡的笑。');
    assert.equal(
      emittedEvents.some((event) => event.channel === 'chatAgent:event'
        && event.payload?.sessionId === sessionId
        && event.payload?.kind === 'tool_result'
        && event.payload?.data?.name === 'de_ai_ify'
        && event.payload?.data?.isError === false),
      true
    );
    assert.match(lastAssistantText, /工具改写已完成/u);
    assert.equal(/no driver registered/i.test(lastAssistantText), false);
    pass('CDR4_chat_provider_can_execute_de_ai_tool_without_driver_registration_failure', 'chat tool loop can execute de_ai_ify through the tool handler without surfacing no driver registered');
  } catch (err) {
    fail('CDR4_chat_provider_can_execute_de_ai_tool_without_driver_registration_failure', err?.message || String(err));
  } finally {
    if (sessionId && chatAgent) {
      try { chatAgent.closeSession(sessionId); } catch { /* ignore */ }
    }
  }

  try {
    let providerCallCount = 0;
    let readCount = 0;
    let applyCount = 0;
    const toolCalls = [];
    anthropicProvider.sendMessage = async () => {
      providerCallCount += 1;
      return { stopReason: 'end_turn', content: [{ type: 'text', text: 'provider should not run for pending de-ai apply' }] };
    };
    mcpClient.getActiveNovel = () => 'novel-de-ai-routing';
    mcpClient.callTool = async ({ name, arguments: args }) => {
      toolCalls.push({ name, args });
      if (name === 'list_chapters') {
        return {
          content: [{ type: 'text', text: JSON.stringify(['chapter-001.md']) }],
        };
      }
      if (name === 'list_chapter_displays') {
        return {
          content: [{ type: 'text', text: JSON.stringify([{ name: 'chapter-001.md', displayName: '第一章：测试一', seq: 1 }]) }],
        };
      }
      if (name === 'review_de_ai_style') {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              chapterCount: 1,
              totalAnnotations: 1,
              chapters: [{
                chapterName: 'chapter-001.md',
                annotations: [{
                  paragraphIndex: 1,
                  paragraphIndexes: [1],
                  note: '句式发虚，AI 味重。',
                  excerpt: '然后她笑了。那是一个很淡的笑。',
                }],
              }],
            }),
          }],
        };
      }
      if (name === 'read_chapter') {
        readCount += 1;
        const body = readCount === 1
          ? ['第一段。', '', '然后她笑了。那是一个很淡的笑。', '', '第三段。'].join('\n')
          : ['第一段。', '', '然后她笑了。那是一个很淡的笑。', '', '第三段。', '', '补入的新段落。'].join('\n');
        return { content: [{ type: 'text', text: body }] };
      }
      if (name === 'de_ai_ify') {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ revisedText: '她笑了一下，笑意很淡，像把话先按回了心里。' }),
          }],
        };
      }
      if (name === 'apply_chapter_patch') {
        applyCount += 1;
        if (applyCount === 1) {
          return {
            isError: true,
            content: [{ type: 'text', text: 'chapter snapshot mismatch: the chapter changed after it was read. Read the latest chapter again before applying this patch.' }],
          };
        }
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ ok: true, name: 'chapter-001.md', editCount: 1, replacedCount: 1 }),
          }],
        };
      }
      throw new Error(`unexpected tool call: ${name}`);
    };

    const chatAgentPath = path.join(ROOT, 'src/main/runtime/chatAgent');
    delete require.cache[require.resolve(chatAgentPath)];
    chatAgent = require(chatAgentPath);
    sessionId = chatAgent.createSession({
      editorContext: { novelId: 'novel-de-ai-routing', type: 'chapter', title: 'chapter-001.md', selectedText: '' },
      messages: [],
    });

    await chatAgent.runTurn(sessionId, '审查第一章的AI味，先不要直接改。');
    await chatAgent.runTurn(sessionId, '方案A');

    const session = chatAgent.getSession(sessionId);
    const lastAssistantText = session?.messages?.[session.messages.length - 1]?.content?.[0]?.text || '';

    assert.equal(providerCallCount, 0);
    assert.equal(readCount, 2);
    assert.equal(applyCount, 2);
    assert.deepEqual(toolCalls.map((call) => call.name), [
      'list_chapters',
      'list_chapter_displays',
      'review_de_ai_style',
      'read_chapter',
      'de_ai_ify',
      'apply_chapter_patch',
      'read_chapter',
      'de_ai_ify',
      'apply_chapter_patch',
    ]);
    assert.match(lastAssistantText, /已按上一次审查结果自动应用去 AI 味修改/u);
    assert.match(lastAssistantText, /chapter-001\.md：1 处/u);
    pass('CDR5_pending_de_ai_review_apply_retries_after_snapshot_mismatch', 'confirmed de-ai fixes re-read and retry apply_chapter_patch once after snapshot mismatch');
  } catch (err) {
    fail('CDR5_pending_de_ai_review_apply_retries_after_snapshot_mismatch', err?.message || String(err));
  } finally {
    if (sessionId && chatAgent) {
      try { chatAgent.closeSession(sessionId); } catch { /* ignore */ }
    }
    providerManager.getActiveProvider = originalGetActiveProvider;
    modelAliases.getAlias = originalGetAlias;
    workflowOrchestrator.getActiveDriverId = originalGetActiveDriverId;
    anthropicProvider.sendMessage = originalSendMessage;
    mcpClient.callTool = originalCallTool;
    mcpClient.listTools = originalListTools;
    mcpClient.getActiveNovel = originalGetActiveNovel;
    driverRegistry.getActive = originalRegistryGetActive;
    if (originalElectronCache) {
      require.cache[electronModulePath] = originalElectronCache;
    } else {
      delete require.cache[electronModulePath];
    }
  }

  try {
    let providerCallCount = 0;
    const toolCalls = [];
    require.cache[electronModulePath] = {
      id: electronModulePath,
      filename: electronModulePath,
      loaded: true,
      exports: {
        app: null,
        webContents: {
          getAllWebContents: () => [{
            send(channel, payload) {
              emittedEvents.push({ channel, payload });
            },
          }],
        },
      },
    };
    anthropicProvider.sendMessage = async () => {
      providerCallCount += 1;
      return { stopReason: 'end_turn', content: [{ type: 'text', text: 'provider should not run for paragraph-function followup' }] };
    };
    mcpClient.getActiveNovel = () => 'novel-de-ai-routing';
    mcpClient.callTool = async ({ name, arguments: args }) => {
      toolCalls.push({ name, args });
      if (name === 'list_chapters') {
        return { content: [{ type: 'text', text: JSON.stringify(['chapter-001.md']) }] };
      }
      if (name === 'list_chapter_displays') {
        return { content: [{ type: 'text', text: JSON.stringify([{ name: 'chapter-001.md', displayName: '第一章：测试一', seq: 1 }]) }] };
      }
      if (name === 'review_de_ai_style') {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              chapterCount: 1,
              totalAnnotations: 2,
              chapters: [{
                chapterName: 'chapter-001.md',
                annotations: [
                  {
                    paragraphIndex: 1,
                    paragraphIndexes: [1],
                    note: '句式发虚，AI 味重。',
                    kind: 'other',
                    excerpt: '然后她笑了。那是一个很淡的笑。',
                  },
                  {
                    paragraphIndex: 3,
                    paragraphIndexes: [3, 4, 5],
                    note: '段落功能审查：连续多个非对话单句段讲同一段叙事。',
                    kind: 'choppy',
                    suggestedAction: 'merge_paragraphs',
                    excerpt: '楼道里的灯坏了三天。',
                  },
                ],
              }],
            }),
          }],
        };
      }
      if (name === 'read_chapter') {
        return {
          content: [{
            type: 'text',
            text: ['第一段。', '', '然后她笑了。那是一个很淡的笑。', '', '楼道里的灯坏了三天。', '', '物业一直没有派人来修。', '', '住户们只能摸黑走过那段台阶。'].join('\n'),
          }],
        };
      }
      if (name === 'de_ai_ify') {
        return { content: [{ type: 'text', text: JSON.stringify({ revisedText: '她笑了一下，笑意很淡。' }) }] };
      }
      if (name === 'apply_chapter_patch') {
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, name: 'chapter-001.md', editCount: 1, replacedCount: 1 }) }] };
      }
      if (name === 'review_paragraph_function') {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              reviewedWith: 'sa-paragraph-function-reviewer',
              chapterCount: 1,
              totalAnnotations: 1,
              chapters: [{
                chapterName: 'chapter-001.md',
                annotations: [{
                  paragraphIndex: 3,
                  paragraphIndexes: [3, 4, 5],
                  severity: 'medium',
                  suggestedAction: 'merge_paragraphs',
                  note: '这三段都在说明同一处楼道环境，应合并为一个自然段。',
                }],
              }],
            }),
          }],
        };
      }
      throw new Error(`unexpected tool call: ${name}`);
    };

    const chatAgentPath = path.join(ROOT, 'src/main/runtime/chatAgent');
    delete require.cache[require.resolve(chatAgentPath)];
    chatAgent = require(chatAgentPath);
    sessionId = chatAgent.createSession({
      editorContext: { novelId: 'novel-de-ai-routing', type: 'chapter', title: 'chapter-001.md', selectedText: '' },
      messages: [],
    });

    await chatAgent.runTurn(sessionId, '审查第一章的AI味，先不要直接改。');
    await chatAgent.runTurn(sessionId, '方案A');

    const session = chatAgent.getSession(sessionId);
    const firstReviewText = session?.messages?.find((message) => {
      const text = message?.content?.[0]?.text || '';
      return /精简审查清单注意到/u.test(text);
    })?.content?.[0]?.text || '';
    const lastAssistantText = session?.messages?.[session.messages.length - 1]?.content?.[0]?.text || '';

    assert.equal(providerCallCount, 0);
    assert.match(firstReviewText, /一句话一段\/段落功能/u);
    assert.deepEqual(toolCalls.map((call) => call.name), [
      'list_chapters',
      'list_chapter_displays',
      'review_de_ai_style',
      'read_chapter',
      'de_ai_ify',
      'apply_chapter_patch',
      'review_paragraph_function',
    ]);
    assert.equal(toolCalls.filter((call) => call.name === 'de_ai_ify').length, 1);
    assert.deepEqual(toolCalls.find((call) => call.name === 'review_paragraph_function')?.args?.chapterNames, ['chapter-001.md']);
    assert.match(lastAssistantText, /普通 AI 味段落处理完毕后/u);
    assert.match(lastAssistantText, /段落功能复核完成/u);
    pass('CDR6_paragraph_function_risks_run_second_pass_after_de_ai_apply', 'paragraph-function findings are announced, skipped by de_ai_ify, then reviewed by the dedicated subagent after normal de-ai fixes');
  } catch (err) {
    fail('CDR6_paragraph_function_risks_run_second_pass_after_de_ai_apply', err?.message || String(err));
  } finally {
    if (sessionId && chatAgent) {
      try { chatAgent.closeSession(sessionId); } catch { /* ignore */ }
    }
    providerManager.getActiveProvider = originalGetActiveProvider;
    modelAliases.getAlias = originalGetAlias;
    workflowOrchestrator.getActiveDriverId = originalGetActiveDriverId;
    anthropicProvider.sendMessage = originalSendMessage;
    mcpClient.callTool = originalCallTool;
    mcpClient.listTools = originalListTools;
    mcpClient.getActiveNovel = originalGetActiveNovel;
    driverRegistry.getActive = originalRegistryGetActive;
    if (originalElectronCache) {
      require.cache[electronModulePath] = originalElectronCache;
    } else {
      delete require.cache[electronModulePath];
    }
  }

  console.log('');
  console.log(`TEST_SUMMARY ${results.passed}/${results.total} passed, ${results.failed} failed`);
  console.log('TEST_DONE');
  return results;
}

module.exports = { runChatDeAiRoutingRegressionTest };

if (require.main === module) {
  runChatDeAiRoutingRegressionTest().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
