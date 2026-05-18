'use strict';

const feedbackOutbox = require('../store/feedbackOutbox');
const syncLock = require('./syncLock');
const feishuAdapter = require('../feishu/feishuAdapter');
const fieldMapper = require('../feishu/fieldMapper');
const { RelayClient } = require('./relayClient');

const MAX_RETRIES = 10;
const BASE_DELAY_MS = 30_000;
const MAX_DELAY_MS = 3_600_000;
const SCAN_INTERVAL_MS = 60_000;

function computeNextRetryAt(retryCount) {
  const delay = Math.min(BASE_DELAY_MS * Math.pow(2, retryCount), MAX_DELAY_MS);
  return new Date(Date.now() + delay).toISOString();
}

function classifyError(err) {
  const feishuErr = err?.feishuError;
  if (!feishuErr) {
    // Network / timeout errors without feishuError wrapper
    const msg = err?.message || String(err);
    if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ENETUNREACH/.test(msg)) {
      return { type: 'retryable', code: 'network_error', message: msg };
    }
    return { type: 'retryable', code: 'unknown', message: msg };
  }
  return feishuErr;
}

class FeedbackSyncWorker {
  constructor() {
    this._config = null;
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
    const c = this._config;
    if (c.relayUrl && c.relayApiKey) return true;
    if (c.appId && c.appSecret && c.appToken && c.tableId) return true;
    return false;
  }

  _useRelay() {
    return !!(this._config?.relayUrl && this._config?.relayApiKey);
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

    const useRelay = this._useRelay();
    let relayClient = null;
    if (useRelay) {
      relayClient = new RelayClient({
        relayUrl: this._config.relayUrl,
        relayApiKey: this._config.relayApiKey,
      });
    }

    try {
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

      let token = null;
      if (!useRelay) {
        const tokenResult = await feishuAdapter.getTenantAccessToken(
          this._config.appId,
          this._config.appSecret
        );
        token = tokenResult.token;
      }

      // Upload attachments with compensation
      let attachmentTokens = Array.isArray(fresh.remoteAttachmentTokens)
        ? [...fresh.remoteAttachmentTokens]
        : [];
      const screenshotAttachment = fresh.payload?.attachments?.find(
        (a) => a.kind === 'window-screenshot' && a.localPath
      );

      if (screenshotAttachment && attachmentTokens.length === 0) {
        try {
          let uploadResult;
          if (useRelay) {
            uploadResult = await relayClient.uploadAttachment(screenshotAttachment.localPath);
          } else {
            uploadResult = await feishuAdapter.uploadAttachment(
              this._config.appToken,
              screenshotAttachment.localPath,
              token
            );
          }
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
            lastError: err.message,
            lastErrorCode: classified.code,
          });
          return;
        }
      }

      // Build fields
      const fields = fieldMapper.toBitableFields(fresh);

      // Add attachments to fields only in direct mode (relay server handles this)
      if (!useRelay && attachmentTokens.length > 0) {
        fields.screenshot = fieldMapper.toAttachmentField(attachmentTokens);
      }

      // Create or update record with compensation
      let remoteRecordId = fresh.remoteRecordId;
      if (!remoteRecordId) {
        try {
          let createResult;
          if (useRelay) {
            createResult = await relayClient.createRecord(feedbackId, fields, attachmentTokens);
          } else {
            createResult = await feishuAdapter.createRecord(
              this._config.appToken,
              this._config.tableId,
              token,
              fields
            );
          }
          remoteRecordId = createResult.recordId;
        } catch (err) {
          const classified = classifyError(err);
          await feedbackOutbox.updateSyncMeta(feedbackId, {
            syncStatus: classified.type === 'retryable' ? 'retryable_failed' : 'failed_terminal',
            retryCount: retryCount + 1,
            nextRetryAt: computeNextRetryAt(retryCount),
            lastError: err.message,
            lastErrorCode: classified.code,
          });
          return;
        }
      } else {
        // Record already exists, update attachments only
        try {
          if (useRelay) {
            await relayClient.updateRecord(feedbackId, remoteRecordId, fields, attachmentTokens);
          } else {
            await feishuAdapter.updateRecord(
              this._config.appToken,
              this._config.tableId,
              remoteRecordId,
              token,
              { screenshot: fieldMapper.toAttachmentField(attachmentTokens) }
            );
          }
        } catch (err) {
          const classified = classifyError(err);
          await feedbackOutbox.updateSyncMeta(feedbackId, {
            syncStatus: classified.type === 'retryable' ? 'retryable_failed' : 'failed_terminal',
            retryCount: retryCount + 1,
            nextRetryAt: computeNextRetryAt(retryCount),
            lastError: err.message,
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
        remoteTableId: useRelay ? 'relay' : this._config.tableId,
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
        lastError: err.message,
        lastErrorCode: classified.code,
      });
    } finally {
      syncLock.release(feedbackId);
    }
  }
}

module.exports = { FeedbackSyncWorker, computeNextRetryAt, classifyError };
