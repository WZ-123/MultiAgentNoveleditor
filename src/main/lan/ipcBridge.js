'use strict';

const handlers = new Map();
let installed = false;
let originalHandle = null;

function install() {
  if (installed) return;
  const { ipcMain } = require('electron');
  originalHandle = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, listener) => {
    const result = originalHandle(channel, listener);
    handlers.set(channel, listener);
    return result;
  };
  installed = true;
}

function hasHandler(channel) {
  return handlers.has(channel);
}

async function invoke(channel, payload) {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`LAN RPC handler not registered: ${channel}`);
  return handler({ sender: null, lanRemote: true }, payload);
}

function listChannels() {
  return Array.from(handlers.keys()).sort();
}

module.exports = { install, invoke, hasHandler, listChannels };
