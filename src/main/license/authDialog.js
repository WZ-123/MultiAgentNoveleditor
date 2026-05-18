'use strict';

const { BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const { verifyLicense } = require('./authVerifier');
const appConfig = require('../store/appConfig');

const DIALOG_HTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>授权验证</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  background: #1e1e1e; color: #cccccc;
  display: flex; align-items: center; justify-content: center;
  height: 100vh; overflow: hidden;
}
.container { width: 340px; padding: 24px; }
h2 { font-size: 16px; margin-bottom: 8px; color: #ffffff; }
.sub { font-size: 12px; color: #888; margin-bottom: 16px; line-height: 1.5; }
input {
  width: 100%; padding: 8px 12px; background: #252526; border: 1px solid #3c3c3c;
  color: #cccccc; border-radius: 4px; font-size: 14px; outline: none; margin-bottom: 12px;
}
input:focus { border-color: #007acc; }
.error {
  font-size: 12px; color: #f48771; margin-bottom: 12px; min-height: 18px;
}
.btn-row { display: flex; gap: 8px; justify-content: flex-end; }
button {
  padding: 6px 16px; border: none; border-radius: 4px; cursor: pointer; font-size: 13px;
}
.primary { background: #007acc; color: white; }
.primary:disabled { background: #3c3c3c; color: #888; cursor: not-allowed; }
.secondary { background: #3c3c3c; color: #cccccc; }
.spinner {
  display: inline-block; width: 12px; height: 12px;
  border: 2px solid rgba(255,255,255,0.3); border-top-color: #fff;
  border-radius: 50%; animation: spin 0.8s linear infinite; margin-right: 6px; vertical-align: middle;
}
@keyframes spin { to { transform: rotate(360deg); } }
</style>
</head>
<body>
<div class="container">
  <h2>授权验证</h2>
  <div class="sub">请输入授权码以继续使用。<br>首次验证后 7 天内无需重复输入。</div>
  <input id="code" type="text" placeholder="授权码" autofocus>
  <div id="error" class="error"></div>
  <div class="btn-row">
    <button class="secondary" onclick="quit()">退出</button>
    <button class="primary" id="btn" onclick="submit()">验证</button>
  </div>
</div>
<script>
const { ipcRenderer } = require('electron');
const input = document.getElementById('code');
const btn = document.getElementById('btn');
const errorEl = document.getElementById('error');

function setError(msg) {
  errorEl.textContent = msg || '';
}
function setLoading(v) {
  btn.disabled = v;
  btn.innerHTML = v ? '<span class="spinner"></span>验证中...' : '验证';
}

async function submit() {
  const code = input.value.trim();
  if (!code) { setError('请输入授权码'); return; }
  setError(''); setLoading(true);
  try {
    const result = await ipcRenderer.invoke('auth:verify', code);
    if (result.valid) {
      setLoading(false);
      // success — main process will close the window
    } else {
      setLoading(false);
      setError(result.message || '验证失败，请检查授权码');
    }
  } catch (err) {
    setLoading(false);
    setError('网络错误：' + (err.message || '请稍后重试'));
  }
}
function quit() {
  ipcRenderer.send('auth:quit');
}
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') submit();
});
input.focus();
</script>
</body>
</html>`;

function createAuthDialog() {
  const win = new BrowserWindow({
    width: 400,
    height: 260,
    resizable: false,
    minimizable: false,
    maximizable: false,
    closable: true,
    show: false,
    center: true,
    title: '授权验证',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false,
    },
  });
  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(DIALOG_HTML));
  win.setMenuBarVisibility(false);
  return win;
}

function showAuthDialog() {
  return new Promise((resolve, reject) => {
    // Clean up any stale handlers
    try { ipcMain.removeHandler('auth:verify'); } catch {}
    try { ipcMain.removeAllListeners('auth:quit'); } catch {}

    const win = createAuthDialog();

    ipcMain.handle('auth:verify', async (_event, code) => {
      // Save the auth code first
      try {
        const cfg = await appConfig.load();
        await appConfig.save({
          license: { ...cfg.license, authCode: code },
        });
      } catch (err) {
        console.error('[authDialog] save authCode failed:', err);
      }

      // Run verification
      const result = await verifyLicense({ silent: true });
      if (result.valid) {
        if (!win.isDestroyed()) win.close();
        resolve(result);
      }
      return result;
    });

    ipcMain.once('auth:quit', () => {
      if (!win.isDestroyed()) win.close();
      reject(new Error('user_quit'));
    });

    win.once('closed', () => {
      // If neither verify nor quit fired, treat as user closed window = quit
      reject(new Error('user_closed'));
    });

    win.once('ready-to-show', () => {
      win.show();
      win.focus();
    });
  });
}

module.exports = { showAuthDialog };
