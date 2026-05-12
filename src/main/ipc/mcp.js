'use strict';

const { ipcMain } = require('electron');
const mcpClient = require('../mcp/mcpClientStdio');

function safeIpc(handler) {
  return async (event, ...args) => {
    try { return { ok: true, value: await handler(event, ...args) }; }
    catch (err) { return { ok: false, error: err.message || String(err) }; }
  };
}

function registerMcpIpc() {
  ipcMain.handle('mana:mcp:listTools', safeIpc(async () => mcpClient.listTools()));

  // Direct UI invocation (no LLM in the loop). autoConfirm defaults true so
  // the UI never has to confirm a tool it itself triggered.
  ipcMain.handle('mana:mcp:callTool', safeIpc(async (_e, { name, args }) => {
    return mcpClient.callTool({ name, arguments: args, autoConfirm: true });
  }));
}

module.exports = { registerMcpIpc };
