'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');

async function seedNovel(ROOT) {
  const novelsStore = require(path.join(ROOT, 'src/main/store/novels'));
  const mcpClient = require(path.join(ROOT, 'src/main/mcp/mcpClientStdio'));
  const chatHistory = require(path.join(ROOT, 'src/main/store/chatHistory'));
  const { novelPaths } = require(path.join(ROOT, 'src/main/store/paths'));

  const tmpRoot = path.join(ROOT, 'tmp-test-chat-writing-intent');
  await fs.rm(tmpRoot, { recursive: true, force: true });
  await fs.mkdir(tmpRoot, { recursive: true });
  const dir = path.join(tmpRoot, 'novel-' + Date.now());
  await fs.mkdir(dir, { recursive: true });

  const entry = await novelsStore.createNovel({ title: '聊天写作意图回归小说', dir });
  await novelsStore.openNovel(entry.id);
  await mcpClient.setActiveNovel(entry.id, dir);

  const np = novelPaths(dir);
  await fs.mkdir(np.characters, { recursive: true });
  await fs.writeFile(path.join(np.characters, 'hero.json'), JSON.stringify({
    id: 'hero',
    name: '楚岚',
    role: '主角',
    personality: '理性、克制',
    _enrichmentStatus: 'skipped',
  }, null, 2), 'utf8');

  await fs.mkdir(np.world, { recursive: true });
  await fs.writeFile(np.worldLore, '# 世界观\n\n鹏城与武夷山之间存在明确的时间与交通约束。', 'utf8');
  await fs.writeFile(np.worldMeta, JSON.stringify({ name: '回归测试世界' }, null, 2), 'utf8');

  await fs.mkdir(np.chapters, { recursive: true });
  await fs.writeFile(path.join(np.chapters, 'chapter-001.md'), '# 第1章：破庙\n\n第一章正文。', 'utf8');
  await fs.writeFile(path.join(np.chapters, 'chapter-002.md'), '# 第2章：天桥\n\n第二章正文。', 'utf8');

  const thread = await chatHistory.createThread({ title: '聊天写作流程回归', novelId: entry.id });
  return { entry, dir, threadId: thread.id, cleanupRoot: tmpRoot };
}

