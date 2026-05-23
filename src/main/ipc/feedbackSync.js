'use strict';

const { ipcMain } = require('electron');
const feedbackOutbox = require('../store/feedbackOutbox');

function getFeedbackSyncWorker() {
  return require('../index').getFeedbackSyncWorker();
}

function safeIpc(handler) {
  return async (event, ...args) => {
    try { return { ok: true, value: await handler(event, ...args) }; }
    catch (err) { return { ok: false, error: err.message || String(err) }; }
  };
}

function registerFeedbackSyncIpc() {
  ipcMain.handle('mana:feedback:listOutbox', safeIpc(async () => {
    const records = await feedbackOutbox.listAllRecords();
    return records.map((r) => ({
      feedbackId: r.feedbackId,
      createdAt: r.createdAt,
      status: r.status,
      syncStatus: r.syncStatus,
      retryCount: r.retryCount,
      issueTitle: r.payload?.userInput?.issueTitle || '未命名反馈',
      feedbackMode: r.payload?.userInput?.feedbackMode || 'opinion-only',
      lastError: r.lastError,
      remoteRecordId: r.remoteRecordId,
    }));
  }));

  ipcMain.handle('mana:feedback:getRecord', safeIpc(async (_event, { feedbackId }) => {
    return feedbackOutbox.getRecord(feedbackId);
  }));

  ipcMain.handle('mana:feedback:retrySync', safeIpc(async (_event, { feedbackId }) => {
    const worker = getFeedbackSyncWorker();
    if (!worker) throw new Error('Sync worker not initialized');
    return worker.retryRecord(feedbackId);
  }));

  ipcMain.handle('mana:feedback:triggerSync', safeIpc(async () => {
    const worker = getFeedbackSyncWorker();
    if (!worker) throw new Error('Sync worker not initialized');
    await worker.triggerSync();
    return { triggered: true };
  }));
}

module.exports = { registerFeedbackSyncIpc };
