'use strict';

const feedbackOutbox = require('../store/feedbackOutbox');
const syncLock = require('./syncLock');
const fieldMapper = require('../feishu/fieldMapper');
const { RelayClient } = require('./relayClient');
const { getSessionManager } = require('../license/sessionManager');
const { normalizeAppError } = require('../appError');

const MAX_RETRIES = 10;
const BASE_DELAY_MS = 30_000;
const MAX_DELAY_MS = 3_600_000;
const SCAN_INTERVAL_MS = 60_000;

function computeNextRetryAt(retryCount) {
  const delay = Math.min(BASE_DELAY_MS * Math.pow(2, retryCount), MAX_DELAY_MS);
  return new Date(Date.now() + delay).toISOString();
}

function classifyError(err) {
  const normalized = err?.appError || err?.relayError || err?.feishuError || normalizeAppError(err, { domain: 'relay', phase: 'feedback_sync' });
  return { ...normalized, type: normalized.retryable === false ? 'terminal' : 'retryable' };
}

class FeedbackSyncWorker {
  constructor(options = {}) {
    this._config = null;
    this._sessionManager = options.sessionManager || getSessionManager();
    this._running = false;
    this._timer = null;
    this._scanning = false;
  }

  setConfig(config) {
    this._config = config;
  }

  start() {
    if (this._running) return;
    this._running = true;
    // Recover records stuck in syncing from previous crash
    this._recoverStuckRecords();
    // Initial scan after a short delay
    setTimeout(() => this._scan(), 5_000);
    this._timer = setInterval(() => this._scan(), SCAN_INTERVAL_MS);
  }

  stop() {
    this._running = false;
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    syncLock.clearAll();
  }

  async triggerSync() {
    return this._scan();
  }

  async retryRecord(feedbackId) {
    const record = await feedbackOutbox.getRecord(feedbackId);
    if (!record) return { ok: false, error: 'Record not found' };
    if (record.syncStatus === 'sent') return { ok: false, error: 'Already sent' };
    // Reset retry count and status for manual retry
    await feedbackOutbox.updateSyncMeta(feedbackId, {
      syncStatus: 'pending',
      retryCount: 0,
      nextRetryAt: null,
      lastError: null,
      lastErrorCode: null,
    });
    // Process immediately
    await this._processRecord(record);
    return { ok: true };
  }

  async _recoverStuckRecords() {
    try {
      const recovered = await feedbackOutbox.recoverStuckSyncing();
      if (recovered > 0) {
        console.log(`[feedbackSync] Recovered ${recovered} record(s) stuck in syncing`);
      }
    } catch (err) {
      console.error('[feedbackSync] Failed to recover stuck records:', err.message);
    }
  }

  _hasValidConfig() {
    return this._config?.enabled !== false;
  }

  async _scan() {
    if (!this._running || this._scanning) return;
    if (!this._hasValidConfig()) return;

    this._scanning = true;
    try {
      const pending = await feedbackOutbox.listPendingForSync();
      if (pending.length > 0) {
        console.log(`[feedbackSync] Scanning ${pending.length} pending record(s)`);
      }
      for (const record of pending) {
        if (!this._running) break;
        await this._processRecord(record);
      }
    } catch (err) {
      console.error('[feedbackSync] Scan failed:', err.message);
    } finally {
      this._scanning = false;
    }
  }

