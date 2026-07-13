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
  const emittedEvents = [];
  require.cache[electronModulePath] = {
    id: electronModulePath,
    filename: electronModulePath,
    loaded: true,
    exports: {
      app: null,
      webContents: {
        getAllWebContents: () => [{
          send: (_channel, payload) => emittedEvents.push(payload),
        }],
      },
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
  const originalReviewExistingChapterDraft = chapterDraftService.reviewExistingChapterDraft;
  const originalCallTool = mcpClient.callTool;

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
      id: 'opus',
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

    chapterDraftService.generateChapterDraft = async ({ mode, userText, pendingChapterDraft, editorContext, onRoleplayEvent }) => {
      chapterCalls.push({ mode, userText, hadPendingDraft: !!pendingChapterDraft, selectedText: editorContext?.selectedText || '', targetTitle: editorContext?.title || '' });
      if (typeof onRoleplayEvent === 'function') {
        onRoleplayEvent({
          eventId: `test-roleplay-${chapterCalls.length}`,
          type: 'session_start',
          chapterRef: editorContext?.title || 'chapter-003.md',
          title: '测试角色驱动事件',
          summary: '测试用角色驱动事件应随 assistant 消息持久化。',
          details: { sceneCount: 1 },
          riskLevel: 'none',
        });
      }
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

    const roleplayEventMessages = branch.filter((message) => Array.isArray(message.roleplayEvents) && message.roleplayEvents.length > 0);
    if (
      roleplayEventMessages.length >= 2
      && roleplayEventMessages.every((message) => message.role === 'assistant')
      && roleplayEventMessages[0].roleplayEvents[0]?.type === 'session_start'
    ) {
      pass('W5b_chat_history_persists_roleplay_events', 'roleplay UI events are stored on assistant messages without becoming chat text');
    } else {
      fail('W5b_chat_history_persists_roleplay_events', JSON.stringify({ roleplayEventMessages, branch }));
    }

    const emptyDraftThread = await chatHistory.createThread({ title: '空草稿失败回归', novelId: seeded.entry.id });
    const emptyDraftSessionId = chatAgent.createSession({
      editorContext: { novelId: seeded.entry.id, chapterCount: 3, novelTitle: '聊天写作意图回归小说' },
      messages: [],
      threadId: emptyDraftThread.id,
    });
    const generateBeforeEmptyDraft = chapterDraftService.generateChapterDraft;
    chapterDraftService.generateChapterDraft = async () => ({
      draft: null,
      blockingIssues: [],
      draftGenerationFailed: true,
      assistantText: '这次章节草稿没有生成成功：章节草稿为空\n\n我没有写入任何章节。',
    });
    await chatAgent.runTurn(emptyDraftSessionId, '继续写下一章');
    const emptyDraftBranch = chatHistory.getBranch(await chatHistory.getThread(emptyDraftThread.id));
    const emptyDraftAssistant = emptyDraftBranch.find((message) => message.role === 'assistant');
    if (
      emptyDraftAssistant
      && /章节草稿没有生成成功/.test(emptyDraftAssistant.text || '')
      && !chatAgent.getSession(emptyDraftSessionId)?.pendingChapterDraft
    ) {
      pass('W5c_empty_chapter_draft_returns_chat_message', 'empty writer output is surfaced as a recoverable chat message');
    } else {
      fail('W5c_empty_chapter_draft_returns_chat_message', JSON.stringify({ emptyDraftBranch, pending: chatAgent.getSession(emptyDraftSessionId)?.pendingChapterDraft }));
    }
    chapterDraftService.generateChapterDraft = generateBeforeEmptyDraft;
    chatAgent.closeSession(emptyDraftSessionId);

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

    const styleBlockThread = await chatHistory.createThread({ title: '文风问题阻塞写入回归', novelId: seeded.entry.id });
    const styleBlockSessionId = chatAgent.createSession({
      editorContext: { novelId: seeded.entry.id, chapterCount: 3, novelTitle: '聊天写作意图回归小说' },
      messages: [],
      threadId: styleBlockThread.id,
    });
    const styleBlockSession = chatAgent.getSession(styleBlockSessionId);
    styleBlockSession.pendingChapterDraft = {
      name: 'chapter-005.md',
      displayName: '第5章',
      title: '文风待审章节',
      text: '不是害怕，而是命运的回响。',
    };
    styleBlockSession.pendingChapterIssues = [{
      id: 'style-open-1',
      source: 'style',
      sourceAgent: 'style',
      category: 'style',
      severity: 'blocking',
      status: 'open',
      summary: '文风偏 AI 味。',
      note: '文风偏 AI 味。',
      paragraphIds: ['p-0'],
      paragraphIndexes: [0],
      excerpt: '不是害怕，而是命运的回响。',
    }];
    styleBlockSession.workflowPhase = 'writing';
    await chatAgent.runTurn(styleBlockSessionId, '确认写入这一章');
    let chapterFiveExists = true;
    try {
      await fs.access(path.join(seeded.dir, 'chapters', 'chapter-005.md'));
    } catch {
      chapterFiveExists = false;
    }
    if (chatAgent.getSession(styleBlockSessionId)?.pendingChapterDraft && !chapterFiveExists) {
      pass('W9b_open_style_issue_blocks_chapter_confirmation', 'open style/prose review issues block chapter confirmation');
    } else {
      fail('W9b_open_style_issue_blocks_chapter_confirmation', JSON.stringify({ pending: chatAgent.getSession(styleBlockSessionId)?.pendingChapterDraft, chapterFiveExists }));
    }
    await chatAgent.runTurn(styleBlockSessionId, '忽略第1条');
    const styleAfterIgnore = chatAgent.getSession(styleBlockSessionId);
    const styleIssueStatus = styleAfterIgnore?.pendingChapterIssues?.find((issue) => issue.id === 'style-open-1')?.status;
    if (styleIssueStatus === 'ignored') {
      pass('W9c_ignored_chapter_issue_releases_blocker', 'explicitly ignored issue is no longer open');
    } else {
      fail('W9c_ignored_chapter_issue_releases_blocker', JSON.stringify(styleAfterIgnore?.pendingChapterIssues));
    }
    chatAgent.closeSession(styleBlockSessionId);

    const previewThread = await chatHistory.createThread({ title: '草稿修复预览回归', novelId: seeded.entry.id });
    const previewSessionId = chatAgent.createSession({
      editorContext: { novelId: seeded.entry.id, chapterCount: 3, novelTitle: '聊天写作意图回归小说' },
      messages: [],
      threadId: previewThread.id,
    });
    const previewSession = chatAgent.getSession(previewSessionId);
    previewSession.pendingChapterDraft = {
      name: 'chapter-006.md',
      displayName: '第6章',
      title: '预览章节',
      text: '不是害怕，而是命运的回响。',
    };
    previewSession.pendingChapterIssues = [{
      id: 'prose-open-1',
      source: 'prose_quality',
      sourceAgent: 'prose_quality',
      category: 'not_but_overuse',
      severity: 'blocking',
      status: 'open',
      summary: 'AI 味 not-but 套句。',
      note: 'AI 味 not-but 套句。',
      paragraphIds: ['p-0'],
      paragraphIndexes: [0],
    }];
    chapterDraftService.reviewExistingChapterDraft = async ({ draft }) => ({
      issues: [],
      blockingIssues: [],
      advisoryIssues: [],
      draft,
    });
    mcpClient.callTool = async (payload) => {
      if (payload?.name === 'de_ai_ify') {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ revisedText: '他确实怕了，但还是把这口气咽回去，抬眼看向门外。' }),
          }],
        };
      }
      return originalCallTool(payload);
    };
    await chatAgent.runTurn(previewSessionId, '预览修复第1条');
    const previewAfterBuild = chatAgent.getSession(previewSessionId);
    const hadPendingFixPreview = !!previewAfterBuild?.pendingChapterFixPreview;
    await chatAgent.runTurn(previewSessionId, '应用修复');
    const previewAfterApply = chatAgent.getSession(previewSessionId);
    if (
      hadPendingFixPreview
      && /他确实怕了/.test(previewAfterApply?.pendingChapterDraft?.text || '')
      && !previewAfterApply?.pendingChapterFixPreview
      && !(previewAfterApply?.pendingChapterIssues || []).some((issue) => issue.status === 'open')
    ) {
      pass('W9d_pending_draft_fix_preview_applies_after_confirmation', 'draft fix preview updates only session draft and clears reviewed issue after apply');
    } else {
      fail('W9d_pending_draft_fix_preview_applies_after_confirmation', JSON.stringify({
        preview: previewAfterBuild?.pendingChapterFixPreview,
        draft: previewAfterApply?.pendingChapterDraft,
        issues: previewAfterApply?.pendingChapterIssues,
      }));
    }
    mcpClient.callTool = originalCallTool;
    chapterDraftService.reviewExistingChapterDraft = originalReviewExistingChapterDraft;
    chatAgent.closeSession(previewSessionId);

    const outlineThread = await chatHistory.createThread({ title: '大纲确认自动续跑回归', novelId: seeded.entry.id });
    const outlineSessionId = chatAgent.createSession({
      editorContext: { novelId: seeded.entry.id, chapterCount: 3, novelTitle: '聊天写作意图回归小说' },
      messages: [],
      threadId: outlineThread.id,
    });
    const outlineSession = chatAgent.getSession(outlineSessionId);
    outlineSession.workflowPhase = 'outline';
    outlineSession.pendingOutlineDraft = {
      nodes: [
        { id: 'outline-auto-vol', title: '自动续跑卷', summary: '卷摘要', volumeIndex: 1, level: 1 },
        { id: 'outline-auto-sec', title: '自动续跑节', summary: '节摘要', volumeIndex: 1, sectionIndex: 1, level: 2 },
        { id: 'outline-auto-scene', title: '自动续跑章', summary: '写下一章。', volumeIndex: 1, sectionIndex: 1, chapterIndex: 4, level: 3 },
      ],
      rawMarkdown: '# 自动续跑大纲',
    };
    outlineSession.pendingOutlineIssues = [];
    const callsBeforeOutlineConfirm = chapterCalls.length;
    emittedEvents.length = 0;
    await chatAgent.runTurn(outlineSessionId, '确认写入大纲');
    const outlineSessionAfterConfirm = chatAgent.getSession(outlineSessionId);
    const progressMessages = emittedEvents
      .filter((event) => event?.kind === 'progress')
      .map((event) => event.data?.message || '');
    if (
      outlineSessionAfterConfirm?.workflowPhase === 'writing'
      && !outlineSessionAfterConfirm?.pendingOutlineDraft
      && outlineSessionAfterConfirm?.pendingChapterDraft
      && chapterCalls.length === callsBeforeOutlineConfirm + 1
      && /继续写下一章/.test(chapterCalls[chapterCalls.length - 1]?.userText || '')
      && progressMessages.some((message) => /自动续跑/.test(message))
    ) {
      pass('W10_outline_confirm_auto_continues_to_chapter_draft', 'confirming outline internally continued into next chapter draft without requiring another user message');
    } else {
      fail('W10_outline_confirm_auto_continues_to_chapter_draft', JSON.stringify({
        workflowPhase: outlineSessionAfterConfirm?.workflowPhase,
        pendingOutlineDraft: !!outlineSessionAfterConfirm?.pendingOutlineDraft,
        pendingChapterDraft: outlineSessionAfterConfirm?.pendingChapterDraft,
        chapterCalls,
        progressMessages,
      }));
    }
    chatAgent.closeSession(outlineSessionId);
  } catch (err) {
    fail('W11_harness', err.message || String(err));
  } finally {
    providerManager.getActiveProvider = originalGetActiveProvider;
    modelAliases.getAlias = originalGetAlias;
    workflowOrchestrator.getActiveDriverId = originalGetActiveDriverId;
    anthropicProvider.sendMessage = originalSendMessage;
    chapterDraftService.generateChapterDraft = originalGenerateChapterDraft;
    chapterDraftService.reviewExistingChapterDraft = originalReviewExistingChapterDraft;
    mcpClient.callTool = originalCallTool;
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
