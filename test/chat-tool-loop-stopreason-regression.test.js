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
    const longSearchText = `CHAT_LONG_HEAD_${'y'.repeat(15000)}_CHAT_LONG_TAIL`;
    const providerMessagesByTurn = [];
    let webSearchCallCount = 0;
    searchEngine.searchWeb = async ({ query }) => {
      webSearchCallCount += 1;
      return {
        results: [],
        errors: [],
        sourceDetails: [{ source: 'stub', sourceLabel: 'Stub', query, count: 0, debugText: longSearchText }],
      };
    };

    let providerCallCount = 0;
    anthropicProvider.sendMessage = async ({ messages }) => {
      providerCallCount += 1;
      providerMessagesByTurn.push(JSON.parse(JSON.stringify(messages || [])));
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
      if (providerCallCount === 2) {
        return {
          stopReason: 'end_turn',
          content: [{
            type: 'tool_use',
            id: 'toolu-stopreason-2',
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
    assert.equal(providerCallCount, 3);
    assert.equal(webSearchCallCount, 1);
    assert.equal(session.messages.length >= 6, true);
    assert.equal(session.messages[1]?.role, 'assistant');
    assert.equal(session.messages[1]?.content?.some((block) => block.type === 'tool_use' && block.id === 'toolu-stopreason-1'), true);
    assert.equal(session.messages[2]?.role, 'user');
    assert.equal(session.messages[2]?.content?.some((block) => block.type === 'tool_result' && block.tool_use_id === 'toolu-stopreason-1'), true);
    const sessionToolResult = session.messages[2]?.content?.find((block) => block.type === 'tool_result');
    assert.ok(sessionToolResult.content.includes('[Context trimmed for model]'));
    assert.ok(sessionToolResult.content.includes('sourceRef=tool:WebSearch#toolu-stopreason-1'));
    const providerSecondTurnToolResult = providerMessagesByTurn[1]
      ?.flatMap((message) => Array.isArray(message.content) ? message.content : [])
      .find((block) => block.type === 'tool_result');
    assert.ok(providerSecondTurnToolResult);
    assert.equal(providerSecondTurnToolResult.content, sessionToolResult.content);
    assert.equal(session.messages[3]?.role, 'assistant');
    assert.equal(session.messages[3]?.content?.some((block) => block.type === 'tool_use' && block.id === 'toolu-stopreason-2'), true);
    assert.equal(session.messages[4]?.role, 'user');
    const cachedSessionToolResult = session.messages[4]?.content?.find((block) => block.type === 'tool_result');
    assert.ok(cachedSessionToolResult);
    assert.ok(cachedSessionToolResult.content.includes('[Context trimmed for model]'));
    assert.ok(cachedSessionToolResult.content.includes('sourceRef=tool:WebSearch#toolu-stopreason-2'));
    const providerThirdTurnToolResult = providerMessagesByTurn[2]
      ?.flatMap((message) => Array.isArray(message.content) ? message.content : [])
      .filter((block) => block.type === 'tool_result')
      .at(-1);
    assert.ok(providerThirdTurnToolResult);
    assert.equal(providerThirdTurnToolResult.content, cachedSessionToolResult.content);
    const emittedToolResults = emittedEvents.filter((event) => event.channel === 'chatAgent:event'
      && event.payload?.sessionId === sessionId
      && event.payload?.kind === 'tool_result'
      && event.payload?.data?.name === 'WebSearch');
    assert.equal(emittedToolResults.length, 2);
    assert.equal(emittedToolResults[0].payload.data.cached, false);
    assert.equal(emittedToolResults[1].payload.data.cached, true);
    assert.equal(emittedToolResults[0].payload.data.cacheKey, emittedToolResults[1].payload.data.cacheKey);
    assert.ok(emittedToolResults[1].payload.data.text.includes('CHAT_LONG_HEAD_'));
    assert.ok(emittedToolResults[1].payload.data.text.includes('_CHAT_LONG_TAIL'));
    assert.equal(
      emittedToolResults.some((event) => event.payload?.data?.isError === false
        && event.payload?.data?.text.includes('CHAT_LONG_HEAD_')
        && event.payload?.data?.text.includes('_CHAT_LONG_TAIL')
        && event.payload?.data?.modelContentTrimmed === true),
      true
    );
    assert.equal(
      emittedEvents.some((event) => event.channel === 'chatAgent:event'
        && event.payload?.sessionId === sessionId
        && event.payload?.kind === 'context_stats'),
      true
    );
    assert.equal(
      emittedEvents.some((event) => event.channel === 'chatAgent:event'
        && event.payload?.sessionId === sessionId
        && event.payload?.kind === 'context_manifest'
        && Array.isArray(event.payload?.data?.cached)
        && event.payload.data.cached.some((item) => item.sourceRef === 'tool:WebSearch#toolu-stopreason-2')
        && Array.isArray(event.payload?.data?.trimmed)
        && event.payload.data.trimmed.some((item) => item.sourceRef === 'tool:WebSearch#toolu-stopreason-1')),
      true
    );

    const historySessionId = chatAgent.createSession({
      editorContext: {
        novelId: 'novel-stopreason-regression',
        type: 'chapter',
        title: 'chapter-001.md',
      },
      messages: [{
        role: 'assistant',
        text: '历史工具结果',
        toolCalls: [{
          id: 'toolu-history-long',
          name: 'WebSearch',
          input: { query: 'history' },
          result: `HISTORY_LONG_HEAD_${'z'.repeat(15000)}_HISTORY_LONG_TAIL`,
          isError: false,
        }],
      }],
    });
    const historySession = chatAgent.getSession(historySessionId);
    const historyToolResult = historySession.messages
      .flatMap((message) => Array.isArray(message.content) ? message.content : [])
      .find((block) => block.type === 'tool_result' && block.tool_use_id === 'toolu-history-long');
    assert.ok(historyToolResult);
    assert.ok(historyToolResult.content.includes('[Context trimmed for model]'));
    assert.ok(historyToolResult.content.includes('sourceRef=tool:WebSearch#toolu-history-long'));
    chatAgent.closeSession(historySessionId);
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
