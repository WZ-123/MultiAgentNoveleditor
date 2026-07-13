'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');

async function seedNovel(ROOT) {
  const novelsStore = require(path.join(ROOT, 'src/main/store/novels'));
  const mcpClient = require(path.join(ROOT, 'src/main/mcp/mcpClientStdio'));
  const chatHistory = require(path.join(ROOT, 'src/main/store/chatHistory'));
  const { novelPaths } = require(path.join(ROOT, 'src/main/store/paths'));

  const tmpRoot = path.join(ROOT, 'tmp-test-chat-timeline-regression');
  await fs.rm(tmpRoot, { recursive: true, force: true });
  await fs.mkdir(tmpRoot, { recursive: true });
  const dir = path.join(tmpRoot, 'novel-' + Date.now());
  await fs.mkdir(dir, { recursive: true });

  const entry = await novelsStore.createNovel({ title: '聊天时间线回归小说', dir });
  await novelsStore.openNovel(entry.id);
  await mcpClient.setActiveNovel(entry.id, dir);

  const np = novelPaths(dir);
  await fs.mkdir(np.characters, { recursive: true });
  await fs.writeFile(path.join(np.characters, 'hero.json'), JSON.stringify({
    id: 'hero',
    name: '主角',
    role: '主角',
    _enrichmentStatus: 'skipped',
  }, null, 2), 'utf8');

  await fs.mkdir(np.world, { recursive: true });
  await fs.writeFile(np.worldLore, '# 世界观\n\n回归测试世界。', 'utf8');
  await fs.writeFile(np.worldMeta, JSON.stringify({ name: '回归测试世界' }, null, 2), 'utf8');

  const thread = await chatHistory.createThread({ title: '聊天时间线去重回归', novelId: entry.id });
  return { entry, dir, threadId: thread.id, cleanupRoot: tmpRoot };
}