  async _processRecord(record) {
    const feedbackId = record.feedbackId;
    if (!syncLock.acquire(feedbackId)) return;

    try {
      const relayUrl = await this._sessionManager.getRelayBaseUrl();
      const relayClient = new RelayClient({
        relayUrl,
        getAccessToken: (scope, options) => this._sessionManager.getAccessToken(scope, options),
      });
      // Re-read record to ensure we have the latest state
      const fresh = await feedbackOutbox.getRecord(feedbackId);
      if (!fresh || fresh.syncStatus === 'sent' || fresh.syncStatus === 'syncing') {
        return;
      }

      const retryCount = (fresh.retryCount || 0);
      if (retryCount >= MAX_RETRIES) {
        await feedbackOutbox.updateSyncMeta(feedbackId, {
          syncStatus: 'failed_terminal',
          lastError: 'Max retries exceeded',
          lastErrorCode: 'max_retries',
        });
        return;
      }

      // Mark as syncing
      await feedbackOutbox.updateSyncMeta(feedbackId, {
        syncStatus: 'syncing',
        lastSendAttemptAt: new Date().toISOString(),
      });

      // Upload attachments with compensation
      let attachmentTokens = Array.isArray(fresh.remoteAttachmentTokens)
        ? [...fresh.remoteAttachmentTokens]
        : [];
      const screenshotAttachment = fresh.payload?.attachments?.find(
        (a) => a.kind === 'window-screenshot' && a.localPath
      );

      if (screenshotAttachment && attachmentTokens.length === 0) {
        try {
          const uploadResult = await relayClient.uploadAttachment(screenshotAttachment.localPath, feedbackId);
          attachmentTokens.push(uploadResult.fileToken);
          // Save tokens immediately so we don't re-upload on retry
          await feedbackOutbox.updateSyncMeta(feedbackId, {
            remoteAttachmentTokens: attachmentTokens,
          });
        } catch (err) {
          const classified = classifyError(err);
          await feedbackOutbox.updateSyncMeta(feedbackId, {
            syncStatus: classified.type === 'retryable' ? 'retryable_failed' : 'failed_terminal',
            retryCount: retryCount + 1,
            nextRetryAt: computeNextRetryAt(retryCount),
            lastError: classified.message,
            lastErrorCode: classified.code,
          });
          return;
        }
      }

      // Build fields
      const fields = fieldMapper.toBitableFields(fresh);

      // Create or update record with compensation
      let remoteRecordId = fresh.remoteRecordId;
      if (!remoteRecordId) {
        try {
          const createResult = await relayClient.createRecord(feedbackId, fields, attachmentTokens);
          remoteRecordId = createResult.recordId;
        } catch (err) {
          const classified = classifyError(err);
          await feedbackOutbox.updateSyncMeta(feedbackId, {
            syncStatus: classified.type === 'retryable' ? 'retryable_failed' : 'failed_terminal',
            retryCount: retryCount + 1,
            nextRetryAt: computeNextRetryAt(retryCount),
            lastError: classified.message,
            lastErrorCode: classified.code,
          });
          return;
        }
      } else {
        // Record already exists, update attachments only
        try {
          await relayClient.updateRecord(feedbackId, remoteRecordId, fields, attachmentTokens);
        } catch (err) {
          const classified = classifyError(err);
          await feedbackOutbox.updateSyncMeta(feedbackId, {
            syncStatus: classified.type === 'retryable' ? 'retryable_failed' : 'failed_terminal',
            retryCount: retryCount + 1,
            nextRetryAt: computeNextRetryAt(retryCount),
            lastError: classified.message,
            lastErrorCode: classified.code,
          });
          return;
        }
      }

      // Success
      await feedbackOutbox.updateSyncMeta(feedbackId, {
        syncStatus: 'sent',
        retryCount,
        lastSendSucceededAt: new Date().toISOString(),
        nextRetryAt: null,
        lastError: null,
        lastErrorCode: null,
        remoteRecordId,
        remoteTableId: 'relay',
        remoteAttachmentTokens: attachmentTokens,
      });

      console.log(`[feedbackSync] Sent feedback ${feedbackId} to Feishu record ${remoteRecordId}`);
    } catch (err) {
      console.error(`[feedbackSync] Failed to process ${feedbackId}:`, err.message);
      const classified = classifyError(err);
      const retryCount = (record.retryCount || 0);
      await feedbackOutbox.updateSyncMeta(feedbackId, {
        syncStatus: classified.type === 'retryable' ? 'retryable_failed' : 'failed_terminal',
        retryCount: retryCount + 1,
        nextRetryAt: computeNextRetryAt(retryCount),
        lastError: classified.message,
        lastErrorCode: classified.code,
      });
    } finally {
      syncLock.release(feedbackId);
    }
  }
}

module.exports = { FeedbackSyncWorker, computeNextRetryAt, classifyError };
