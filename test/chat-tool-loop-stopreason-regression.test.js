'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');

async function runChatToolLoopStopReasonRegressionTest() {
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
  process.env.MANA_USER_DATA_ROOT = path.join(ROOT, 'tmp-test-chat-tool-loop-stopreason-userdata');
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
  const searchEngine = require(path.join(ROOT, 'src/main/import/searchEngine'));

  const originalGetActiveProvider = providerManager.getActiveProvider;
  const originalGetAlias = modelAliases.getAlias;
  const originalGetActiveDriverId = workflowOrchestrator.getActiveDriverId;
  const originalSendMessage = anthropicProvider.sendMessage;
  const originalListTools = mcpClient.listTools;
  const originalGetActiveNovel = mcpClient.getActiveNovel;
  const originalSearchWeb = searchEngine.searchWeb;

  let chatAgent = null;
  let sessionId = '';

  try {
    providerManager.getActiveProvider = async () => ({
      id: 'stopreason-regression-provider',
      name: 'stopreason-regression-provider',
      type: 'anthropic',
      apiKey: 'stopreason-regression-key',
      baseUrl: 'https://example.invalid/anthropic',
      models: [{ id: 'stopreason-regression-model' }],
    });
    modelAliases.getAlias = async () => ({
      id: 'sonnet',
      providerId: null,
      modelId: 'stopreason-regression-model',
      maxOutputTokens: 256,
      temperature: 0,
    });
    workflowOrchestrator.getActiveDriverId = () => 'direct-api';
    mcpClient.listTools = async () => ([]);
    mcpClient.getActiveNovel = () => 'novel-stopreason-regression';
    searchEngine.searchWeb = async ({ query }) => ({
      results: [],
      errors: [],
      sourceDetails: [{ source: 'stub', sourceLabel: 'Stub', query, count: 0 }],
    });

    let providerCallCount = 0;
    anthropicProvider.sendMessage = async () => {
      providerCallCount += 1;
      if (providerCallCount === 1) {
        return {
          stopReason: 'end_turn',
          content: [{
            type: 'tool_use',
            id: 'toolu-stopreason-1',
            name: 'WebSearch',
            input: { query: '碧蓝航线 信浓 设定' },
          }],
        };
      }
      return {
        stopReason: 'end_turn',
        content: [{ type: 'text', text: '搜索完成，继续执行。' }],
      };
    };

    const chatAgentPath = path.join(ROOT, 'src/main/runtime/chatAgent');
    delete require.cache[require.resolve(chatAgentPath)];
    chatAgent = require(chatAgentPath);
    sessionId = chatAgent.createSession({
      editorContext: {
        novelId: 'novel-stopreason-regression',
        type: 'chapter',
        title: 'chapter-001.md',
      },
      messages: [],
    });

    await chatAgent.runTurn(sessionId, '先搜一下信浓设定，再继续。');

    const session = chatAgent.getSession(sessionId);
    assert.equal(providerCallCount, 2);
    assert.equal(session.messages.length >= 4, true);
    assert.equal(session.messages[1]?.role, 'assistant');
    assert.equal(session.messages[1]?.content?.some((block) => block.type === 'tool_use' && block.id === 'toolu-stopreason-1'), true);
    assert.equal(session.messages[2]?.role, 'user');
    assert.equal(session.messages[2]?.content?.some((block) => block.type === 'tool_result' && block.tool_use_id === 'toolu-stopreason-1'), true);
    assert.equal(
      emittedEvents.some((event) => event.channel === 'chatAgent:event'
        && event.payload?.sessionId === sessionId
        && event.payload?.kind === 'tool_result'
        && event.payload?.data?.name === 'WebSearch'
        && event.payload?.data?.isError === false),
      true
    );
    pass(
      'CTLS1_chat_tool_loop_continues_when_stop_reason_is_wrong',
      'tool_use blocks still produce tool_result and a second provider turn when an Anthropic-compatible endpoint reports end_turn'
    );
  } catch (err) {
    fail('CTLS_harness', err?.stack || String(err));
  } finally {
    if (sessionId && chatAgent) {
      try { chatAgent.closeSession(sessionId); } catch { /* ignore */ }
    }
    providerManager.getActiveProvider = originalGetActiveProvider;
    modelAliases.getAlias = originalGetAlias;
    workflowOrchestrator.getActiveDriverId = originalGetActiveDriverId;
    anthropicProvider.sendMessage = originalSendMessage;
    mcpClient.listTools = originalListTools;
    mcpClient.getActiveNovel = originalGetActiveNovel;
    searchEngine.searchWeb = originalSearchWeb;
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

module.exports = { runChatToolLoopStopReasonRegressionTest };

if (require.main === module) {
  runChatToolLoopStopReasonRegressionTest().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}