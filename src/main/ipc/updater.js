'use strict';

const { ipcMain } = require('electron');
const { checkForUpdates } = require('../updater/versionChecker');

function safeIpc(handler) {
  return async (event, ...args) => {
    try {
      const value = await handler(event, ...args);
      return { ok: true, value };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  };
}

function registerUpdaterIpc() {
  if (ipcMain.eventNames().includes('mana:updater:checkNow')) return;

  ipcMain.handle('mana:updater:checkNow', safeIpc(async () => {
    return await checkForUpdates({ silent: false, force: true });
  }));
}

module.exports = { registerUpdaterIpc };
