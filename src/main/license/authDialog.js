'use strict';

const { BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const { getSessionManager } = require('./sessionManager');
const { normalizeAppError } = require('../appError');

const VERIFY_CHANNEL = 'mana:auth:verify';
const QUIT_CHANNEL = 'mana:auth:quit';

function createAuthDialog() {
  const win = new BrowserWindow({
    width: 400,
    height: 280,
    resizable: false,
    minimizable: false,
    maximizable: false,
    closable: true,
    show: false,
    center: true,
    title: '授权验证',
    webPreferences: {
      preload: path.join(__dirname, 'authDialogPreload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  win.setMenuBarVisibility(false);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, target) => {
    if (target !== win.webContents.getURL()) event.preventDefault();
  });
  void win.loadFile(path.join(__dirname, 'auth-dialog.html'));
  return win;
}

function showAuthDialog() {
  return new Promise((resolve, reject) => {
    try { ipcMain.removeHandler(VERIFY_CHANNEL); } catch {}
    try { ipcMain.removeAllListeners(QUIT_CHANNEL); } catch {}
    const win = createAuthDialog();
    let settled = false;

    function isTrusted(event) {
      return !win.isDestroyed()
        && event.sender.id === win.webContents.id
        && event.senderFrame === win.webContents.mainFrame;
    }

    function finish(callback, value) {
      if (settled) return;
      settled = true;
      try { ipcMain.removeHandler(VERIFY_CHANNEL); } catch {}
      try { ipcMain.removeAllListeners(QUIT_CHANNEL); } catch {}
      callback(value);
    }

    ipcMain.handle(VERIFY_CHANNEL, async (event, payload = {}) => {
      if (!isTrusted(event)) return { valid: false, reason: 'tool_scope_denied', message: '授权窗口来源无效。' };
      const authCode = String(payload.authCode || '').trim();
      if (!authCode || authCode.length > 256) return { valid: false, reason: 'invalid_request', message: '请输入有效授权码。' };
      const result = await getSessionManager().exchange({ authCode }).catch((error) => {
        const normalized = normalizeAppError(error, { domain: 'auth', phase: 'auth_dialog' });
        return { valid: false, reason: normalized.code, message: normalized.message, error: normalized };
      });
      if (result.valid) {
        finish(resolve, result);
        if (!win.isDestroyed()) win.close();
      }
      return result;
    });

    ipcMain.on(QUIT_CHANNEL, (event) => {
      if (!isTrusted(event)) return;
      finish(reject, Object.assign(new Error('user_quit'), { code: 'user_quit' }));
      if (!win.isDestroyed()) win.close();
    });

    win.once('closed', () => finish(reject, Object.assign(new Error('user_closed'), { code: 'user_closed' })));
    win.once('ready-to-show', () => { win.show(); win.focus(); });
  });
}

module.exports = { createAuthDialog, showAuthDialog };
