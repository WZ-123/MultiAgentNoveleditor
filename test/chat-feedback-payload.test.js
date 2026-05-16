import assert from 'node:assert/strict';
import { buildQuickFeedbackPayload } from '../src/components/chatFeedbackPayload.mjs';

function test(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}: ${err.message || err}`);
    process.exitCode = 1;
  }
}

test('CFP1_context_mode_includes_recent_tool_calls_and_checkpoint', () => {
  const payload = buildQuickFeedbackPayload({
    issueTitle: 'AI 改错位置',
    actualBehavior: '改到了上一句',
    expectedBehavior: '只改选中句',
    reproductionSteps: '打开章节\n选中句子\n发送提示词',
    reproMode: 'always',
    severity: 'high',
    includeLogs: true,
    currentNovelId: 'novel-1',
    editorContext: {
      type: 'chapter',
      chapterId: 'chapter-001.md',
      title: '第一章',
      selectedText: '原句',
      selectionStart: 12,
      selectionEnd: 14,
      content: '这是一段正文',
    },
    activeThread: { id: 'thread-1', title: '测试线程', novelId: 'novel-1', updatedAt: '2026-05-15T00:00:00.000Z' },
    messages: [
      { id: 'm1', role: 'user', text: '请改写', timestamp: 1 },
      {
        id: 'tool-1',
        role: 'tool',
        name: 'replace_selected_text',
        status: 'done',
        result: JSON.stringify({
          message: '已替换当前章节中的 2 个字符',
          checkpoint: {
            kind: 'chapter',
            source: 'replace_selected_text',
            novelId: 'novel-1',
            chapterName: 'chapter-001.md',
            label: '第一章',
            beforeContent: '旧',
            afterContent: '新',
            restoreMode: 'write',
          },
          changedFiles: [{
            kind: 'chapter',
            novelId: 'novel-1',
            chapterName: 'chapter-001.md',
            label: '第一章',
            beforeContent: '旧',
            afterContent: '新',
            restoreMode: 'write',
          }],
        }),
        timestamp: 2,
      },
    ],
    status: 'idle',
    uiError: 'Frontend action failed',
    runtimeDriver: 'direct-api',
    providerType: 'anthropic',
    model: 'claude-sonnet',
    recentRendererLogs: [
      { timestamp: '2026-05-15T00:00:01.000Z', level: 'warn', source: 'renderer-console', message: 'warn message' },
      { timestamp: '2026-05-15T00:00:02.000Z', level: 'error', source: 'window-error', message: 'renderer boom' },
    ],
    includeScreenshot: true,
  });

  assert.equal(payload.userInput.feedbackMode, 'context-with-logs');
  assert.equal(payload.chatContext.activeThread.id, 'thread-1');
  assert.equal(payload.chatContext.recentToolCalls.length, 1);
  assert.equal(payload.changeContext.latestCheckpoint.chapterName, 'chapter-001.md');
  assert.equal(payload.changeContext.latestChangedFiles.length, 1);
  assert.equal(payload.errors.latestUiError, 'Frontend action failed');
  assert.equal(payload.errors.latestRendererError.message, 'renderer boom');
  assert.equal(payload.recentLogs.renderer.length, 2);
  assert.equal(payload.attachments[0].kind, 'window-screenshot');
});

test('CFP2_opinion_mode_omits_logs_and_sensitive_context', () => {
  const payload = buildQuickFeedbackPayload({
    issueTitle: '建议优化',
    actualBehavior: '想要更顺手的按钮',
    includeLogs: false,
    messages: [{ id: 'm1', role: 'user', text: 'hello', timestamp: 1 }],
    editorContext: { type: 'chapter', selectedText: '秘密', content: '整章正文' },
    status: 'idle',
  });

  assert.equal(payload.userInput.feedbackMode, 'opinion-only');
  assert.equal(payload.chatContext.recentMessages.length, 0);
  assert.equal(payload.changeContext.latestCheckpoint, null);
  assert.equal(payload.editorContext.selectionText, '');
  assert.equal(payload.editorContext.contentExcerpt, '');
  assert.equal(payload.recentLogs.renderer.length, 0);
  assert.equal(payload.attachments.length, 0);
});