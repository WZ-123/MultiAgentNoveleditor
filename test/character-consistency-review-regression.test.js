'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');

async function runCharacterConsistencyReviewRegressionTest() {
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
  process.env.MANA_USER_DATA_ROOT = path.join(ROOT, 'tmp-test-character-consistency-review-userdata');
  process.env.MANA_USE_STDIO_MCP = '0';

  try {
    const novelData = require(path.join(ROOT, 'src/main/store/novelData'));
    const workflowOrchestrator = require(path.join(ROOT, 'src/main/runtime/workflowOrchestrator'));
    const { getToolByName } = require(path.join(ROOT, 'src/main/mcp/tools'));

    const originalReadChapter = novelData.readChapter;
    const originalListCharacters = novelData.listCharacters;
    const originalRunWorkflow = workflowOrchestrator.runWorkflow;
    const workflowCalls = [];

    novelData.readChapter = async () => [
      '圣路易斯抬起头，紫红色的眼眸中闪过一丝复杂的情绪。',
      '信浓只是安静地看着他，声音慢悠悠的。',
      '她忽然扬起下巴，语气又急又尖，像在撒娇发火。',
    ].join('\n\n');
    novelData.listCharacters = async () => ([
      {
        id: 'shinano',
        name: '信浓',
        aliases: [],
        role: '重樱舰娘',
        appearance: '银白长发，蓝紫色眼眸。',
        personality: '温和、慵懒、成熟稳重，说话慢悠悠。',
        background: '擅长梦境相关能力。',
        quotes: '妾身在此。',
        attributes: { 瞳色: '蓝紫色' },
      },
    ]);
    workflowOrchestrator.runWorkflow = async (payload) => {
      workflowCalls.push(payload);
      return {
        output: JSON.stringify({
          annotations: [
            {
              paragraphId: 'p-2',
              characterId: 'shinano',
              kind: 'voice_mismatch',
              note: '这一段把信浓写得又急又尖，明显偏离她慢悠悠、成熟稳重的说话方式。',
              evidence: '角色卡写明她说话慢悠悠、气质温和慵懒。',
            },
          ],
        }),
      };
    };

    try {
      const tool = getToolByName('review_character_consistency');
      assert.ok(tool);
      const result = await tool.handler(
        { chapterName: 'chapter-005.md', focus: '检查信浓是不是 OOC' },
        { novelDir: '/tmp/novel-review', novel: { id: 'novel-review' } }
      );
      const payload = JSON.parse(result.content[0].text);

      assert.equal(workflowCalls.length, 1);
      assert.equal(workflowCalls[0]?.mode, 'subagent');
      assert.equal(workflowCalls[0]?.subagentId, 'sa-character-consistency-reviewer');
      const reviewerInput = JSON.parse(workflowCalls[0]?.input || '{}');
      assert.ok(reviewerInput.retrievedContext);
      assert.ok(Array.isArray(reviewerInput.retrievedContext.items));
      assert.ok(reviewerInput.retrievedContext.items.some((item) => item.sourceRef === 'character:shinano'));
      assert.equal(payload.chapterName, 'chapter-005.md');
      assert.deepEqual(payload.reviewedCharacterIds, ['shinano']);
      assert.equal(payload.annotations.length, 1);
      assert.equal(payload.annotations[0]?.paragraphIndex, 2);
      assert.equal(payload.annotations[0]?.characterName, '信浓');
      pass('CCR1_tool_wraps_chapter_character_reviewer', 'review_character_consistency returns paragraph-level annotations from the dedicated reviewer');
    } finally {
      novelData.readChapter = originalReadChapter;
      novelData.listCharacters = originalListCharacters;
      workflowOrchestrator.runWorkflow = originalRunWorkflow;
    }
  } catch (err) {
    fail('CCR1_tool_wraps_chapter_character_reviewer', err?.message || String(err));
  }

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
  const originalGetActiveNovel = mcpClient.getActiveNovel;

  let chatAgent = null;
  let sessionId = '';

  try {
    providerManager.getActiveProvider = async () => ({
      id: 'character-review-routing-provider',
      name: 'character-review-routing-provider',
      type: 'anthropic',
      apiKey: 'character-review-routing-key',
      baseUrl: 'https://example.invalid/anthropic',
      models: [{ id: 'character-review-routing-model' }],
    });
    modelAliases.getAlias = async () => ({
      id: 'sonnet',
      providerId: null,
      modelId: 'character-review-routing-model',
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
      if (name === 'review_character_consistency') {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              chapterName: 'chapter-005.md',
              reviewedCharacterNames: ['信浓'],
              annotations: [
                {
                  paragraphId: 'p-2',
                  paragraphIndexes: [2],
                  paragraphIndex: 2,
                  characterId: 'shinano',
                  characterName: '信浓',
                  note: '这一段把信浓写得又急又尖，口吻明显跑偏。',
                  evidence: '角色卡要求她说话慢悠悠、温和慵懒。',
                  excerpt: '她忽然扬起下巴，语气又急又尖，像在撒娇发火。',
                },
              ],
            }),
          }],
        };
      }
      throw new Error(`unexpected tool call: ${name}`);
    };
    mcpClient.getActiveNovel = () => 'novel-character-review';

    const chatAgentPath = path.join(ROOT, 'src/main/runtime/chatAgent');
    delete require.cache[require.resolve(chatAgentPath)];
    chatAgent = require(chatAgentPath);
    sessionId = chatAgent.createSession({
      editorContext: {
        novelId: 'novel-character-review',
        type: 'chapter',
        title: '第5章：chapter-005.md',
        selectedText: '',
      },
      messages: [],
    });

    await chatAgent.runTurn(sessionId, '第五章信浓有地方不符合人设');

    const session = chatAgent.getSession(sessionId);
    const lastAssistantText = session?.messages?.[session.messages.length - 1]?.content?.[0]?.text || '';

    assert.equal(providerCallCount, 0);
    assert.equal(toolCalls.length, 1);
    assert.equal(toolCalls[0]?.name, 'review_character_consistency');
    assert.equal(toolCalls[0]?.args?.chapterName, 'chapter-005.md');
    assert.match(toolCalls[0]?.args?.focus || '', /信浓|人设/u);
    assert.equal(
      emittedEvents.some((event) => event.channel === 'chatAgent:event' && event.payload?.kind === 'frontend_action'),
      false
    );
    assert.match(lastAssistantText, /按段检查/u);
    assert.match(lastAssistantText, /暂不自动批量改正文/u);
    pass('CCR2_chat_review_request_short_circuits_to_review_tool', 'character consistency review requests bypass provider and return paragraph-level findings without auto-editing');
  } catch (err) {
    fail('CCR2_chat_review_request_short_circuits_to_review_tool', err?.message || String(err));
  } finally {
    if (sessionId && chatAgent) {
      try { chatAgent.closeSession(sessionId); } catch { /* ignore */ }
    }
    providerManager.getActiveProvider = originalGetActiveProvider;
    modelAliases.getAlias = originalGetAlias;
    workflowOrchestrator.getActiveDriverId = originalGetActiveDriverId;
    anthropicProvider.sendMessage = originalSendMessage;
    mcpClient.callTool = originalCallTool;
    mcpClient.getActiveNovel = originalGetActiveNovel;
    if (originalElectronCache) {
      require.cache[electronModulePath] = originalElectronCache;
    } else {
      delete require.cache[electronModulePath];
    }
  }

  try {
    const fs = require('node:fs');
    const chatAgentText = fs.readFileSync(path.join(ROOT, 'src/main/runtime/chatAgent.js'), 'utf8');
    assert.ok(chatAgentText.includes('review_character_consistency'));
    assert.ok(chatAgentText.includes('暂不自动批量改正文'));
    pass('CCR3_chat_prompt_mentions_review_first_flow', 'chat agent rules mention the explicit character review tool and the no-auto-edit policy');
  } catch (err) {
    fail('CCR3_chat_prompt_mentions_review_first_flow', err?.message || String(err));
  }

  console.log('');
  console.log(`TEST_SUMMARY ${results.passed}/${results.total} passed, ${results.failed} failed`);
  console.log('TEST_DONE');
  return results;
}

module.exports = { runCharacterConsistencyReviewRegressionTest };

if (require.main === module) {
  runCharacterConsistencyReviewRegressionTest().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
