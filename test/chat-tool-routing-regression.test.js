'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');

async function runChatToolRoutingRegressionTest() {
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
  process.env.MANA_USER_DATA_ROOT = path.join(ROOT, 'tmp-test-chat-tool-routing-userdata');
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
  const originalRunWorkflow = workflowOrchestrator.runWorkflow;
  const originalSendMessage = anthropicProvider.sendMessage;
  const originalListTools = mcpClient.listTools;
  const originalGetActiveNovel = mcpClient.getActiveNovel;
  const originalGetActiveNovelContext = mcpClient.getActiveNovelContext;
  const originalSearchWeb = searchEngine.searchWeb;

  let chatAgent = null;
  let sessionId = '';
  let driverSessionId = '';
  let idleSessionId = '';
  let providerCallCount = 0;
  let capturedToolNames = [];
  const workflowCalls = [];
  let capturedDriverSystemPrompt = '';
  let capturedIdleSystemPrompt = '';
  let capturedIdleToolNames = [];

  try {
    providerManager.getActiveProvider = async () => ({
      id: 'routing-regression-provider',
      name: 'routing-regression-provider',
      type: 'anthropic',
      apiKey: 'routing-regression-key',
      baseUrl: 'https://example.invalid/anthropic',
      models: [{ id: 'routing-regression-model' }],
    });
    modelAliases.getAlias = async () => ({
      id: 'sonnet',
      providerId: null,
      modelId: 'routing-regression-model',
      maxOutputTokens: 256,
      temperature: 0,
    });
    workflowOrchestrator.getActiveDriverId = () => 'direct-api';
    workflowOrchestrator.runWorkflow = async (args) => {
      workflowCalls.push(args);
      if (args?.systemPromptOverride) capturedDriverSystemPrompt = args.systemPromptOverride;
      return { output: '子代理执行完成' };
    };
    searchEngine.searchWeb = async ({ query }) => ({
      results: [{ title: `搜索结果:${query}`, snippet: '命中摘要', url: 'https://example.invalid/search', source: 'duckduckgo' }],
      errors: ['DuckDuckGo: 1条'],
      sourceDetails: [{ source: 'duckduckgo', sourceLabel: 'DuckDuckGo', query, count: 1 }],
    });

    mcpClient.listTools = async () => ([
      {
        name: 'list_novels',
        description: 'List novels',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'create_novel',
        description: 'Create novel',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'read_skill',
        description: 'Read skill',
        inputSchema: { type: 'object', properties: {} },
      },
    ]);
    mcpClient.getActiveNovel = () => 'novel-routing-regression';
    mcpClient.getActiveNovelContext = () => ({
      id: 'novel-routing-regression',
      dir: '/tmp/novel-routing-regression',
    });

    anthropicProvider.sendMessage = async ({ tools }) => {
      providerCallCount += 1;
      if (providerCallCount === 1) {
        capturedToolNames = (tools || []).map((tool) => tool.name);
        return {
          stopReason: 'tool_use',
          content: [{
            type: 'tool_use',
            id: 'toolu-routing-web-1',
            name: 'WebSearch',
            input: {
              query: '碧蓝航线 信浓 设定',
            },
          }],
        };
      }
      if (providerCallCount === 2) {
        return {
          stopReason: 'tool_use',
          content: [{
            type: 'tool_use',
            id: 'toolu-routing-1',
            name: 'spawn_subagent',
            input: {
              subagentId: 'sa-lore-updater',
              input: '整理本章设定变更',
            },
          }],
        };
      }
      return {
        stopReason: 'end_turn',
        content: [{ type: 'text', text: '主流程收到子代理结果。' }],
      };
    };

    const chatAgentPath = path.join(ROOT, 'src/main/runtime/chatAgent');
    delete require.cache[require.resolve(chatAgentPath)];
    chatAgent = require(chatAgentPath);
    sessionId = chatAgent.createSession({ editorContext: {}, messages: [] });

    await chatAgent.runTurn(sessionId, '把这段整理后交给子代理处理');

    assert.ok(capturedToolNames.includes('spawn_subagent'));
  assert.ok(capturedToolNames.includes('WebSearch'));
  assert.ok(capturedToolNames.includes('WebFetch'));
    assert.ok(capturedToolNames.includes('set_workflow_phase'));
    assert.ok(capturedToolNames.includes('confirm_outline'));
    assert.equal(workflowCalls.length, 1);
    assert.equal(workflowCalls[0]?.mode, 'subagent');
    assert.equal(workflowCalls[0]?.subagentId, 'sa-lore-updater');
    assert.deepEqual(workflowCalls[0]?.novelContext, {
      novelId: 'novel-routing-regression',
      novelDir: '/tmp/novel-routing-regression',
    });
    assert.equal(
      emittedEvents.some((event) => event.channel === 'chatAgent:event' && event.payload?.kind === 'frontend_action'),
      false
    );
    assert.equal(
      emittedEvents.some((event) => event.channel === 'chatAgent:event' && event.payload?.kind === 'tool_result' && event.payload?.data?.name === 'WebSearch' && event.payload?.data?.isError === false),
      true
    );

    pass(
      'CTR1_provider_path_exposes_backend_and_web_tools_without_frontend_misroute',
      'spawn_subagent and WebSearch stayed callable, forwarded active novel context, and did not emit frontend_action'
    );

    workflowCalls.length = 0;
    capturedDriverSystemPrompt = '';
    providerCallCount = 0;
    workflowOrchestrator.getActiveDriverId = async () => 'claude-code-vscode';

    driverSessionId = chatAgent.createSession({
      editorContext: {
        novelId: 'novel-routing-regression',
        novelTitle: '回归测试项目',
        chapterCount: 1,
        title: 'chapter-001.md',
        type: 'chapter',
        selectedText: '原文片段',
      },
      messages: [],
    });

    await chatAgent.runTurn(driverSessionId, '请概括当前章节还需要补哪些描写');

    assert.ok(capturedDriverSystemPrompt.includes('WebSearch'));
    assert.ok(capturedDriverSystemPrompt.includes('Agent (Claude Code builtin subagent tool'));
    assert.equal(capturedDriverSystemPrompt.includes('replace_selected_text'), false);
    assert.equal(capturedDriverSystemPrompt.includes('insert_text_at_cursor'), false);
    assert.equal(capturedDriverSystemPrompt.includes('spawn_subagent'), false);
    assert.equal(capturedDriverSystemPrompt.includes('set_workflow_phase'), false);
    assert.equal(capturedDriverSystemPrompt.includes('confirm_outline'), false);
    pass(
      'CTR2_driver_prompt_only_mentions_callable_driver_tools',
      'driver-backed chat prompt no longer advertises frontend/session-only tools that Claude Code cannot call'
    );

    workflowOrchestrator.getActiveDriverId = () => 'direct-api';
    mcpClient.getActiveNovel = () => '';
    capturedIdleSystemPrompt = '';
    capturedIdleToolNames = [];
    anthropicProvider.sendMessage = async ({ system, tools }) => {
      capturedIdleSystemPrompt = system;
      capturedIdleToolNames = (tools || []).map((tool) => tool.name);
      return {
        stopReason: 'end_turn',
        content: [{ type: 'text', text: '先创建项目。' }],
      };
    };

    idleSessionId = chatAgent.createSession({ editorContext: {}, messages: [] });
    await chatAgent.runTurn(idleSessionId, '帮我先梳理一下开新项目前要准备什么');

    assert.ok(capturedIdleToolNames.includes('create_novel'));
    assert.ok(capturedIdleToolNames.includes('list_novels'));
    assert.ok(capturedIdleToolNames.includes('WebSearch'));
    assert.ok(capturedIdleToolNames.includes('WebFetch'));
    assert.equal(capturedIdleSystemPrompt.includes('list_characters'), false);
    assert.equal(capturedIdleSystemPrompt.includes('read_chapter'), false);
    assert.equal(capturedIdleSystemPrompt.includes('confirm_outline'), false);
    assert.equal(capturedIdleSystemPrompt.includes('enrich_character'), false);
    pass(
      'CTR3_idle_prompt_only_mentions_bootstrap_and_web_tools',
      'when no novel is active, the chat prompt no longer advertises novel-only tools that are filtered out of the actual tool list'
    );
  } catch (err) {
    fail('CTR_harness', err?.message || String(err));
  } finally {
    if (sessionId && chatAgent) {
      try { chatAgent.closeSession(sessionId); } catch { /* ignore */ }
    }
    if (driverSessionId && chatAgent) {
      try { chatAgent.closeSession(driverSessionId); } catch { /* ignore */ }
    }
    if (idleSessionId && chatAgent) {
      try { chatAgent.closeSession(idleSessionId); } catch { /* ignore */ }
    }
    providerManager.getActiveProvider = originalGetActiveProvider;
    modelAliases.getAlias = originalGetAlias;
    workflowOrchestrator.getActiveDriverId = originalGetActiveDriverId;
    workflowOrchestrator.runWorkflow = originalRunWorkflow;
    anthropicProvider.sendMessage = originalSendMessage;
    mcpClient.listTools = originalListTools;
    mcpClient.getActiveNovel = originalGetActiveNovel;
    mcpClient.getActiveNovelContext = originalGetActiveNovelContext;
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

module.exports = { runChatToolRoutingRegressionTest };

if (require.main === module) {
  runChatToolRoutingRegressionTest().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
