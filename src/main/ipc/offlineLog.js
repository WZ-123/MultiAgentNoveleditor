'use strict';

const { ipcMain } = require('electron');
const offlineLog = require('../store/offlineLog');

function safeIpc(handler) {
  return async (event, ...args) => {
    try {
      return { ok: true, value: await handler(event, ...args) };
    } catch (err) {
      console.error('[offlineLog ipc]', err);
      return { ok: false, error: err.message || String(err) };
    }
  };
}

function registerOfflineLogIpc() {
  ipcMain.handle('mana:offlineLog:appendEntry', safeIpc(async (_e, entry) => {
    return offlineLog.appendEntry(entry);
  }));

  ipcMain.handle('mana:offlineLog:listUnsynced', safeIpc(async (_e, { novelId }) => {
    return offlineLog.listUnsyncedEntries(novelId);
  }));

  ipcMain.handle('mana:offlineLog:listUnsyncedByType', safeIpc(async (_e, { novelId }) => {
    return offlineLog.listUnsyncedByType(novelId);
  }));

  ipcMain.handle('mana:offlineLog:markSynced', safeIpc(async (_e, { entryIds }) => {
    return offlineLog.markSynced(entryIds);
  }));

  ipcMain.handle('mana:offlineLog:discardUnsynced', safeIpc(async (_e, { novelId }) => {
    return offlineLog.discardUnsynced(novelId);
  }));

  ipcMain.handle('mana:offlineLog:getStorageStats', safeIpc(async () => offlineLog.getStorageStats()));

  ipcMain.handle('mana:offlineLog:enforceQuota', safeIpc(async (_e, { maxBytes }) => {
    return offlineLog.enforceQuota(maxBytes);
  }));
}

module.exports = { registerOfflineLogIpc };
