'use strict';

const { ipcMain } = require('electron');
const providerManager = require('../providerManager');

function safeIpc(handler) {
  return async (event, ...args) => {
    try { return { ok: true, value: await handler(event, ...args) }; }
    catch (err) {
      console.error('[providerManager ipc]', err);
      return { ok: false, error: err.message || String(err) };
    }
  };
}

function registerProviderManagerIpc() {
  ipcMain.handle('mana:provider:detect',        safeIpc(async () => providerManager.detect()));
  ipcMain.handle('mana:provider:list',          safeIpc(async () => providerManager.list()));
  ipcMain.handle('mana:provider:current',       safeIpc(async () => providerManager.current()));
  ipcMain.handle('mana:provider:use',           safeIpc(async (_e, { name }) => providerManager.use(name)));
  ipcMain.handle('mana:provider:add',           safeIpc(async (_e, payload) => providerManager.add(payload || {})));
  ipcMain.handle('mana:provider:remove',        safeIpc(async (_e, { name }) => providerManager.remove(name)));
  ipcMain.handle('mana:provider:getProvider',   safeIpc(async (_e, { id }) => providerManager.getProvider(id)));
  ipcMain.handle('mana:provider:addModel',      safeIpc(async (_e, { providerId, model }) => providerManager.addModel(providerId, model)));
  ipcMain.handle('mana:provider:removeModel',   safeIpc(async (_e, { providerId, modelId }) => providerManager.removeModel(providerId, modelId)));
  ipcMain.handle('mana:provider:discoverModels', safeIpc(async (_e, { providerId }) => providerManager.discoverModels(providerId)));
}

module.exports = { registerProviderManagerIpc };