async function runChatTimelineRegressionTest() {
  const results = { total: 0, passed: 0, failed: 0 };
  function pass(name, detail) {
    results.total++; results.passed++;
    console.log(`TEST_PASS ${name}${detail ? ': ' + detail : ''}`);
  }
  function fail(name, reason) {
    results.total++; results.failed++;
    console.log(`TEST_FAIL ${name}: ${reason}`);
  }

  const ROOT = path.resolve(__dirname, '..');
  const chatAgent = require(path.join(ROOT, 'src/main/runtime/chatAgent'));
  const chatHistory = require(path.join(ROOT, 'src/main/store/chatHistory'));
  const novelData = require(path.join(ROOT, 'src/main/store/novelData'));
  const providerManager = require(path.join(ROOT, 'src/main/providerManager'));
  const modelAliases = require(path.join(ROOT, 'src/main/modelAliases'));
  const workflowOrchestrator = require(path.join(ROOT, 'src/main/runtime/workflowOrchestrator'));
  const anthropicProvider = require(path.join(ROOT, 'src/main/runtime/providers/anthropic'));

  const originalGetActiveProvider = providerManager.getActiveProvider;
  const originalGetAlias = modelAliases.getAlias;
  const originalGetActiveDriverId = workflowOrchestrator.getActiveDriverId;
  const originalSendMessage = anthropicProvider.sendMessage;

  let cleanupRoot = '';
  let sessionId = '';
  let threadId = '';

  const scriptedResponses = [
    {
      stopReason: 'tool_use',
      content: [
        { type: 'text', text: '我先记录一条时间线事件。' },
        {
          type: 'tool_use',
          id: 'toolu-timeline-1',
          name: 'append_timeline',
          input: {
            id: 'evt-chat-1',
            when: '第一天黄昏',
            description: '旧版事件描述',
            participants: ['hero'],
          },
        },
      ],
    },
    {
      stopReason: 'end_turn',
      content: [
        { type: 'text', text: '已记录时间线事件。' },
      ],
    },
    {
      stopReason: 'tool_use',
      content: [
        { type: 'text', text: '我来修正刚才那条时间线。' },
        {
          type: 'tool_use',
          id: 'toolu-timeline-2',
          name: 'update_timeline',
          input: {
            id: 'evt-chat-1',
            patch: {
              when: '第一天深夜',
              description: '修正后的事件描述',
              participants: ['hero'],
            },
          },
        },
      ],
    },
    {
      stopReason: 'end_turn',
      content: [
        { type: 'text', text: '已修正时间线事件。' },
      ],
    },
  ];

  try {
    const seeded = await seedNovel(ROOT);
    cleanupRoot = seeded.cleanupRoot;
    threadId = seeded.threadId;
    pass('T1_seed_novel', `novel=${seeded.entry.id}`);

    providerManager.getActiveProvider = async () => ({
      id: 'timeline-regression-provider',
      name: 'timeline-regression-provider',
      type: 'anthropic',
      apiKey: 'timeline-regression-key',
      baseUrl: 'https://example.invalid',
      models: [{ id: 'timeline-regression-model' }],
    });
    modelAliases.getAlias = async (aliasId) => ({
      id: aliasId || 'sonnet',
      providerId: null,
      modelId: 'timeline-regression-model',
      maxOutputTokens: 512,
      temperature: 0,
    });
    workflowOrchestrator.getActiveDriverId = () => 'direct-api';
    anthropicProvider.sendMessage = async ({ onEvent }) => {
      const next = scriptedResponses.shift();
      if (!next) throw new Error('unexpected sendMessage call');
      for (const block of next.content || []) {
        if (block.type === 'text' && block.text) {
          onEvent && onEvent({ kind: 'text', data: { delta: block.text } });
        }
        if (block.type === 'tool_use') {
          onEvent && onEvent({ kind: 'tool_use', data: { id: block.id, name: block.name, input: block.input } });
        }
      }
      return next;
    };

    sessionId = chatAgent.createSession({
      editorContext: { novelId: seeded.entry.id, chapterCount: 1, novelTitle: '聊天时间线回归小说' },
      messages: [],
      threadId,
    });

    await chatAgent.runTurn(sessionId, '请记录一条时间线事件。');
    await chatAgent.runTurn(sessionId, '把刚才那条时间线事件改成修正后的版本，不要重复新增。');

    const timeline = await novelData.listTimeline(seeded.dir);
    const matches = timeline.filter((event) => event?.id === 'evt-chat-1');
    if (matches.length === 1 && matches[0]?.description === '修正后的事件描述' && matches[0]?.when === '第一天深夜') {
      pass('T2_run_turn_updates_without_duplicate', 'second chat turn updated the same event instead of appending');
    } else {
      fail('T2_run_turn_updates_without_duplicate', JSON.stringify(timeline));
    }

    const reopened = await chatHistory.getThread(threadId);
    const branch = chatHistory.getBranch(reopened);
    const assistantMessages = branch.filter((message) => message.role === 'assistant');
    const firstTools = assistantMessages[0]?.toolCalls || [];
    const secondTools = assistantMessages[1]?.toolCalls || [];
    if (assistantMessages.length === 2 && firstTools.some((tool) => tool.name === 'append_timeline') && secondTools.some((tool) => tool.name === 'update_timeline')) {
      pass('T3_history_persists_append_then_update', 'thread history preserved append/update tool calls across both turns');
    } else {
      fail('T3_history_persists_append_then_update', JSON.stringify(assistantMessages));
    }
    if (assistantMessages.every((message) => message.executionTrace?.schemaVersion === 1
      && message.executionTrace?.status === 'completed'
      && !Object.prototype.hasOwnProperty.call(message.executionTrace, 'thinking'))) {
      pass('T4_history_persists_execution_trace_without_thinking', 'both turns persisted replayable trace metadata while raw thinking remained session-only');
    } else {
      fail('T4_history_persists_execution_trace_without_thinking', JSON.stringify(assistantMessages.map((message) => message.executionTrace)));
    }
  } catch (err) {
    fail('T5_harness', err.message || String(err));
  } finally {
    providerManager.getActiveProvider = originalGetActiveProvider;
    modelAliases.getAlias = originalGetAlias;
    workflowOrchestrator.getActiveDriverId = originalGetActiveDriverId;
    anthropicProvider.sendMessage = originalSendMessage;
    try {
      if (sessionId) chatAgent.closeSession(sessionId);
    } catch {
      // ignore
    }
    try {
      if (cleanupRoot) await fs.rm(cleanupRoot, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }

  console.log('');
  console.log(`TEST_SUMMARY ${results.passed}/${results.total} passed, ${results.failed} failed`);
  console.log('TEST_DONE');
  return results;
}

module.exports = { runChatTimelineRegressionTest };
