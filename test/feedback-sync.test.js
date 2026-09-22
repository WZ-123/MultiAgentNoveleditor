const assert = require('node:assert/strict');
const fs = require('node:fs').promises;
const path = require('node:path');
const os = require('node:os');

const tempRoot = path.join(os.tmpdir(), `mana-sync-${Date.now()}`);
process.env.MANA_USER_DATA_ROOT = tempRoot;

const feedbackOutbox = require('../src/main/store/feedbackOutbox');
const { computeNextRetryAt, classifyError } = require('../src/main/sync/feedbackSyncWorker');
const fieldMapper = require('../src/main/feishu/fieldMapper');
const syncLock = require('../src/main/sync/syncLock');

let _testChain = Promise.resolve();

function test(name, fn) {
  _testChain = _testChain
    .then(fn)
    .then(() => {
      console.log(`PASS ${name}`);
    })
    .catch((err) => {
      console.error(`FAIL ${name}: ${err.message || err}`);
      process.exitCode = 1;
    });
}

test('FS1_submitFeedback_has_sync_metadata', async () => {
  const result = await feedbackOutbox.submitFeedback({
    feedbackId: 'fb-test-sync-1',
    createdAt: '2026-05-16T00:00:00.000Z',
    userInput: { issueTitle: 'Sync test', feedbackMode: 'context-with-logs' },
    environment: {},
  });

  assert.equal(result.syncStatus, 'pending');

  const record = await feedbackOutbox.getRecord('fb-test-sync-1');
  assert.equal(record.syncStatus, 'pending');
  assert.equal(record.retryCount, 0);
  assert.equal(record.lastSendAttemptAt, null);
  assert.equal(record.remoteRecordId, null);
  assert.equal(record.remoteTableId, null);
  assert.deepEqual(record.remoteAttachmentTokens, []);
  assert.equal(record.endpointProfile, 'dev');
});

test('FS2_updateSyncMeta_updates_status_and_index', async () => {
  await feedbackOutbox.submitFeedback({
    feedbackId: 'fb-test-sync-2',
    userInput: { issueTitle: 'Update test' },
  });

  const updated = await feedbackOutbox.updateSyncMeta('fb-test-sync-2', {
    syncStatus: 'syncing',
    retryCount: 1,
    lastError: 'Network timeout',
  });

  assert.equal(updated.syncStatus, 'syncing');
  assert.equal(updated.retryCount, 1);
  assert.equal(updated.lastError, 'Network timeout');

  const index = await feedbackOutbox.readIndex();
  const item = index.items.find((i) => i.feedbackId === 'fb-test-sync-2');
  assert.ok(item);
  assert.equal(item.syncStatus, 'syncing');
});

test('FS3_listPendingForSync_filters_correctly', async () => {
  // pending record
  await feedbackOutbox.submitFeedback({
    feedbackId: 'fb-test-sync-3a',
    userInput: { issueTitle: 'Pending A' },
  });

  // retryable_failed with nextRetryAt in the past
  await feedbackOutbox.submitFeedback({
    feedbackId: 'fb-test-sync-3b',
    userInput: { issueTitle: 'Retryable B' },
  });
  await feedbackOutbox.updateSyncMeta('fb-test-sync-3b', {
    syncStatus: 'retryable_failed',
    nextRetryAt: '2020-01-01T00:00:00.000Z',
  });

  // retryable_failed with nextRetryAt in the future
  await feedbackOutbox.submitFeedback({
    feedbackId: 'fb-test-sync-3c',
    userInput: { issueTitle: 'Future C' },
  });
  await feedbackOutbox.updateSyncMeta('fb-test-sync-3c', {
    syncStatus: 'retryable_failed',
    nextRetryAt: '2099-01-01T00:00:00.000Z',
  });

  // sent record
  await feedbackOutbox.submitFeedback({
    feedbackId: 'fb-test-sync-3d',
    userInput: { issueTitle: 'Sent D' },
  });
  await feedbackOutbox.updateSyncMeta('fb-test-sync-3d', { syncStatus: 'sent' });

  const pending = await feedbackOutbox.listPendingForSync();
  const ids = pending.map((r) => r.feedbackId);

  assert.ok(ids.includes('fb-test-sync-3a'), 'Should include pending');
  assert.ok(ids.includes('fb-test-sync-3b'), 'Should include retryable with past nextRetryAt');
  assert.ok(!ids.includes('fb-test-sync-3c'), 'Should exclude future retryable');
  assert.ok(!ids.includes('fb-test-sync-3d'), 'Should exclude sent');
});

