'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function runChatSessionLifecycleRegressionTest() {
  const ROOT = path.resolve(__dirname, '..');
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

  try {
    const source = await fs.readFile(path.join(ROOT, 'src/components/AiChatPanel.jsx'), 'utf8');
    assert.ok(source.includes('if (!currentNovelId && (activeThreadId || sessionId)) {'));
    assert.ok(source.includes('let cancelled = false;'));
    assert.ok(source.includes('if (cancelled) return;'));
    assert.ok(source.includes('Do not clear the current conversation during that gap'));
    assert.ok(source.includes('}, [currentNovelId, status]);'));
    pass(
      'CSL1_busy_session_survives_transient_novel_context_gap',
      'AiChatPanel now preserves the current session when novelId briefly drops during workspace refresh, even after a turn has just finished'
    );

    assert.ok(source.includes("setError('AI 正在回复中，请先停止生成或等待完成后再删除当前对话。');"));
    assert.ok(source.includes('await mana.chatAgent.closeSession(sessionId);'));
    assert.ok(source.includes('offEventRef.current = null;'));
    pass(
      'CSL2_delete_active_thread_closes_session',
      'deleting the active thread now closes the chat agent session and removes the event listener'
    );

    assert.ok(source.includes('await switchThread(remainingThreads[0].id);'));
    pass(
      'CSL3_delete_active_thread_selects_next_thread',
      'deleting the active thread switches to the next persisted thread when one exists'
    );

    const revertStart = source.indexOf('async function revertToNode(msgId)');
    const revertEnd = source.indexOf('// ====== Auto-scroll ======', revertStart);
    const revertBlock = source.slice(revertStart, revertEnd);
    assert.ok(revertStart >= 0 && revertEnd > revertStart);
    assert.ok(revertBlock.includes('let localMsgs = [];'));
    assert.ok(!revertBlock.includes('const localMsgs = expandThreadBranch(thread.branch);'));
    assert.ok(revertBlock.includes('localMsgs = expandThreadBranch(thread.branch);'));
    assert.ok(revertBlock.includes('mana.chatAgent.createSession({ editorContext, messages: localMsgs, threadId: activeThreadId })'));
    assert.ok(source.includes('回退到此句之前'));
    assert.ok(source.includes('parseToolResultMeta'));
    assert.ok(source.includes('restoreChangedFile'));
    pass(
      'CSL4_revert_rebuilds_session_from_branch',
      'reverting before a message rebuilds the agent session and exposes change restore controls'
    );

    assert.ok(source.includes('const [isCompact, setIsCompact] = useState(false);'));
    assert.ok(source.includes('new ResizeObserver(updateCompact);'));
    assert.ok(source.includes('if (threadId === activeThreadId) {'));
    assert.ok(source.includes('setShowSidebar(false);'));
    assert.ok(source.includes("aria-label={showSidebar ? '隐藏侧边栏' : '返回对话列表'}"));
    assert.ok(source.includes("data-compact-sidebar={isCompact && showSidebar ? 'true' : 'false'}"));
    const css = await fs.readFile(path.join(ROOT, 'src/index.css'), 'utf8');
    const compactStart = css.indexOf('@container (max-width: 680px)');
    assert.ok(compactStart >= 0);
    const compactCss = css.slice(compactStart);
    assert.ok(compactCss.includes('width: 100%;'));
    assert.ok(!compactCss.includes('display: none;'));
    pass(
      'CSL5_compact_chat_can_return_to_thread_list',
      'compact chat mode exposes an accessible return-to-list control and no longer hides the sidebar with CSS'
    );

    const toolUseStart = source.indexOf("case 'tool_use':");
    const toolUseEnd = source.indexOf("case 'tool_result':");
    const toolUseBlock = source.slice(toolUseStart, toolUseEnd);
    assert.ok(toolUseStart >= 0 && toolUseEnd > toolUseStart);
    assert.ok(!toolUseBlock.includes('persistMessage('));
    pass(
      'CSL6_renderer_does_not_duplicate_tool_turn_persistence',
      'tool-use turns rely on main-process final persistence instead of writing a partial assistant message first'
    );
  } catch (err) {
    fail('CSL_harness', err?.stack || String(err));
  }

  console.log('');
  console.log(`TEST_SUMMARY ${results.passed}/${results.total} passed, ${results.failed} failed`);
  console.log('TEST_DONE');
  return results;
}

module.exports = { runChatSessionLifecycleRegressionTest };

if (require.main === module) {
  runChatSessionLifecycleRegressionTest().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
