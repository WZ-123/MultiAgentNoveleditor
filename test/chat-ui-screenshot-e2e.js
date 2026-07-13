'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fireChatEvent(sessionId, kind, data) {
  const { webContents } = require('electron');
  const payload = { sessionId, kind, data, ts: Date.now() };
  for (const wc of webContents.getAllWebContents()) {
    try {
      wc.send('chatAgent:event', payload);
    } catch {
      // Ignore renderer disposal during shutdown.
    }
  }
}

async function runChatUiScreenshotRegressionTest(mainWindow) {
  const ROOT = path.resolve(__dirname, '..');
  const { paths } = require(path.join(ROOT, 'src/main/store/paths'));
  const chatAgent = require(path.join(ROOT, 'src/main/runtime/chatAgent'));
  const outbox = paths().feedbackOutbox;
  const results = { total: 0, passed: 0, failed: 0, screenshotPath: '', compactScreenshotPath: '', settingsScreenshotPath: '' };

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

  const originalCreateSession = chatAgent.createSession;
  let latestSessionId = null;
  chatAgent.createSession = (...args) => {
    const sessionId = originalCreateSession(...args);
    latestSessionId = sessionId;
    return sessionId;
  };

  try {
    await fs.rm(outbox, { recursive: true, force: true });
    await fs.mkdir(outbox, { recursive: true });
    try {
      mainWindow.setSize(820, 980);
      mainWindow.setMinimumSize(700, 720);
      mainWindow.show();
      mainWindow.focus();
    } catch {
      // The screenshot still works in headless CI-style runs.
    }
    await delay(600);

    const ready = await mainWindow.webContents.executeJavaScript(`
      (async () => {
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const startedAt = Date.now();
        while (Date.now() - startedAt < 12000) {
          const input = document.querySelector('textarea[placeholder="向 AI 提问…"], input[placeholder="向 AI 提问…"]');
          if (input) return { ok: true };
          const buttons = Array.from(document.querySelectorAll('button'));
          const chatBtn = buttons.find((button) => {
            const text = button.textContent || '';
            const svg = button.querySelector('svg');
            return text.includes('AI') || svg?.getAttribute('data-lucide') === 'message-square' || svg?.classList.contains('lucide-message-square');
          });
          if (chatBtn) chatBtn.click();
          await sleep(250);
        }
        return { ok: false, body: (document.body.innerText || '').slice(0, 500) };
      })()
    `);
    if (ready?.ok) pass('CHAT_UI_SCREENSHOT_chat_ready', 'chat composer visible');
    else {
      fail('CHAT_UI_SCREENSHOT_chat_ready', JSON.stringify(ready));
      throw new Error('chat UI was not ready');
    }

    const created = await mainWindow.webContents.executeJavaScript(`
      (() => {
        const button = Array.from(document.querySelectorAll('button[title="新建对话"]'))[0] || null;
        if (!button) return { ok: false, step: 'find_new_thread_button' };
        button.click();
        return { ok: true };
      })()
    `);
    if (created?.ok) pass('CHAT_UI_SCREENSHOT_thread_created', 'new thread selected');
    else {
      fail('CHAT_UI_SCREENSHOT_thread_created', JSON.stringify(created));
      throw new Error('new thread button not found');
    }

    const compactList = await mainWindow.webContents.executeJavaScript(`
      (async () => {
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const waitFor = async (predicate, timeout = 5000) => {
          const startedAt = Date.now();
          while (Date.now() - startedAt < timeout) {
            const value = predicate();
            if (value) return value;
            await sleep(100);
          }
          return null;
        };
        const hideButton = await waitFor(() => {
          const button = document.querySelector('button[aria-label="隐藏侧边栏"]');
          if (button) return button;
          const shell = document.querySelector('[data-testid="chat-shell"]');
          if (shell && shell.getAttribute('data-compact-sidebar') !== 'true' && !document.body.innerText.includes('对话历史')) {
            return { alreadyHidden: true };
          }
          return null;
        });
        if (!hideButton) return { ok: false, step: 'hide_button_missing', body: (document.body.innerText || '').slice(0, 500) };
        if (hideButton.alreadyHidden) return { ok: true, alreadyHidden: true };
        hideButton.click();
        await sleep(100);
        return { ok: true };
      })()
    `);
    if (!compactList?.ok) {
      fail('CHAT_UI_SCREENSHOT_prepare_compact_list', JSON.stringify(compactList));
      throw new Error('could not hide sidebar before compact check');
    }

    try {
      mainWindow.setMinimumSize(420, 640);
      mainWindow.setSize(560, 780);
    } catch {
      // Continue with DOM-level verification when the window manager ignores sizing.
    }
    await delay(300);

    const compactReturn = await mainWindow.webContents.executeJavaScript(`
      (async () => {
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const waitFor = async (predicate, message, timeout = 6000) => {
          const startedAt = Date.now();
          while (Date.now() - startedAt < timeout) {
            const value = predicate();
            if (value) return value;
            await sleep(100);
          }
          throw new Error(message);
        };
        const shell = await waitFor(() => document.querySelector('[data-testid="chat-shell"][data-compact="true"]'), 'compact shell not detected');
        const returnButton = await waitFor(() => document.querySelector('button[aria-label="返回对话列表"]'), 'return list button missing');
        returnButton.click();
        await waitFor(() => document.body.innerText.includes('对话历史') && shell.getAttribute('data-compact-sidebar') === 'true', 'thread list did not return');
        const row = await waitFor(() => document.querySelector('.mana-chat-thread-item'), 'thread row missing');
        row.click();
        await waitFor(() => document.querySelector('[data-testid="chat-composer"]') && shell.getAttribute('data-compact-sidebar') === 'false', 'chat composer did not return');
        return {
          ok: true,
          compact: shell.getAttribute('data-compact'),
          compactSidebar: shell.getAttribute('data-compact-sidebar'),
          width: window.innerWidth,
          hasComposer: !!document.querySelector('[data-testid="chat-composer"]'),
        };
      })()
    `);
    if (compactReturn?.ok) pass('CHAT_UI_SCREENSHOT_compact_return_to_thread_list', JSON.stringify(compactReturn));
    else {
      fail('CHAT_UI_SCREENSHOT_compact_return_to_thread_list', JSON.stringify(compactReturn));
      throw new Error('compact return-to-list flow failed');
    }

    try {
      mainWindow.setMinimumSize(700, 720);
      mainWindow.setSize(820, 980);
    } catch {
      // The screenshot still works in headless CI-style runs.
    }
    await delay(300);

    const startedAt = Date.now();
    while (!latestSessionId && Date.now() - startedAt < 5000) {
      await delay(50);
    }
    if (latestSessionId) pass('CHAT_UI_SCREENSHOT_session_captured', latestSessionId);
    else {
      fail('CHAT_UI_SCREENSHOT_session_captured', 'session id missing');
      throw new Error('session id missing');
    }

    fireChatEvent(latestSessionId, 'turn_start', { userText: '截图验收：展示自动执行链和进度反馈' });
    fireChatEvent(latestSessionId, 'progress', { stage: 'intent', message: '识别到「确认写入大纲并继续写第八章」：进入受控自动执行链。' });
    fireChatEvent(latestSessionId, 'progress', { stage: 'outline', message: '已保存大纲，正在读取上一章、世界观、角色状态和时间线。' });
    fireChatEvent(latestSessionId, 'progress', { stage: 'roleplay', message: '导演视角：恶毒、拉菲莉、小天鹅进入书房；第 1/3 轮深度互动开始。' });
    fireChatEvent(latestSessionId, 'progress', { stage: 'roleplay', message: '角色动作：恶毒按住门把，拉菲莉检查兔耳，小天鹅记录气味线索。' });
    fireChatEvent(latestSessionId, 'roleplay_event', {
      eventId: 'rp-session-start',
      type: 'session_start',
      chapterRef: 'chapter-008.md',
      title: '第8章',
      summary: '角色驱动写作开始：第8章，1 个场景。',
      details: { interactionLevel: 'deep_interaction', sceneCount: 1 },
      riskLevel: 'none',
    });
    fireChatEvent(latestSessionId, 'roleplay_event', {
      eventId: 'rp-actor-akudoku',
      type: 'actor_proposal',
      chapterRef: 'chapter-008.md',
      sceneId: 'scene-study',
      title: '书房门口',
      actor: { id: 'akudoku', name: '恶毒' },
      summary: '恶毒提出角色反应，并抵触当前大纲安排。',
      details: {
        characterName: '恶毒',
        currentObjective: '确认门后是否有人隐瞒线索。',
        speechCandidates: [{ text: '你们是不是又背着我商量好了？' }],
        actionCandidates: [{ text: '她按住门把，却没有立刻推开。' }],
        wouldResistOutline: true,
      },
      riskLevel: 'medium',
    });
    fireChatEvent(latestSessionId, 'roleplay_event', {
      eventId: 'rp-director-study',
      type: 'director_decision',
      chapterRef: 'chapter-008.md',
      sceneId: 'scene-study',
      title: '书房门口',
      summary: '导演完成「书房门口」第一版仲裁。',
      details: {
        outlineCompliance: 'risk',
        approvedBeats: [{ type: 'action', characterId: 'akudoku', content: '恶毒停在门外，把质问压成一句试探。' }],
        remainingRisks: [{ type: 'outline_drift', note: '如果恶毒当场逼问，会提前公开书房线索。' }],
      },
      riskLevel: 'high',
    });
    fireChatEvent(latestSessionId, 'awaiting_roleplay_risk_decision', {
      chapterRef: 'chapter-008.md',
      title: '第8章',
      riskyScenes: [
        {
          sceneId: 'scene-study',
          title: '书房门口',
          outlineCompliance: 'risk',
          remainingRisks: [{ type: 'outline_drift', note: '如果恶毒当场逼问，会提前公开书房线索。' }],
        },
      ],
    });
    fireChatEvent(latestSessionId, 'tool_use', {
      id: 'tool-screenshot-draft',
      name: 'draft_chapter_with_roleplay',
      input: {
        chapter: '第8章',
        mode: 'character_driven',
        deepInteractionRounds: 3,
      },
    });
    fireChatEvent(latestSessionId, 'tool_result', {
      id: 'tool-screenshot-draft',
      text: JSON.stringify({
        message: '已生成第8章草稿，等待用户确认写入。',
        changedFiles: [
          {
            kind: 'chapter',
            label: '第8章：驱逐舰区的早晨',
            chapterName: '第8章：驱逐舰区的早晨',
            beforeContent: '',
            afterContent: '第二天早上十点，书房走廊里的脚步声同时停住。四道身影并排站在深色木门前。',
          },
        ],
      }),
      isError: false,
    });
    fireChatEvent(latestSessionId, 'text_delta', {
      delta: [
        '我会继续按自动链路推进，不再停在「已切换到写作阶段」。',
        '',
        '当前正在写第8章草稿：先进行角色驱动互动，再由导演视角汇总行动、对白和场面调度，最后产出可确认写入的章节草稿。',
        '',
        '片段预览：第二天早上十点，书房走廊里的脚步声同时停住。四道身影并排站在那扇深色木门前，像四尊被特意摆放在那里的瓷偶，每个人都不太确定自己是该先推门，还是该先深呼吸。晨光透过走廊尽头的窗格斜斜照进来，在地板上切出几道细长的光影。',
        '',
        '### 更新前后对比',
        '',
        '| 字段 | 更新前 | 更新后 |',
        '|---|---|---|',
        '| **role** | 空姐 | 空乘实习生，名门大小姐 |',
        '| **personality** | 未详写 | 完整的冰山美人×痴女双重人格描写 |',
      ].join(String.fromCharCode(10)),
    });
    const executionTrace = {
      schemaVersion: 1,
      traceId: 'trace-ui-screenshot-v1',
      status: 'awaiting_confirmation',
      runtime: { driverId: 'direct-api', path: 'direct-api', intent: 'writing', toolPolicy: { id: 'writing', labels: ['writing'] } },
      stages: [
        { id: 'route', kind: 'route', label: '路由', status: 'completed', durationMs: 18, summary: '角色驱动章节写作' },
        { id: 'context', kind: 'context', label: '上下文', status: 'completed', durationMs: 84, summary: '关键来源 3/3' },
        { id: 'tool', kind: 'tool', label: '工具', status: 'completed', durationMs: 920, summary: '章节草稿预览已生成' },
        { id: 'verification', kind: 'verification', label: '验证', status: 'completed', durationMs: 280, summary: '严格验证通过' },
      ],
      context: {
        sources: [
          { sourceRef: 'chapter:chapter-007.md', kind: 'chapter' },
          { sourceRef: 'outline:scene-study', kind: 'outline' },
          { sourceRef: 'timeline:nearby', kind: 'timeline' },
        ],
        manifests: [], trimmed: ['sceneCharacterContexts'], cached: [], omitted: [],
      },
      tools: [{
        id: 'tool-screenshot-draft', name: 'draft_chapter_with_roleplay', execution: 'mcp', effect: 'write', status: 'done',
        inputSummary: '第8章角色驱动草稿', resultSummary: '已生成严格验证预览，等待确认', isError: false,
        retryCount: 0, cached: false, sourceRef: 'tool:draft_chapter_with_roleplay#tool-screenshot-draft', modelContentTrimmed: false, durationMs: 920, checkpointId: 'checkpoint-ui-1',
      }],
      verification: {
        policy: 'strict', status: 'passed', blockingCount: 0, warningCount: 0,
        checks: [{ constraintId: 'knowledge-boundary', status: 'satisfied', severity: 'blocking', sourceRefs: ['outline:scene-study'], evidenceParagraphIds: ['p-0'], summary: '角色知识边界满足。' }],
      },
      modelCalls: [{ role: 'writer', model: 'test-writer', usage: { inputTokens: 2500, outputTokens: 1200, totalTokens: 3700 } }],
      usage: { inputTokens: 2500, outputTokens: 1200, totalTokens: 3700 },
      fallbacks: [],
      decisions: [{ kind: 'awaiting_write_chapter_confirmation', status: 'pending', summary: '角色与大纲存在张力，等待确认写入。' }],
      processSummary: ['已识别章节写作任务。', '角色驱动写作完成，风险 high。', '严格验证通过，等待用户确认。'],
      startedAt: new Date(Date.now() - 1302).toISOString(),
      completedAt: new Date().toISOString(),
    };
    fireChatEvent(latestSessionId, 'execution_trace_update', { traceId: executionTrace.traceId, revision: 7, trace: executionTrace });
    fireChatEvent(latestSessionId, 'turn_done', {
      text: [
        '我会继续按自动链路推进，不再停在「已切换到写作阶段」。',
        '',
        '当前正在写第8章草稿：先进行角色驱动互动，再由导演视角汇总行动、对白和场面调度，最后产出可确认写入的章节草稿。',
        '',
        '片段预览：第二天早上十点，书房走廊里的脚步声同时停住。四道身影并排站在那扇深色木门前。',
        '',
        '### 更新前后对比',
        '',
        '| 字段 | 更新前 | 更新后 |',
        '|---|---|---|',
        '| **role** | 空姐 | 空乘实习生，名门大小姐 |',
        '| **personality** | 未详写 | 完整的冰山美人×痴女双重人格描写 |',
      ].join(String.fromCharCode(10)),
      turns: 1,
      executionTrace,
      harnessTrace: {
        traceId: 'trace-ui-screenshot',
        harnessMode: 'adaptive',
        contextDepth: 'auto',
        sceneGeneration: 'scene',
        verificationLevel: 'strict',
        targetSource: 'explicit_outline',
        cacheHit: false,
        sourceRefs: [
          { ref: 'chapter:chapter-007.md', type: 'chapter' },
          { ref: 'outline:scene-study', type: 'outline' },
          { ref: 'style:memory', type: 'style' },
          { ref: 'timeline:nearby', type: 'timeline' },
        ],
        diagnostics: [{ code: 'style_hint', severity: 'warning', message: '文风记忆较短，已采用保守表达。' }],
        trimmed: ['sceneCharacterContexts'],
        stages: [
          { name: 'chapter_target', durationMs: 18, status: 'done' },
          { name: 'context_compile', durationMs: 84, status: 'done' },
          { name: 'writer_generation', durationMs: 920, status: 'done' },
        ],
        repairRounds: 1,
        riskProfile: { level: 'high', score: 12, reasons: ['存在角色知识边界', '包含多场景跨地点推进'] },
        stateSnapshot: { chapterRef: 'chapter-007.md', status: 'valid' },
        stateVerifications: [{ sceneId: 'scene-study', status: 'verified', confidence: 0.96, discrepancies: [] }],
        criticalSourceCoverage: { required: 3, used: 3, verified: 3, missing: [] },
        modelCalls: [
          { callId: 'writer-1', role: 'writer', model: 'test-writer', durationMs: 640, usage: { inputTokens: 1800, outputTokens: 900, totalTokens: 2700 } },
          { callId: 'state-1', role: 'state_extractor', model: 'test-reviewer', durationMs: 280, usage: { inputTokens: 700, outputTokens: 300, totalTokens: 1000 } },
        ],
        usage: { inputTokens: 2500, outputTokens: 1200, totalTokens: 3700 },
      },
    });

    const domState = await mainWindow.webContents.executeJavaScript(`
      (async () => {
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const startedAt = Date.now();
        while (Date.now() - startedAt < 4000) {
          const body = document.body.innerText || '';
          const shell = document.querySelector('[data-testid="chat-shell"]');
          const scroll = document.querySelector('[data-testid="chat-message-scroll"]');
          const markdownTable = document.querySelector('[data-testid="chat-markdown"] table');
          const tableWrap = markdownTable?.closest('.mana-chat-table-wrap') || null;
          const messageBubble = markdownTable?.closest('.mana-chat-bubble') || null;
          const tableHeaders = markdownTable ? Array.from(markdownTable.querySelectorAll('th')).map((cell) => cell.textContent.trim()) : [];
          const tableRows = markdownTable ? markdownTable.querySelectorAll('tbody tr').length : 0;
          const boldRole = markdownTable?.querySelector('tbody strong')?.textContent || '';
          const tableContained = !!(tableWrap && messageBubble && tableWrap.getBoundingClientRect().width <= messageBubble.getBoundingClientRect().width);
          const tableOverflow = tableWrap ? getComputedStyle(tableWrap).overflowX : '';
          const expandExecution = document.querySelector('button[title="展开执行过程"]');
          if (expandExecution) { expandExecution.click(); await sleep(100); }
          if (shell && scroll && body.includes('执行过程') && body.includes('3,700 tokens') && body.includes('draft_chapter_with_roleplay') && body.includes('角色驱动') && body.includes('角色与大纲存在张力') && body.includes('验证') && body.includes('决策') && tableHeaders.join('|') === '字段|更新前|更新后' && tableRows === 2 && boldRole === 'role' && tableContained && tableOverflow === 'auto') {
            document.querySelector('[data-testid="execution-trace-card"]')?.scrollIntoView({ block: 'start' });
            scroll.scrollTop = Math.max(0, scroll.scrollTop - 120);
            return {
              ok: true,
              width: window.innerWidth,
              height: window.innerHeight,
              scrollHeight: scroll.scrollHeight,
              clientHeight: scroll.clientHeight,
              tableHeaders,
              tableRows,
              tableContained,
              tableOverflow,
              body: body.slice(0, 600),
            };
          }
          await sleep(100);
        }
        return { ok: false, body: (document.body.innerText || '').slice(0, 800) };
      })()
    `);
    if (domState?.ok) pass('CHAT_UI_SCREENSHOT_sample_rendered', `${domState.width}x${domState.height}, scroll=${domState.scrollHeight}/${domState.clientHeight}`);
    else {
      fail('CHAT_UI_SCREENSHOT_sample_rendered', JSON.stringify(domState));
      throw new Error('sample chat state not rendered');
    }

    const feedbackResult = await mainWindow.webContents.executeJavaScript(`
      window.mana.feedback.submit({
        userInput: {
          issueTitle: '聊天 UI 截图验收',
          description: '用一键反馈截图链路保存当前 AI 聊天面板的真实渲染效果。',
          feedbackMode: 'context-with-logs'
        },
        route: { screen: 'ai-chat', scenario: 'ui-screenshot-regression' },
        recentConversation: [
          { role: 'user', text: '确认写入大纲并继续写第八章' },
          { role: 'assistant', text: '自动执行链路推进中，并显示进度反馈。' }
        ]
      }, { includeScreenshot: true })
    `);

    const screenshotPath = feedbackResult?.attachments?.find((item) => item.kind === 'window-screenshot')?.localPath || '';
    if (screenshotPath) {
      const stat = await fs.stat(screenshotPath);
      if (stat.size > 10000) {
        results.screenshotPath = screenshotPath;
        pass('CHAT_UI_SCREENSHOT_feedback_saved_png', `${screenshotPath} (${stat.size} bytes)`);
        console.log(`TEST_SCREENSHOT ${screenshotPath}`);
      } else {
        fail('CHAT_UI_SCREENSHOT_feedback_saved_png', `screenshot too small: ${stat.size}`);
      }
    } else {
      fail('CHAT_UI_SCREENSHOT_feedback_saved_png', JSON.stringify(feedbackResult));
    }

    try {
      mainWindow.setMinimumSize(420, 640);
      mainWindow.setSize(560, 780);
      await delay(350);
      await mainWindow.webContents.executeJavaScript(`document.querySelector('[data-testid="execution-trace-card"]')?.scrollIntoView({ block: 'start' })`);
      await delay(150);
      const compactState = await mainWindow.webContents.executeJavaScript(`(() => {
        const shell = document.querySelector('[data-testid="chat-shell"]');
        const card = document.querySelector('[data-testid="execution-trace-card"]');
        const shellRect = shell?.getBoundingClientRect();
        const cardRect = card?.getBoundingClientRect();
        return {
          compact: shell?.getAttribute('data-compact'),
          cardVisible: !!card,
          overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          cardInsideShell: !!(shellRect && cardRect && cardRect.left >= shellRect.left - 1 && cardRect.right <= shellRect.right + 1),
          cardInsideViewport: !!(cardRect && cardRect.left >= -1 && cardRect.right <= document.documentElement.clientWidth + 1),
          cardOverflowX: card ? card.scrollWidth - card.clientWidth : null,
        };
      })()`);
      const compactImage = await mainWindow.capturePage();
      const compactScreenshotPath = path.join(outbox, 'chat-execution-trace-compact.png');
      await fs.writeFile(compactScreenshotPath, compactImage.toPNG());
      results.compactScreenshotPath = compactScreenshotPath;
      if (compactState?.compact === 'true'
        && compactState.cardVisible
        && compactState.cardInsideShell
        && compactState.cardInsideViewport
        && Number(compactState.overflowX) <= 1
        && Number(compactState.cardOverflowX) <= 1) {
        pass('CHAT_UI_SCREENSHOT_compact_execution_card', JSON.stringify(compactState));
        console.log(`TEST_SCREENSHOT ${compactScreenshotPath}`);
      } else {
        fail('CHAT_UI_SCREENSHOT_compact_execution_card', JSON.stringify(compactState));
      }
    } finally {
      try {
        mainWindow.setMinimumSize(700, 720);
        mainWindow.setSize(820, 980);
      } catch { /* ignore */ }
      await delay(250);
    }

    const settingsState = await mainWindow.webContents.executeJavaScript(`
      (async () => {
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const settingsButton = Array.from(document.querySelectorAll('[title], [aria-label]')).find((button) =>
          ['设置', 'Settings'].includes(button.getAttribute('title'))
          || ['设置', 'Settings'].includes(button.getAttribute('aria-label'))
        );
        if (!settingsButton) return { ok: false, step: 'settings_button' };
        settingsButton.click();
        for (let i = 0; i < 40; i += 1) {
          const writing = Array.from(document.querySelectorAll('button')).find((button) => (button.textContent || '').includes('写作设置'));
          if (writing) { writing.click(); break; }
          await sleep(100);
        }
        for (let i = 0; i < 40; i += 1) {
          const select = document.querySelector('select[aria-label="一致性校验"]');
          if (select) {
            return {
              ok: true,
              options: Array.from(select.options).map((option) => option.value),
              harnessControls: Array.from(document.querySelectorAll('select[aria-label]')).map((item) => item.getAttribute('aria-label')),
              body: (document.body.innerText || '').slice(0, 500),
            };
          }
          await sleep(100);
        }
        return { ok: false, step: 'verification_select', body: (document.body.innerText || '').slice(0, 600) };
      })()
    `);
    if (settingsState?.ok && ['auto', 'fast', 'strict'].every((value) => settingsState.options.includes(value))) {
      pass('CHAT_UI_SCREENSHOT_writing_settings_rendered', JSON.stringify(settingsState.harnessControls));
      const settingsImage = await mainWindow.capturePage();
      const settingsScreenshotPath = path.join(outbox, 'writing-settings-harness-v2.png');
      await fs.writeFile(settingsScreenshotPath, settingsImage.toPNG());
      results.settingsScreenshotPath = settingsScreenshotPath;
      console.log(`TEST_SCREENSHOT ${settingsScreenshotPath}`);
    } else {
      fail('CHAT_UI_SCREENSHOT_writing_settings_rendered', JSON.stringify(settingsState));
    }
  } catch (err) {
    fail('CHAT_UI_SCREENSHOT_harness', err.message || String(err));
  } finally {
    chatAgent.createSession = originalCreateSession;
  }

  console.log('');
  console.log(`TEST_SUMMARY ${results.passed}/${results.total} passed, ${results.failed} failed`);
  console.log('TEST_DONE');
  return results;
}

module.exports = { runChatUiScreenshotRegressionTest };