test('FS4_recoverStuckSyncing_resets_to_pending', async () => {
  await feedbackOutbox.submitFeedback({
    feedbackId: 'fb-test-sync-4',
    userInput: { issueTitle: 'Stuck' },
  });
  await feedbackOutbox.updateSyncMeta('fb-test-sync-4', { syncStatus: 'syncing' });

  const recovered = await feedbackOutbox.recoverStuckSyncing();
  // There may be other stuck records from previous tests in the shared temp dir
  assert.ok(recovered >= 1, `Expected at least 1 recovered, got ${recovered}`);

  const record = await feedbackOutbox.getRecord('fb-test-sync-4');
  assert.equal(record.syncStatus, 'pending');
});

test('FS5_computeNextRetryAt_exponential_backoff', () => {
  const t0 = computeNextRetryAt(0);
  const t1 = computeNextRetryAt(1);
  const t5 = computeNextRetryAt(5);
  const t10 = computeNextRetryAt(10);

  const d0 = new Date(t0).getTime() - Date.now();
  const d1 = new Date(t1).getTime() - Date.now();
  const d5 = new Date(t5).getTime() - Date.now();
  const d10 = new Date(t10).getTime() - Date.now();

  assert.ok(d0 >= 30_000 && d0 <= 30_500, `Backoff 0 should be ~30s, got ${d0}`);
  assert.ok(d1 >= 60_000 && d1 <= 60_500, `Backoff 1 should be ~60s, got ${d1}`);
  assert.ok(d5 >= 960_000 && d5 <= 960_500, `Backoff 5 should be ~960s, got ${d5}`);
  assert.ok(d10 >= 3_600_000 && d10 <= 3_600_500, `Backoff 10 should cap at 1h, got ${d10}`);
});

test('FS6_classifyError_network_errors', () => {
  const network = classifyError(new Error('ECONNREFUSED'));
  assert.equal(network.type, 'retryable');
  assert.equal(network.code, 'relay_unreachable');
  assert.equal(network.userAction, 'retry');

  const dns = classifyError(new Error('ENOTFOUND open.feishu.cn'));
  assert.equal(dns.type, 'retryable');
  assert.equal(dns.code, 'relay_unreachable');
  assert.equal(dns.reasonKind, 'dns');
});

test('FS7_classifyError_feishu_errors', () => {
  const rateLimited = { feishuError: { type: 'retryable', code: 'rate_limited', message: 'Too many requests' } };
  assert.equal(classifyError(rateLimited).code, 'rate_limited');

  const authFailed = { feishuError: { type: 'terminal', code: 'auth_failed', message: 'Bad app_id' } };
  assert.equal(classifyError(authFailed).code, 'auth_failed');
});

test('FS8_fieldMapper_maps_payload_correctly', () => {
  const record = {
    syncStatus: 'pending',
    payload: {
      feedbackId: 'fb-123',
      createdAt: '2026-05-16T00:00:00Z',
      userInput: {
        issueTitle: 'Test title',
        actualBehavior: 'Something broke',
        feedbackMode: 'context-with-logs',
        severity: 'high',
      },
      environment: {
        appVersion: '1.0.0',
        platform: 'darwin',
        activeRuntimeDriver: 'direct-api',
        activeProviderType: 'anthropic',
        activeModel: 'claude-sonnet',
      },
      novelContext: { activeNovelId: 'novel-1' },
      editorContext: { activeChapterName: 'chapter-1.md' },
      chatContext: {
        activeThread: { id: 'thread-1' },
        currentSessionId: 'session-1',
      },
      errors: {
        latestUiError: 'UI error message',
        latestMainProcessError: { message: 'Main process error' },
        latestChatAgentError: { message: 'Chat agent error' },
      },
    },
  };

  const fields = fieldMapper.toBitableFields(record);

  assert.equal(fields.feedbackId, 'fb-123');
  assert.equal(fields.createdAt, '2026-05-16 08:00:00 +08:00');
  assert.equal(fields.issueTitle, 'Test title');
  assert.equal(fields.severity, 'high');
  assert.equal(fields.platform, 'darwin');
  assert.equal(fields.activeNovelId, 'novel-1');
  assert.equal(fields.activeThreadId, 'thread-1');
  assert.ok(fields.payloadJson);
  assert.ok(JSON.parse(fields.payloadJson));
});

test('FS9_syncLock_acquire_release', () => {
  syncLock.clearAll();

  assert.equal(syncLock.acquire('key1'), true);
  assert.equal(syncLock.acquire('key1'), false);
  assert.equal(syncLock.isLocked('key1'), true);

  syncLock.release('key1');
  assert.equal(syncLock.isLocked('key1'), false);
  assert.equal(syncLock.acquire('key1'), true);
});

test('FS10_fieldMapper_attachment_field', () => {
  const result = fieldMapper.toAttachmentField(['token-a', 'token-b']);
  assert.deepEqual(result, [{ file_token: 'token-a' }, { file_token: 'token-b' }]);
});
