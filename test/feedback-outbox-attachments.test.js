const assert = require('node:assert/strict');
const fs = require('node:fs').promises;
const path = require('node:path');
const os = require('node:os');

const tempRoot = path.join(os.tmpdir(), `mana-feedback-${Date.now()}`);
process.env.MANA_USER_DATA_ROOT = tempRoot;

const feedbackOutbox = require('../src/main/store/feedbackOutbox');
const recentLogBuffer = require('../src/main/store/recentLogBuffer');

function test(name, fn) {
  Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(`PASS ${name}`);
    })
    .catch((err) => {
      console.error(`FAIL ${name}: ${err.message || err}`);
      process.exitCode = 1;
    });
}

test('FOA1_submitFeedback_persists_screenshot_attachment', async () => {
  const result = await feedbackOutbox.submitFeedback({
    feedbackId: 'fb-test-1',
    createdAt: '2026-05-15T00:00:00.000Z',
    userInput: { issueTitle: '截图反馈' },
    environment: {},
  }, {
    attachments: [{
      kind: 'window-screenshot',
      label: '当前窗口截图',
      fileName: 'screenshot.png',
      mimeType: 'image/png',
      data: Buffer.from('fake-png'),
    }],
  });

  assert.equal(result.attachments.length, 1);
  const saved = JSON.parse(await fs.readFile(result.savedTo, 'utf8'));
  assert.equal(saved.payload.attachments.length, 1);
  assert.equal(saved.payload.attachments[0].fileName, 'screenshot.png');
  const attachmentContent = await fs.readFile(saved.payload.attachments[0].localPath, 'utf8');
  assert.equal(attachmentContent, 'fake-png');
});

test('FOA2_recentLogBuffer_captures_chatAgent_errors', async () => {
  recentLogBuffer._resetForTests();
  recentLogBuffer.appendEntry({ level: 'error', source: 'chatAgent', message: '[chatAgent] tool failed' });
  recentLogBuffer.appendEntry({ level: 'warn', source: 'main', message: '[main] warning' });
  const snapshot = recentLogBuffer.getFeedbackLogSnapshot();
  assert.equal(snapshot.latestChatAgentError.message, '[chatAgent] tool failed');
  assert.equal(snapshot.recentMainLogs.length, 1);
});