async function runChatWritingIntentRegressionTest() {
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
  process.env.MANA_USER_DATA_ROOT = path.join(ROOT, 'tmp-test-chat-writing-intent-userdata');
  process.env.MANA_USE_STDIO_MCP = '0';
  const electronModulePath = require.resolve('electron');
  const originalElectronCache = require.cache[electronModulePath];
  require.cache[electronModulePath] = {
    id: electronModulePath,
    filename: electronModulePath,
    loaded: true,
    exports: {
      app: null,
      webContents: { getAllWebContents: () => [] },
    },
  };

  const providerManager = require(path.join(ROOT, 'src/main/providerManager'));
  const modelAliases = require(path.join(ROOT, 'src/main/modelAliases'));
  const workflowOrchestrator = require(path.join(ROOT, 'src/main/runtime/workflowOrchestrator'));
  const anthropicProvider = require(path.join(ROOT, 'src/main/runtime/providers/anthropic'));
  const mcpClient = require(path.join(ROOT, 'src/main/mcp/mcpClientStdio'));
  const chatHistory = require(path.join(ROOT, 'src/main/store/chatHistory'));
  const novelData = require(path.join(ROOT, 'src/main/store/novelData'));
  const subagentsStore = require(path.join(ROOT, 'src/main/store/subagents'));
  const chapterDraftService = require(path.join(ROOT, 'src/main/runtime/chapterDraftService'));

  const originalGetActiveProvider = providerManager.getActiveProvider;
  const originalGetAlias = modelAliases.getAlias;
  const originalGetActiveDriverId = workflowOrchestrator.getActiveDriverId;
  const originalSendMessage = anthropicProvider.sendMessage;
  const originalGenerateChapterDraft = chapterDraftService.generateChapterDraft;

  let cleanupRoot = '';
  let sessionId = '';
  let threadId = '';
  let chatAgent = null;
  let providerCallCount = 0;
  let postWriteProviderCallCount = 0;
  const chapterCalls = [];

  try {
    const seeded = await seedNovel(ROOT);
    cleanupRoot = seeded.cleanupRoot;
    threadId = seeded.threadId;
    pass('W1_seed_novel', `novel=${seeded.entry.id}`);

    providerManager.getActiveProvider = async () => ({
      id: 'writing-regression-provider',
      name: 'writing-regression-provider',
      type: 'anthropic',
      apiKey: 'writing-regression-key',
      baseUrl: 'https://example.invalid',
      models: [{ id: 'writing-regression-model' }],
    });
    modelAliases.getAlias = async () => ({
      id: 'sonnet',
      providerId: null,
      modelId: 'writing-regression-model',
      maxOutputTokens: 512,
      temperature: 0,
    });
    workflowOrchestrator.getActiveDriverId = () => 'direct-api';
    await subagentsStore.ensureBuiltinSeeds();
    anthropicProvider.sendMessage = async ({ system }) => {
      const systemText = String(system || '');
      if (/Chapter Post-Write Override/.test(systemText)) {
        postWriteProviderCallCount += 1;
        return {
          stopReason: 'end_turn',
          content: [{
            type: 'text',
            text: JSON.stringify({
              summary: '陈队长先去武夷山领人，次日回到鹏城，楚岚决定晚上再直播。',
              supplementMarkdown: '- 陈队长确认介入楚岚在武夷山的扣留事件。',
              timelineEvents: [
                {
                  when: '当晚',
                  where: '武夷山',
                  participants: ['陈队长', '楚岚'],
                  description: '陈队长赶到武夷山把楚岚领出扣留地点。',
                },
                {
                  when: '次日',
                  where: '鹏城',
                  participants: ['楚岚', '阿宁'],
                  description: '楚岚回到鹏城后与阿宁讨论吴老狗的蹊跷，并决定晚上再直播。',
                },
              ],
            }),
          }],
        };
      }
      providerCallCount += 1;
      return {
        stopReason: 'end_turn',
        content: [{ type: 'text', text: '普通聊天回复。' }],
      };
    };

    chapterDraftService.generateChapterDraft = async ({ mode, userText, pendingChapterDraft, editorContext }) => {
      chapterCalls.push({ mode, userText, hadPendingDraft: !!pendingChapterDraft, selectedText: editorContext?.selectedText || '', targetTitle: editorContext?.title || '' });
      const revised = mode === 'revise';
      const targetName = editorContext?.type === 'chapter' && editorContext?.title
        ? editorContext.title
        : 'chapter-003.md';
      return {
        draft: {
          name: targetName,
          displayName: targetName === 'chapter-003.md' ? '第3章' : targetName,
          title: revised ? '领人（修订版）' : '领人',
          summary: revised ? '修订后的第三章草稿' : '第三章草稿',
          text: revised
            ? '修订版正文：阿宁是在白天打电话给管理局，说楚岚半夜在武夷山被扣。'
            : '初版正文：阿宁半夜打电话给管理局，说楚岚在武夷山被扣。',
        },
        blockingIssues: revised
          ? []
          : [{ id: 'timeline-1', sourceAgent: 'timeline', summary: '阿宁打电话的时段与前文白天摆摊冲突。' }],
        assistantText: revised
          ? '我已按专用写作流程基于当前草稿重做了一版，先不写入项目。'
          : '我已按专用写作流程先产出一版章节草稿，先不写入项目。',
      };
    };

    const chatAgentPath = path.join(ROOT, 'src/main/runtime/chatAgent');
    delete require.cache[require.resolve(chatAgentPath)];
    chatAgent = require(chatAgentPath);

    sessionId = chatAgent.createSession({
      editorContext: { novelId: seeded.entry.id, chapterCount: 2, novelTitle: '聊天写作意图回归小说' },
      messages: [],
      threadId,
    });

    await chatAgent.runTurn(sessionId, '第三章的剧情是陈队长先去领人了，随后次日回鹏城，情侣二人讨论吴老狗的蹊跷，楚岚晚上准备再直播一下');
    const sessionAfterCreate = chatAgent.getSession(sessionId);
    const chapterDirAfterCreate = await fs.readdir(path.join(seeded.dir, 'chapters'));
    if (providerCallCount === 0 && chapterCalls.length === 1 && chapterCalls[0].mode === 'create' && sessionAfterCreate?.pendingChapterDraft?.name === 'chapter-003.md' && !chapterDirAfterCreate.includes('chapter-003.md')) {
      pass('W2_chapter_brief_routes_to_draft_review', 'chapter brief stayed in review stage without writing to disk');
    } else {
      fail('W2_chapter_brief_routes_to_draft_review', JSON.stringify({ providerCallCount, chapterCalls, pending: sessionAfterCreate?.pendingChapterDraft, chapterDirAfterCreate }));
    }

    await chatAgent.runTurn(sessionId, '把开头再收一下，顺便再检查一下时间线');
    const sessionAfterRevise = chatAgent.getSession(sessionId);
    if (chapterCalls.length === 2 && chapterCalls[1].mode === 'revise' && chapterCalls[1].hadPendingDraft && /修订版/.test(sessionAfterRevise?.pendingChapterDraft?.title || '')) {
      pass('W3_pending_chapter_revision_reuses_draft', 'follow-up revision reused pending chapter draft');
    } else {
      fail('W3_pending_chapter_revision_reuses_draft', JSON.stringify({ chapterCalls, pending: sessionAfterRevise?.pendingChapterDraft }));
    }

    await chatAgent.runTurn(sessionId, '确认写入这一章');
    const sessionAfterConfirm = chatAgent.getSession(sessionId);
    const chapterThreeContent = await fs.readFile(path.join(seeded.dir, 'chapters', 'chapter-003.md'), 'utf8');
    const chapterThreeSummary = await novelData.readSummary(seeded.dir, 'chapter-003.md');
    const chapterThreeTimeline = await novelData.queryTimeline(seeded.dir, { chapterRef: 'chapter-003.md' });
    if (
      !sessionAfterConfirm?.pendingChapterDraft
      && /修订版正文/.test(chapterThreeContent)
      && /陈队长先去武夷山领人/.test(chapterThreeSummary)
      && Array.isArray(chapterThreeTimeline)
      && chapterThreeTimeline.length === 2
      && postWriteProviderCallCount === 1
    ) {
      pass('W4_confirm_writes_chapter_after_review', 'chapter persisted only after explicit confirmation and synced summary/timeline');
    } else {
      fail('W4_confirm_writes_chapter_after_review', JSON.stringify({ pending: sessionAfterConfirm?.pendingChapterDraft, chapterThreeContent, chapterThreeSummary, chapterThreeTimeline, postWriteProviderCallCount }));
    }

    const thread = await chatHistory.getThread(threadId);
    const branch = chatHistory.getBranch(thread);
    const toolNames = branch
      .flatMap((message) => message.toolCalls || [])
      .map((toolCall) => toolCall.name);
    if (
      branch.filter((message) => message.role === 'assistant').length === 3
      && toolNames.includes('review_de_ai_style')
      && toolNames.includes('sync_chapter_timeline')
    ) {
      pass('W5_chat_history_keeps_review_turns', 'draft, revise, confirm, and automatic post-write review turns were persisted');
    } else {
      fail('W5_chat_history_keeps_review_turns', JSON.stringify({ branch, toolNames }));
    }

    const secondThread = await chatHistory.createThread({ title: '普通聊天回归', novelId: seeded.entry.id });
    const secondSessionId = chatAgent.createSession({
      editorContext: { novelId: seeded.entry.id, chapterCount: 3, novelTitle: '聊天写作意图回归小说' },
      messages: [],
      threadId: secondThread.id,
    });
    await chatAgent.runTurn(secondSessionId, '请总结一下当前角色设定');
    if (providerCallCount === 2 && chapterCalls.length === 2) {
      pass('W6_non_writing_chat_not_misrouted', 'ordinary writing-phase chat still falls back to provider path');
    } else {
      fail('W6_non_writing_chat_not_misrouted', JSON.stringify({ providerCallCount, chapterCalls }));
    }
    chatAgent.closeSession(secondSessionId);

    const thirdThread = await chatHistory.createThread({ title: '划选剧情改写回归', novelId: seeded.entry.id });
    const thirdSessionId = chatAgent.createSession({
      editorContext: {
        novelId: seeded.entry.id,
        chapterCount: 3,
        novelTitle: '聊天写作意图回归小说',
        type: 'chapter',
        title: 'chapter-002.md',
        selectedText: '第二章正文。',
        selectionStart: 0,
        selectionEnd: 6,
      },
      messages: [],
      threadId: thirdThread.id,
    });
    await chatAgent.runTurn(thirdSessionId, '就按我刚划选的这段改写：补一层楚岚和阿宁的暧昧拉扯，但要兼顾晚上直播前的铺垫，并检查时空和因果是否合理，先不要直接改正文。');
    const sessionAfterSelectionRewrite = chatAgent.getSession(thirdSessionId);
    const chapterTwoContent = await fs.readFile(path.join(seeded.dir, 'chapters', 'chapter-002.md'), 'utf8');
    if (
      providerCallCount === 2
      && chapterCalls.length === 3
      && chapterCalls[2].mode === 'revise'
      && chapterCalls[2].selectedText === '第二章正文。'
      && chapterCalls[2].targetTitle === 'chapter-002.md'
      && sessionAfterSelectionRewrite?.pendingChapterDraft?.name === 'chapter-002.md'
      && chapterTwoContent === '# 第2章：天桥\n\n第二章正文。'
    ) {
      pass('W7_selection_scoped_plot_rewrite_routes_to_review', 'selected passage plus plot direction stayed in draft/review flow and targeted the current chapter');
    } else {
      fail('W7_selection_scoped_plot_rewrite_routes_to_review', JSON.stringify({ providerCallCount, chapterCalls, pending: sessionAfterSelectionRewrite?.pendingChapterDraft, chapterTwoContent }));
    }
    chatAgent.closeSession(thirdSessionId);

    const implicitSelectionThread = await chatHistory.createThread({ title: '隐式划选剧情改写回归', novelId: seeded.entry.id });
    const implicitSelectionSessionId = chatAgent.createSession({
      editorContext: {
        novelId: seeded.entry.id,
        chapterCount: 3,
        novelTitle: '聊天写作意图回归小说',
        type: 'chapter',
        title: 'chapter-002.md',
        selectedText: '第二章正文。',
        selectionStart: 0,
        selectionEnd: 6,
      },
      messages: [],
      threadId: implicitSelectionThread.id,
    });
    await chatAgent.runTurn(implicitSelectionSessionId, '这里加一段楚岚和阿宁告别时更克制的感情戏，同时把晚上直播前的铺垫和时空因果一起理顺，先不要直接写正文。');
    const sessionAfterImplicitSelectionRewrite = chatAgent.getSession(implicitSelectionSessionId);
    if (
      providerCallCount === 2
      && chapterCalls.length === 4
      && chapterCalls[3].mode === 'revise'
      && chapterCalls[3].selectedText === '第二章正文。'
      && chapterCalls[3].targetTitle === 'chapter-002.md'
      && sessionAfterImplicitSelectionRewrite?.pendingChapterDraft?.name === 'chapter-002.md'
    ) {
      pass('W8_implicit_selection_plot_rewrite_routes_to_review', 'selected passage with implicit scope still entered draft/review flow instead of direct writing');
    } else {
      fail('W8_implicit_selection_plot_rewrite_routes_to_review', JSON.stringify({ providerCallCount, chapterCalls, pending: sessionAfterImplicitSelectionRewrite?.pendingChapterDraft }));
    }
    chatAgent.closeSession(implicitSelectionSessionId);

    const fourthThread = await chatHistory.createThread({ title: '章节审查未完成拦截回归', novelId: seeded.entry.id });
    const fourthSessionId = chatAgent.createSession({
      editorContext: { novelId: seeded.entry.id, chapterCount: 3, novelTitle: '聊天写作意图回归小说' },
      messages: [],
      threadId: fourthThread.id,
    });
    const fourthSession = chatAgent.getSession(fourthSessionId);
    fourthSession.pendingChapterDraft = {
      name: 'chapter-004.md',
      displayName: '第4章',
      title: '待审章节',
      text: '待审正文',
    };
    fourthSession.pendingChapterIssues = [{
      id: 'issue-review-incomplete',
      sourceAgent: 'timeline',
      summary: '时空校验本轮未完成，请先重试后再确认写入。',
      reviewIncomplete: true,
    }];
    fourthSession.workflowPhase = 'writing';
    await chatAgent.runTurn(fourthSessionId, '确认写入这一章');
    const sessionAfterBlockedConfirm = chatAgent.getSession(fourthSessionId);
    let chapterFourExists = true;
    try {
      await fs.access(path.join(seeded.dir, 'chapters', 'chapter-004.md'));
    } catch {
      chapterFourExists = false;
    }
    if (sessionAfterBlockedConfirm?.pendingChapterDraft && !chapterFourExists) {
      pass('W9_incomplete_review_blocks_chapter_confirmation', 'chapter write is blocked when review is incomplete');
    } else {
      fail('W9_incomplete_review_blocks_chapter_confirmation', JSON.stringify({ pending: sessionAfterBlockedConfirm?.pendingChapterDraft, chapterFourExists }));
    }
    chatAgent.closeSession(fourthSessionId);
  } catch (err) {
    fail('W10_harness', err.message || String(err));
  } finally {
    providerManager.getActiveProvider = originalGetActiveProvider;
    modelAliases.getAlias = originalGetAlias;
    workflowOrchestrator.getActiveDriverId = originalGetActiveDriverId;
    anthropicProvider.sendMessage = originalSendMessage;
    chapterDraftService.generateChapterDraft = originalGenerateChapterDraft;
    if (originalElectronCache) {
      require.cache[electronModulePath] = originalElectronCache;
    } else {
      delete require.cache[electronModulePath];
    }
    try {
      if (sessionId && chatAgent) chatAgent.closeSession(sessionId);
    } catch {
      // ignore
    }
    try {
      await mcpClient.dispose();
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

module.exports = { runChatWritingIntentRegressionTest };

if (require.main === module) {
  runChatWritingIntentRegressionTest().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
