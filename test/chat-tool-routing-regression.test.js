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

  const originalGetActiveProvider = providerManager.getActiveProvider;
  const originalGetAlias = modelAliases.getAlias;
  const originalGetActiveDriverId = workflowOrchestrator.getActiveDriverId;
  const originalRunWorkflow = workflowOrchestrator.runWorkflow;
  const originalSendMessage = anthropicProvider.sendMessage;
  const originalListTools = mcpClient.listTools;
  const originalGetActiveNovel = mcpClient.getActiveNovel;
  const originalGetActiveNovelContext = mcpClient.getActiveNovelContext;

  let chatAgent = null;
  let sessionId = '';
  let providerCallCount = 0;
  let capturedToolNames = [];
  const workflowCalls = [];

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
      return { output: '子代理执行完成' };
    };

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

    pass(
      'CTR1_provider_path_exposes_backend_tools_without_frontend_misroute',
      'spawn_subagent remained callable, forwarded active novel context, and did not emit frontend_action'
    );
  } catch (err) {
    fail('CTR1_provider_path_exposes_backend_tools_without_frontend_misroute', err?.message || String(err));
  } finally {
    if (sessionId && chatAgent) {
      try { chatAgent.closeSession(sessionId); } catch { /* ignore */ }
    }
    providerManager.getActiveProvider = originalGetActiveProvider;
    modelAliases.getAlias = originalGetAlias;
    workflowOrchestrator.getActiveDriverId = originalGetActiveDriverId;
    workflowOrchestrator.runWorkflow = originalRunWorkflow;
    anthropicProvider.sendMessage = originalSendMessage;
    mcpClient.listTools = originalListTools;
    mcpClient.getActiveNovel = originalGetActiveNovel;
    mcpClient.getActiveNovelContext = originalGetActiveNovelContext;
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
