'use strict';

const { ipcMain, dialog, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const fsp = fs.promises;

function safeIpc(handler) {
  return async (event, ...args) => {
    try {
      return { ok: true, value: await handler(event, ...args) };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  };
}

function getWindow(event) {
  return BrowserWindow.fromWebContents(event.sender) || BrowserWindow.getFocusedWindow();
}

function registerFsIpc() {
  ipcMain.handle('mana:fs:readFile', safeIpc(async (_e, { filePath, encoding = 'utf8' }) => {
    return fsp.readFile(filePath, encoding);
  }));
  ipcMain.handle('mana:fs:writeFile', safeIpc(async (_e, { filePath, content, encoding = 'utf8' }) => {
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    return fsp.writeFile(filePath, content, encoding);
  }));
  ipcMain.handle('mana:fs:readJson', safeIpc(async (_e, { filePath, fallback = null }) => {
    try {
      const t = await fsp.readFile(filePath, 'utf8');
      return JSON.parse(t);
    } catch (err) {
      if (err.code === 'ENOENT') return fallback;
      throw err;
    }
  }));
  ipcMain.handle('mana:fs:writeJson', safeIpc(async (_e, { filePath, data }) => {
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    await fsp.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
  }));
  ipcMain.handle('mana:fs:appendJsonl', safeIpc(async (_e, { filePath, line }) => {
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    return fsp.appendFile(filePath, JSON.stringify(line) + '\n', 'utf8');
  }));
  ipcMain.handle('mana:fs:listDir', safeIpc(async (_e, { dir }) => {
    try {
      const items = await fsp.readdir(dir, { withFileTypes: true });
      return items.map((d) => ({ name: d.name, isDirectory: d.isDirectory(), isFile: d.isFile() }));
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
  }));
  ipcMain.handle('mana:fs:ensureDir', safeIpc(async (_e, { dir }) => {
    await fsp.mkdir(dir, { recursive: true });
  }));
  ipcMain.handle('mana:fs:pathExists', safeIpc(async (_e, { path: p }) => {
    try { await fsp.access(p); return true; } catch { return false; }
  }));
  ipcMain.handle('mana:fs:deleteFile', safeIpc(async (_e, { filePath }) => {
    await fsp.unlink(filePath);
    return { deleted: true };
  }));
  ipcMain.handle('mana:fs:pickDirectory', safeIpc(async (event, { title } = {}) => {
    const win = getWindow(event);
    const result = await dialog.showOpenDialog(win, {
      title: title || 'Choose directory',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || !result.filePaths.length) return null;
    return result.filePaths[0];
  }));
  ipcMain.handle('mana:fs:pickFile', safeIpc(async (event, { title, filters } = {}) => {
    const win = getWindow(event);
    const result = await dialog.showOpenDialog(win, {
      title: title || 'Choose file',
      properties: ['openFile'],
      filters: filters || undefined,
    });
    if (result.canceled || !result.filePaths.length) return null;
    return result.filePaths[0];
  }));
}

module.exports = { registerFsIpc };
