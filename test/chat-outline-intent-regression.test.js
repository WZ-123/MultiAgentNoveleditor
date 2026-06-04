'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');

async function seedNovel(ROOT) {
  const novelsStore = require(path.join(ROOT, 'src/main/store/novels'));
  const mcpClient = require(path.join(ROOT, 'src/main/mcp/mcpClientStdio'));
  const chatHistory = require(path.join(ROOT, 'src/main/store/chatHistory'));
  const { novelPaths } = require(path.join(ROOT, 'src/main/store/paths'));

  const tmpRoot = path.join(ROOT, 'tmp-test-chat-outline-intent');
  await fs.rm(tmpRoot, { recursive: true, force: true });
  await fs.mkdir(tmpRoot, { recursive: true });
  const dir = path.join(tmpRoot, 'novel-' + Date.now());
  await fs.mkdir(dir, { recursive: true });

  const entry = await novelsStore.createNovel({ title: '聊天大纲意图回归小说', dir });
  await novelsStore.openNovel(entry.id);
  await mcpClient.setActiveNovel(entry.id, dir);

  const np = novelPaths(dir);
  await fs.mkdir(np.characters, { recursive: true });
  await fs.writeFile(path.join(np.characters, 'hero.json'), JSON.stringify({
    id: 'hero',
    name: '主角',
    role: '主角',
    personality: '执拗、克制',
    _enrichmentStatus: 'skipped',
  }, null, 2), 'utf8');

  await fs.mkdir(np.world, { recursive: true });
  await fs.writeFile(np.worldLore, '# 世界观\n\n一座被海雾封锁的港城。', 'utf8');
  await fs.writeFile(np.worldMeta, JSON.stringify({ name: '海雾港', description: '回归测试世界' }, null, 2), 'utf8');

  const thread = await chatHistory.createThread({ title: '聊天自动转大纲回归', novelId: entry.id });
  return { entry, dir, threadId: thread.id, cleanupRoot: tmpRoot };
}

