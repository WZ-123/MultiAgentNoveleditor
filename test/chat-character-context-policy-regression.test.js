'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');

async function runChatCharacterContextPolicyRegressionTest() {
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
  process.env.MANA_USER_DATA_ROOT = path.join(ROOT, 'tmp-test-chat-character-context-policy-userdata');
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
  const originalListTools = mcpClient.listTools;
  const originalCallTool = mcpClient.callTool;
  const originalGetActiveNovel = mcpClient.getActiveNovel;

  let chatAgent = null;
  let writingSessionId = '';
  let generalSessionId = '';

  try {
    providerManager.getActiveProvider = async () => ({
      id: 'character-context-policy-provider',
      name: 'character-context-policy-provider',
      type: 'anthropic',
      apiKey: 'character-context-policy-key',
      baseUrl: 'https://example.invalid/anthropic',
      models: [{ id: 'character-context-policy-model' }],
    });
    modelAliases.getAlias = async () => ({
      id: 'opus',
      providerId: null,
      modelId: 'character-context-policy-model',
      maxOutputTokens: 256,
      temperature: 0,
    });
    workflowOrchestrator.getActiveDriverId = () => 'direct-api';
    mcpClient.getActiveNovel = () => 'novel-character-context-policy';
    mcpClient.listTools = async () => ([
      { name: 'read_outline_nodes', description: 'Read outline nodes', inputSchema: { type: 'object', properties: {} } },
      { name: 'assemble_scene_context', description: 'Assemble scene context', inputSchema: { type: 'object', properties: {} } },
      { name: 'retrieve_context', description: 'Retrieve bounded context', inputSchema: { type: 'object', properties: {} } },
      { name: 'read_character', description: 'Read full character card', inputSchema: { type: 'object', properties: {} } },
      { name: 'list_characters', description: 'List character index', inputSchema: { type: 'object', properties: {} } },
    ]);

    const toolCalls = [];
    mcpClient.callTool = async ({ name, arguments: args }) => {
      toolCalls.push({ name, args });
      if (name === 'read_outline_nodes') {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              nodes: [{
                id: 'scene-current-3',
                title: '天台重逢',
                summary: '楚岚与阿宁在天台重逢。',
                characters: ['hero'],
                location: '天台',
                setting: '夜晚',
                pov: 'hero',
                chapterIndex: 3,
              }],
            }),
          }],
        };
      }
      if (name === 'assemble_scene_context') {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              nodeId: args.nodeId,
              title: '天台重逢',
              setting: '夜晚',
              location: '天台',
              pov: 'hero',
              characters: [{
                contextMode: 'full_writing_context',
                sourceRef: 'character:hero',
                id: 'hero',
                name: '楚岚',
                role: '主角',
                personality: '克制，但在阿宁面前会短暂停顿。',
                appearance: '黑发，深色外套。',
              }],
            }),
          }],
        };
      }
      if (name === 'retrieve_context') {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              query: args.query,
              resultCount: 2,
              items: [
                { type: 'world_lore', sourceRef: 'world:lore:1', title: '世界观设定 #1', snippet: '天台暗号只能在夜晚使用。', score: 12, target: { type: 'world' } },
                { type: 'timeline_event', sourceRef: 'timeline:evt-3', title: '天台重逢', snippet: '楚岚与阿宁在天台重逢。', score: 10, target: { type: 'timeline' } },
              ],
              contextText: '# Retrieved Novel Context\n\n## 世界观设定 #1\n- sourceRef: world:lore:1\n\n天台暗号只能在夜晚使用。',
            }),
          }],
        };
      }
      if (name === 'read_character') {
        throw new Error('read_character should not be called for automatic chat character context preload');
      }
      return { content: [{ type: 'text', text: '{}' }] };
    };

    const capturedSystems = [];
    anthropicProvider.sendMessage = async ({ system }) => {
      capturedSystems.push(system || '');
      return {
        stopReason: 'end_turn',
        content: [{ type: 'text', text: '已结合当前章节人物表现回复。' }],
      };
    };

    const chatAgentPath = path.join(ROOT, 'src/main/runtime/chatAgent');
    delete require.cache[require.resolve(chatAgentPath)];
    chatAgent = require(chatAgentPath);

    writingSessionId = chatAgent.createSession({
      editorContext: {
        novelId: 'novel-character-context-policy',
        type: 'chapter',
        title: 'chapter-003.md',
        chapterFileName: 'chapter-003.md',
        chapterDisplayName: '第3章',
      },
      messages: [],
    });
    await chatAgent.runTurn(writingSessionId, '结合当前章节剧情聊聊人物表现。');

    assert.equal(toolCalls.some((call) => call.name === 'read_outline_nodes'), true);
    assert.equal(toolCalls.some((call) => call.name === 'assemble_scene_context' && call.args.nodeId === 'scene-current-3'), true);
    assert.equal(toolCalls.some((call) => call.name === 'retrieve_context' && call.args.chapterName === 'chapter-003.md'), true);
    assert.equal(toolCalls.some((call) => call.name === 'read_character'), false);
    assert.ok(capturedSystems[0].includes('## Preloaded Scene Character Context'));
    assert.ok(capturedSystems[0].includes('## Preloaded Retrieval Context'));
    assert.ok(capturedSystems[0].includes('楚岚'));
    assert.ok(capturedSystems[0].includes('character:hero'));
    assert.ok(capturedSystems[0].includes('world:lore:1'));
    assert.equal(capturedSystems[0].includes('read_character should not be called'), false);
    assert.equal(
      emittedEvents.some((event) => event.channel === 'chatAgent:event'
        && event.payload?.sessionId === writingSessionId
        && event.payload?.kind === 'context_manifest'
        && event.payload?.data?.included?.some((item) => item.kind === 'character_context'
          && item.policyId === 'writing_scene_characters'
          && item.targetChapter === 'chapter-003.md')),
      true
    );
    assert.equal(
      emittedEvents.some((event) => event.channel === 'chatAgent:event'
        && event.payload?.sessionId === writingSessionId
        && event.payload?.kind === 'context_manifest'
        && event.payload?.data?.included?.some((item) => item.kind === 'rag_context'
          && item.policyId === 'writing_retrieved_context'
          && item.targetChapter === 'chapter-003.md'
          && item.itemCount === 2)),
      true
    );
    pass(
      'CCP1_writing_chat_preloads_scene_character_context_without_full_card',
      'direct chat preloaded scene character context and did not call read_character'
    );

    toolCalls.length = 0;
    generalSessionId = chatAgent.createSession({
      editorContext: {
        novelId: 'novel-character-context-policy',
        type: 'chapter',
        title: 'chapter-003.md',
        chapterFileName: 'chapter-003.md',
        chapterDisplayName: '第3章',
      },
      messages: [],
    });
    await chatAgent.runTurn(generalSessionId, '你好，聊聊创作方向。');

    assert.equal(toolCalls.some((call) => call.name === 'read_outline_nodes'), false);
    assert.equal(toolCalls.some((call) => call.name === 'assemble_scene_context'), false);
    assert.equal(toolCalls.some((call) => call.name === 'retrieve_context'), false);
    assert.equal(capturedSystems.at(-1).includes('## Preloaded Scene Character Context'), false);
    assert.equal(capturedSystems.at(-1).includes('## Preloaded Retrieval Context'), false);
    assert.equal(
      emittedEvents.some((event) => event.channel === 'chatAgent:event'
        && event.payload?.sessionId === generalSessionId
        && event.payload?.kind === 'context_manifest'
        && event.payload?.data?.omitted?.some((item) => item.kind === 'character_context'
          && item.reason === 'tool-policy-general')),
      true
    );
    pass(
      'CCP2_general_chat_does_not_preload_scene_character_context',
      'general chat keeps character context out of the provider system prompt'
    );
  } catch (err) {
    fail('CCP_harness', err?.stack || String(err));
  } finally {
    if (writingSessionId && chatAgent) {
      try { chatAgent.closeSession(writingSessionId); } catch { /* ignore */ }
    }
    if (generalSessionId && chatAgent) {
      try { chatAgent.closeSession(generalSessionId); } catch { /* ignore */ }
    }
    providerManager.getActiveProvider = originalGetActiveProvider;
    modelAliases.getAlias = originalGetAlias;
    workflowOrchestrator.getActiveDriverId = originalGetActiveDriverId;
    anthropicProvider.sendMessage = originalSendMessage;
    mcpClient.listTools = originalListTools;
    mcpClient.callTool = originalCallTool;
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

module.exports = { runChatCharacterContextPolicyRegressionTest };

if (require.main === module) {
  runChatCharacterContextPolicyRegressionTest().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
