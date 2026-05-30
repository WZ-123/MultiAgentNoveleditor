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
    assert.ok(source.includes("if (!currentNovelId && status !== 'idle' && (sessionId || activeThreadId)) {"));
    assert.ok(source.includes('Do not kill an in-flight chat turn during that gap.'));
    assert.ok(source.includes('}, [currentNovelId, status]);'));
    pass(
      'CSL1_busy_session_survives_transient_novel_context_gap',
      'AiChatPanel now preserves an in-flight session when novelId briefly drops during workspace refresh'
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

    assert.ok(source.includes('mana.chatAgent.createSession({ editorContext, messages: localMsgs, threadId: activeThreadId })'));
    pass(
      'CSL4_revert_rebuilds_session_from_branch',
      'reverting a thread rebuilds the agent session from the reverted branch'
    );

    const toolUseStart = source.indexOf("case 'tool_use':");
    const toolUseEnd = source.indexOf("case 'tool_result':");
    const toolUseBlock = source.slice(toolUseStart, toolUseEnd);
    assert.ok(toolUseStart >= 0 && toolUseEnd > toolUseStart);
    assert.ok(!toolUseBlock.includes('persistMessage('));
    pass(
      'CSL5_renderer_does_not_duplicate_tool_turn_persistence',
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
