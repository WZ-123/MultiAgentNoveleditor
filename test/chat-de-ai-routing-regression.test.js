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

  const originalGetActiveProvider = providerManager.getActiveProvider;
  const originalGetAlias = modelAliases.getAlias;
  const originalGetActiveDriverId = workflowOrchestrator.getActiveDriverId;
  const originalSendMessage = anthropicProvider.sendMessage;
  const originalCallTool = mcpClient.callTool;
  const originalListTools = mcpClient.listTools;
  const originalGetActiveNovel = mcpClient.getActiveNovel;

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
    providerManager.getActiveProvider = originalGetActiveProvider;
    modelAliases.getAlias = originalGetAlias;
    workflowOrchestrator.getActiveDriverId = originalGetActiveDriverId;
    anthropicProvider.sendMessage = originalSendMessage;
    mcpClient.callTool = originalCallTool;
    mcpClient.listTools = originalListTools;
    mcpClient.getActiveNovel = originalGetActiveNovel;
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