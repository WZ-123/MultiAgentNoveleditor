'use strict';

const { ipcMain } = require('electron');
const appConfig = require('../store/appConfig');
const lanRemote = require('../lan/remoteServer');

function safeIpc(handler) {
  return async (event, ...args) => {
    try {
      return { ok: true, value: await handler(event, ...args) };
    } catch (err) {
      console.error('[lanRemote ipc]', err);
      return { ok: false, error: err.message || String(err) };
    }
  };
}

function normalizePort(port) {
  const n = Number(port || lanRemote.DEFAULT_PORT);
  if (!Number.isFinite(n)) return lanRemote.DEFAULT_PORT;
  return Math.min(65535, Math.max(1024, Math.trunc(n)));
}

function registerLanRemoteIpc() {
  ipcMain.handle('mana:lan:getStatus', safeIpc(async () => {
    const cfg = await appConfig.load();
    return {
      ...lanRemote.getStatus(),
      configured: cfg.lanRemote || {},
    };
  }));

  ipcMain.handle('mana:lan:setEnabled', safeIpc(async (_event, { enabled, port } = {}) => {
    const cfg = await appConfig.load();
    const lanConfig = {
      ...(cfg.lanRemote || {}),
      enabled: enabled === true,
      port: normalizePort(port ?? cfg.lanRemote?.port),
    };
    await appConfig.save({ lanRemote: lanConfig });
    const status = await lanRemote.applyConfig(lanConfig);
    return {
      ...status,
      configured: lanConfig,
    };
  }));

  ipcMain.handle('mana:lan:rotateCode', safeIpc(async () => {
    const cfg = await appConfig.load();
    return {
      ...lanRemote.rotateCode(),
      configured: cfg.lanRemote || {},
    };
  }));
}

module.exports = { registerLanRemoteIpc };
