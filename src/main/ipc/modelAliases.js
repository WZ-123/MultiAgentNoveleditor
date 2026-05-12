'use strict';

const { ipcMain } = require('electron');
const modelAliases = require('../modelAliases');

function safeIpc(handler) {
  return async (event, ...args) => {
    try { return { ok: true, value: await handler(event, ...args) }; }
    catch (err) {
      console.error('[modelAliases ipc]', err);
      return { ok: false, error: err.message || String(err) };
    }
  };
}

function registerModelAliasesIpc() {
  ipcMain.handle('mana:modelAliases:list',          safeIpc(async () => modelAliases.list()));
  ipcMain.handle('mana:modelAliases:getAlias',        safeIpc(async (_e, { id }) => modelAliases.getAlias(id)));
  ipcMain.handle('mana:modelAliases:saveAlias',       safeIpc(async (_e, { alias }) => modelAliases.saveAlias(alias)));
  ipcMain.handle('mana:modelAliases:deleteAlias',     safeIpc(async (_e, { id }) => modelAliases.deleteAlias(id)));
  ipcMain.handle('mana:modelAliases:resetToDefaults', safeIpc(async () => modelAliases.resetToDefaults()));
}

module.exports = { registerModelAliasesIpc };