async function runChatOutlineIntentRegressionTest() {
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
  process.env.MANA_USER_DATA_ROOT = path.join(ROOT, 'tmp-test-chat-outline-intent-userdata');
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
  const openaiCompatProvider = require(path.join(ROOT, 'src/main/runtime/providers/openaiCompat'));
  const mcpClient = require(path.join(ROOT, 'src/main/mcp/mcpClientStdio'));
  const chatHistory = require(path.join(ROOT, 'src/main/store/chatHistory'));
  const novelData = require(path.join(ROOT, 'src/main/store/novelData'));
  const outlineDraftService = require(path.join(ROOT, 'src/main/runtime/outlineDraftService'));
  const chapterDraftService = require(path.join(ROOT, 'src/main/runtime/chapterDraftService'));

  const originalGetActiveProvider = providerManager.getActiveProvider;
  const originalGetAlias = modelAliases.getAlias;
  const originalGetActiveDriverId = workflowOrchestrator.getActiveDriverId;
  const originalSendMessage = anthropicProvider.sendMessage;
  const originalOpenAiCompatSendMessage = openaiCompatProvider.sendMessage;
  const originalGenerateOutlineDraft = outlineDraftService.generateOutlineDraft;
  const originalGenerateChapterDraft = chapterDraftService.generateChapterDraft;

  let cleanupRoot = '';
  let sessionId = '';
  let threadId = '';
  let chatAgent = null;
  let providerCallCount = 0;
  const outlineCalls = [];
  const chapterCalls = [];

  try {
    const seeded = await seedNovel(ROOT);
    cleanupRoot = seeded.cleanupRoot;
    threadId = seeded.threadId;
    pass('O1_seed_novel', `novel=${seeded.entry.id}`);

    providerManager.getActiveProvider = async () => ({
      id: 'outline-regression-provider',
      name: 'outline-regression-provider',
      type: 'anthropic',
      apiKey: 'outline-regression-key',
      baseUrl: 'https://example.invalid/anthropic',
      models: [{ id: 'outline-regression-model' }],
    });
    modelAliases.getAlias = async () => ({
      id: 'sonnet',
      providerId: null,
      modelId: 'outline-regression-model',
      maxOutputTokens: 512,
      temperature: 0,
    });
    workflowOrchestrator.getActiveDriverId = () => 'direct-api';
    anthropicProvider.sendMessage = async () => {
      providerCallCount += 1;
      return {
        stopReason: 'end_turn',
        content: [{ type: 'text', text: '普通聊天回复。' }],
      };
    };
    openaiCompatProvider.sendMessage = anthropicProvider.sendMessage;

    outlineDraftService.generateOutlineDraft = async ({ mode, userText, pendingOutlineDraft }) => {
      outlineCalls.push({ mode, userText, hadPendingDraft: !!pendingOutlineDraft });
      const rawMarkdown = mode === 'user_outline'
        ? '# 总大纲\n\n## 第一卷：回港\n\n### 第一节：雾中重逢\n\n- 第1章：旧钟楼\n  - 场景1：主角在港口钟楼与失散搭档重逢。'
        : '# 总大纲\n\n## 第一卷：回港\n\n### 第一节：雾城来信\n\n- 第1章：归雾\n  - 场景1：主角收到来自海雾港的求救信。';
      const title = mode === 'user_outline' ? '旧钟楼' : '归雾';
      return {
        draft: {
          rawMarkdown,
          nodes: [
            { id: 'vol-1', title: '回港', summary: '主角重返海雾港', volumeIndex: 1, level: 1 },
            { id: 'sec-1-1', title: mode === 'user_outline' ? '雾中重逢' : '雾城来信', summary: '危机重新浮现', volumeIndex: 1, sectionIndex: 1, level: 2 },
            {
              id: `scene-${mode}`,
              title,
              summary: mode === 'user_outline' ? '主角在钟楼重逢搭档，并得知真正敌人。' : '主角收到来自海雾港的求救信。',
              characters: ['hero'],
              volumeIndex: 1,
              sectionIndex: 1,
              chapterIndex: 1,
              chapterTitle: mode === 'user_outline' ? '旧钟楼' : '归雾',
            },
          ],
        },
        blockingIssues: mode === 'user_outline'
          ? []
          : [{ id: 'issue-1', sourceAgent: 'timeline', summary: '第一章与港口封锁时间线需要再对齐。', affectedOutlineNodeIds: ['scene-plot_direction'] }],
        assistantText: mode === 'user_outline'
          ? '我已按专用大纲流程基于当前草案重做了一版，先不写入项目。\n\n# 总大纲\n\n## 第一卷：回港\n\n### 第一节：雾中重逢'
          : '我已按专用大纲流程生成了一版草案，先不写入项目。\n\n# 总大纲\n\n## 第一卷：回港\n\n### 第一节：雾城来信',
      };
    };

    chapterDraftService.generateChapterDraft = async ({ mode, userText, pendingChapterDraft }) => {
      chapterCalls.push({ mode, userText, hadPendingDraft: !!pendingChapterDraft });
      return {
        draft: {
          name: 'chapter-004.md',
          displayName: '第4章',
          title: '直播驱魔',
          summary: '楚岚按照新大纲进入直播驱魔段落。',
          text: '第四章草稿正文。',
        },
        blockingIssues: [],
        assistantText: '我已按专用写作流程生成第四章草稿，先不写入项目。',
      };
    };

    const chatAgentPath = path.join(ROOT, 'src/main/runtime/chatAgent');
    delete require.cache[require.resolve(chatAgentPath)];
    chatAgent = require(chatAgentPath);

    sessionId = chatAgent.createSession({
      editorContext: { novelId: seeded.entry.id, chapterCount: 0, novelTitle: '聊天大纲意图回归小说' },
      messages: [],
      threadId,
    });

    await chatAgent.runTurn(sessionId, '帮我创建第四章大纲，第四章剧情顺序如下：晚上八点整，楚岚的直播间准时亮起。');
    const sessionAfterExplicitOutline = chatAgent.getSession(sessionId);
    if (
      providerCallCount === 0
      && outlineCalls.length === 1
      && outlineCalls[0].mode === 'plot_direction'
      && sessionAfterExplicitOutline?.workflowPhase === 'outline'
      && sessionAfterExplicitOutline?.pendingOutlineDraft?.nodes?.length === 3
    ) {
      pass('O2_explicit_chapter_outline_prompt_routes_to_outline_flow', 'explicit chapter outline request with plot order stayed in outline draft flow');
    } else {
      fail('O2_explicit_chapter_outline_prompt_routes_to_outline_flow', JSON.stringify({ providerCallCount, outlineCalls, phase: sessionAfterExplicitOutline?.workflowPhase, pending: sessionAfterExplicitOutline?.pendingOutlineDraft }));
    }

    await chatAgent.runTurn(sessionId, '第三章剧情走向有何建议？总之第四章的剧情是楚岚在家里直播驱魔（不用你写，只是告诉你需要承上启下的内容）');
    const sessionAfterCreate = chatAgent.getSession(sessionId);
    const outlineAfterCreate = await novelData.readOutlineNodes(seeded.dir);
    if (providerCallCount === 0 && outlineCalls.length === 2 && outlineCalls[1].mode === 'user_outline' && outlineCalls[1].hadPendingDraft && sessionAfterCreate?.workflowPhase === 'outline' && sessionAfterCreate?.pendingOutlineDraft?.nodes?.length === 3 && !outlineAfterCreate?.nodes?.length) {
      pass('O3_followup_plot_prompt_reuses_pending_outline', 'follow-up chapter plot brief reused the pending outline draft instead of falling back to normal chat');
    } else {
      fail('O3_followup_plot_prompt_reuses_pending_outline', JSON.stringify({ providerCallCount, outlineCalls, phase: sessionAfterCreate?.workflowPhase, outlineAfterCreate }));
    }

    await chatAgent.runTurn(sessionId, '把这个大纲细化一下，强化主角和搭档的冲突');
    const sessionAfterRevise = chatAgent.getSession(sessionId);
    if (outlineCalls.length === 3 && outlineCalls[2].mode === 'user_outline' && outlineCalls[2].hadPendingDraft && /旧钟楼/.test(sessionAfterRevise?.pendingOutlineDraft?.rawMarkdown || '')) {
      pass('O4_pending_draft_revision_uses_user_outline', 'follow-up revision reused pending draft');
    } else {
      fail('O4_pending_draft_revision_uses_user_outline', JSON.stringify({ outlineCalls, rawMarkdown: sessionAfterRevise?.pendingOutlineDraft?.rawMarkdown }));
    }

    await chatAgent.runTurn(sessionId, '确认写入大纲');
    const sessionAfterConfirm = chatAgent.getSession(sessionId);
    const outlineAfterConfirm = await novelData.readOutlineNodes(seeded.dir);
    if (sessionAfterConfirm?.workflowPhase === 'writing' && !sessionAfterConfirm?.pendingOutlineDraft && Array.isArray(outlineAfterConfirm?.nodes) && outlineAfterConfirm.nodes.length === 3) {
      pass('O5_confirm_writes_outline_then_switches_phase', 'draft persisted only on explicit confirmation');
    } else {
      fail('O5_confirm_writes_outline_then_switches_phase', JSON.stringify({ phase: sessionAfterConfirm?.workflowPhase, pending: !!sessionAfterConfirm?.pendingOutlineDraft, outlineAfterConfirm }));
    }

    const chainThread = await chatHistory.createThread({ title: '确认后续写回归', novelId: seeded.entry.id });
    const chainSessionId = chatAgent.createSession({
      editorContext: { novelId: seeded.entry.id, chapterCount: 3, novelTitle: '聊天大纲意图回归小说' },
      messages: [],
      threadId: chainThread.id,
    });
    const chainSession = chatAgent.getSession(chainSessionId);
    chainSession.pendingOutlineDraft = {
      rawMarkdown: '# 总大纲\n\n- 第4章：直播驱魔',
      nodes: [
        { id: 'vol-chain', title: '直播卷', summary: '直播驱魔展开', volumeIndex: 1, level: 1 },
        { id: 'scene-chain-4', title: '直播驱魔', summary: '楚岚在家直播驱魔。', volumeIndex: 1, sectionIndex: 1, chapterIndex: 4, chapterTitle: '直播驱魔' },
      ],
    };
    chainSession.pendingOutlineIssues = [];
    chainSession.workflowPhase = 'outline';
    const chapterCallsBeforeChain = chapterCalls.length;
    await chatAgent.runTurn(chainSessionId, '确认写入。并且按照这个大纲续写第四章');
    const chainSessionAfter = chatAgent.getSession(chainSessionId);
    const chainThreadLoaded = await chatHistory.getThread(chainThread.id);
    const chainBranch = chatHistory.getBranch(chainThreadLoaded);
    const chainLastAssistant = chainBranch.filter((message) => message.role === 'assistant').slice(-1)[0];
    if (
      chainSessionAfter?.workflowPhase === 'writing'
      && !chainSessionAfter?.pendingOutlineDraft
      && chainSessionAfter?.pendingChapterDraft?.name === 'chapter-004.md'
      && chapterCalls.length === chapterCallsBeforeChain + 1
      && chapterCalls[chapterCalls.length - 1]?.mode === 'create'
      && /已将当前大纲写入项目/.test(chainLastAssistant?.text || '')
      && /第四章草稿/.test(chainLastAssistant?.text || '')
    ) {
      pass('O7_confirm_outline_can_chain_into_chapter_draft', 'one user turn can confirm the outline and continue into the next chapter draft');
    } else {
      fail('O7_confirm_outline_can_chain_into_chapter_draft', JSON.stringify({ chainSessionAfter, chapterCalls, text: chainLastAssistant?.text }));
    }
    chatAgent.closeSession(chainSessionId);

    const thread = await chatHistory.getThread(threadId);
    const branch = chatHistory.getBranch(thread);
    if (branch.filter((message) => message.role === 'assistant').length === 4) {
      pass('O8_chat_history_keeps_draft_turns', 'assistant replies persisted for draft/revise/confirm');
    } else {
      fail('O8_chat_history_keeps_draft_turns', JSON.stringify(branch));
    }

    const confirmThread = await chatHistory.createThread({ title: '如上请执行确认回归', novelId: seeded.entry.id });
    const confirmSessionId = chatAgent.createSession({
      editorContext: { novelId: seeded.entry.id, chapterCount: 0, novelTitle: '聊天大纲意图回归小说' },
      messages: [],
      threadId: confirmThread.id,
    });
    const outlineBeforeGenericConfirm = await novelData.readOutlineNodes(seeded.dir);
    await chatAgent.runTurn(confirmSessionId, '第四章剧情顺序如下：晚上八点整，楚岚的直播间准时亮起。');
    const confirmDraftSession = JSON.parse(JSON.stringify(chatAgent.getSession(confirmSessionId)));
    await chatAgent.runTurn(confirmSessionId, '如上，请执行');
    const confirmSavedSession = JSON.parse(JSON.stringify(chatAgent.getSession(confirmSessionId)));
    const outlineAfterGenericConfirm = await novelData.readOutlineNodes(seeded.dir);
    if (
      confirmDraftSession?.pendingOutlineDraft?.nodes?.length === 3
      && confirmSavedSession?.workflowPhase === 'writing'
      && !confirmSavedSession?.pendingOutlineDraft
      && Array.isArray(outlineBeforeGenericConfirm?.nodes)
      && outlineBeforeGenericConfirm.nodes.length === 3
      && Array.isArray(outlineAfterGenericConfirm?.nodes)
      && outlineAfterGenericConfirm.nodes.length === 3
    ) {
      pass('O9_generic_execute_confirms_pending_outline', '如上，请执行 deterministically confirmed the pending outline draft');
    } else {
      fail('O9_generic_execute_confirms_pending_outline', JSON.stringify({ confirmDraftSession, confirmSavedSession, outlineBeforeGenericConfirm, outlineAfterGenericConfirm }));
    }
    chatAgent.closeSession(confirmSessionId);

    const secondThread = await chatHistory.createThread({ title: '普通聊天回归', novelId: seeded.entry.id });
    const secondSessionId = chatAgent.createSession({
      editorContext: { novelId: seeded.entry.id, chapterCount: 1, novelTitle: '聊天大纲意图回归小说' },
      messages: [],
      threadId: secondThread.id,
    });
    await chatAgent.runTurn(secondSessionId, '请总结一下当前角色设定');
    if (providerCallCount === 1 && outlineCalls.length === 4) {
      pass('O10_non_outline_chat_not_misrouted', 'ordinary chat still uses provider path');
    } else {
      fail('O10_non_outline_chat_not_misrouted', JSON.stringify({ providerCallCount, outlineCalls }));
    }
    chatAgent.closeSession(secondSessionId);

    const thirdThread = await chatHistory.createThread({ title: '审查未完成拦截回归', novelId: seeded.entry.id });
    const thirdSessionId = chatAgent.createSession({
      editorContext: { novelId: seeded.entry.id, chapterCount: 0, novelTitle: '聊天大纲意图回归小说' },
      messages: [],
      threadId: thirdThread.id,
    });
    const thirdSession = chatAgent.getSession(thirdSessionId);
    thirdSession.pendingOutlineDraft = {
      rawMarkdown: '# 总大纲\n\n## 第一卷：回港',
      nodes: [
        { id: 'vol-1', title: '回港', summary: '主角重返海雾港', volumeIndex: 1, level: 1 },
      ],
    };
    thirdSession.pendingOutlineIssues = [{
      id: 'issue-review-incomplete',
      sourceAgent: 'timeline',
      summary: '时空校验本轮未完成，请先重试后再确认写入。',
      reviewIncomplete: true,
    }];
    thirdSession.workflowPhase = 'outline';
    await chatAgent.runTurn(thirdSessionId, '确认写入大纲');
    const sessionAfterBlockedConfirm = chatAgent.getSession(thirdSessionId);
    const outlineAfterBlockedConfirm = await novelData.readOutlineNodes(seeded.dir);
    if (sessionAfterBlockedConfirm?.workflowPhase === 'outline' && sessionAfterBlockedConfirm?.pendingOutlineDraft && Array.isArray(outlineAfterBlockedConfirm?.nodes) && outlineAfterBlockedConfirm.nodes.length === 3) {
      pass('O11_incomplete_review_blocks_confirmation', 'confirmation is blocked when review is incomplete');
    } else {
      fail('O11_incomplete_review_blocks_confirmation', JSON.stringify({ phase: sessionAfterBlockedConfirm?.workflowPhase, pending: !!sessionAfterBlockedConfirm?.pendingOutlineDraft, outlineAfterBlockedConfirm }));
    }
    chatAgent.closeSession(thirdSessionId);
  } catch (err) {
    fail('O12_harness', err.message || String(err));
  } finally {
    providerManager.getActiveProvider = originalGetActiveProvider;
    modelAliases.getAlias = originalGetAlias;
    workflowOrchestrator.getActiveDriverId = originalGetActiveDriverId;
    anthropicProvider.sendMessage = originalSendMessage;
    openaiCompatProvider.sendMessage = originalOpenAiCompatSendMessage;
    outlineDraftService.generateOutlineDraft = originalGenerateOutlineDraft;
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

module.exports = { runChatOutlineIntentRegressionTest };

if (require.main === module) {
  runChatOutlineIntentRegressionTest().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
