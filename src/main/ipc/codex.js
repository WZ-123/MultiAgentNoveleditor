'use strict';

const { ipcMain, shell, webContents } = require('electron');
const { getCodexSessionService } = require('../codex-runtime');
const clientEvents = require('../events/clientEvents');

let registered = false;

function broadcast(channel, payload) {
  clientEvents.emit(channel, payload);
  for (const contents of webContents.getAllWebContents()) {
    if (!contents.isDestroyed()) contents.send(channel, payload);
  }
}

function safe(handler) {
  return async (_event, payload) => {
    try { return { ok: true, value: await handler(payload || {}) }; }
    catch (error) {
      console.error('[codex]', error?.code || '', error?.message || String(error));
      return {
        ok: false,
        error: error?.message || String(error),
        code: error?.code || 'codex_unavailable',
        details: error?.details || null,
        affectedResources: error?.affectedResources || error?.details?.affectedResources || [],
        savedResources: error?.savedResources || error?.details?.savedResources || [],
      };
    }
  };
}

function registerCodexIpc() {
  if (registered) return;
  registered = true;
  const service = getCodexSessionService();
  service.on('event', (payload) => {
    broadcast('mana:codex:event', payload);
    for (const resource of payload.committedResources || []) {
      if (!resource.resourceRef.startsWith('chapter:')) continue;
      broadcast('mana:chapter:changed', {
        novelId: payload.novelId,
        name: resource.resourceRef.slice('chapter:'.length),
        action: resource.mode === 'delete' ? 'delete' : 'update',
      });
    }
  });
  ipcMain.handle('mana:codex:status', safe(() => service.status()));
  ipcMain.handle('mana:codex:accountStatus', safe((payload) => service.accountStatus(payload)));
  ipcMain.handle('mana:codex:accountLogin', safe(async (payload) => {
    const result = await service.accountLogin(payload);
    const url = result.authUrl || result.verificationUrl;
    if (url) await shell.openExternal(url);
    return result;
  }));
  ipcMain.handle('mana:codex:accountCancel', safe((payload) => service.accountCancel(payload)));
  ipcMain.handle('mana:codex:accountLogout', safe(() => service.accountLogout()));
  ipcMain.handle('mana:codex:accountRateLimits', safe(() => service.accountRateLimits()));
  ipcMain.handle('mana:codex:refreshSubscriptionModels', safe(async (payload) => {
    const result = await service.refreshSubscriptionModels(payload);
    broadcast('mana:modelConfig:changed', { action: 'codex-subscription-models', changedAt: Date.now() });
    return result;
  }));
  ipcMain.handle('mana:codex:startTurn', safe((payload) => service.startTurn(payload)));
  ipcMain.handle('mana:codex:getConversationState', safe((payload) => service.getConversationState(payload)));
  ipcMain.handle('mana:codex:getRunState', safe((payload) => service.getRunState(payload)));
  ipcMain.handle('mana:codex:getResourceContext', safe((payload) => service.getResourceContext(payload)));
  ipcMain.handle('mana:codex:interrupt', safe((payload) => service.interrupt(payload)));
  ipcMain.handle('mana:codex:resolveConfirmation', safe((payload) => service.resolveConfirmation(payload)));
  ipcMain.handle('mana:codex:getWritingAuthorization', safe((payload) => service.getWritingAuthorization(payload)));
  ipcMain.handle('mana:codex:setWritingAuthorization', safe((payload) => service.setWritingAuthorization(payload)));
  ipcMain.handle('mana:codex:revokeWritingAuthorization', safe((payload) => service.revokeWritingAuthorization(payload)));
  ipcMain.handle('mana:codex:getWritingProgress', safe((payload) => service.getWritingProgress(payload)));
}

module.exports = { registerCodexIpc };
