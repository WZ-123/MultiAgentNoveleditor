if (process.env.ELECTRON_RUN_AS_NODE) {
  const { spawn } = require('node:child_process');
  const child = spawn(process.execPath, process.argv.slice(1), { stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined } });
  child.on('exit', (code) => process.exit(code ?? 0));
  if (process.platform !== 'win32') process.on('SIGTERM', () => child.kill('SIGTERM'));
  process.on('SIGINT', () => {});
  return;
}

const { app, BrowserWindow, session } = require('electron');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const backend = require('./src/main/index.js');
const { verifyLicense } = require('./src/main/license/authVerifier.js');
const { showAuthDialog } = require('./src/main/license/authDialog.js');
const { ensureDevAuthRelayConfig } = require('./src/main/license/devAuthBootstrap.js');
const { getSessionManager } = require('./src/main/license/sessionManager.js');
const { getRendererDevOrigin } = require('./src/main/lan/rendererDevOrigin.js');

const APP_NAME = 'MultiAgentNovelAssistant';
const isAutomatedTest = process.argv.some((argument) => String(argument).startsWith('--test-')) || process.env.MANA_AUTOMATED_TEST === '1';
const isNativeUiTest = process.argv.includes('--test-codex-native-ui');
const isResponsesConfigUiTest = process.argv.includes('--test-responses-config-v6');
const isCodexSubscriptionUiTest = process.argv.includes('--test-codex-subscription-ui');
const isLunaFiftyKUiTest = process.argv.includes('--test-luna-50k-ui');
const isDeepSeekLiveProviderTest = process.argv.includes('--test-deepseek-live-provider');
const isDeepSeekLiveNovelTest = process.argv.includes('--test-deepseek-live-novel');
if (isAutomatedTest) process.env.MANA_AUTOMATED_TEST = '1';
if (isAutomatedTest) {
  app.commandLine.appendSwitch('mute-audio');
  app.on('web-contents-created', (_event, contents) => contents.setAudioMuted(true));
}

function isTrustedRendererTarget(targetUrl, currentUrl = '') {
  try {
    const target = new URL(targetUrl);
    if (target.protocol === 'file:') {
      const distRoot = path.resolve(__dirname, 'dist') + path.sep;
      const targetPath = path.resolve(fileURLToPath(target));
      return targetPath === path.resolve(__dirname, 'dist', 'index.html') || targetPath.startsWith(distRoot);
    }
    if (!currentUrl) return false;
    const current = new URL(currentUrl);
    return ['http:', 'https:'].includes(target.protocol) && target.origin === current.origin;
  } catch { return false; }
}

const isDevMode = process.env.NODE_ENV !== 'production' && !app.isPackaged;
const effectiveName = isDevMode ? `${APP_NAME}-dev` : APP_NAME;
app.setName(effectiveName);
try {
  const configured = String(process.env.MANA_USER_DATA_ROOT || '').trim();
  const userDataRoot = configured ? path.resolve(configured) : path.join(app.getPath('appData'), effectiveName);
  app.setPath('userData', userDataRoot);
  app.setPath('sessionData', path.join(userDataRoot, 'session-data'));
} catch (error) {
  console.warn('[main] failed to pin userData/sessionData path:', error.message || String(error));
}

async function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    show: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: !isAutomatedTest },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, targetUrl) => {
    if (!isTrustedRendererTarget(targetUrl, win.webContents.getURL())) event.preventDefault();
  });
  backend.attachWindow(win);
  if (isDevMode && !isAutomatedTest) {
    const origin = getRendererDevOrigin();
    if (origin) await win.loadURL(origin);
    else await win.loadURL('data:text/html;charset=utf-8,<h2>Editor dev server is not configured</h2><p>Please start this project with npm run dev.</p>');
    win.webContents.openDevTools();
  } else {
    await win.loadFile(path.join(__dirname, 'dist', 'index.html'));
  }
  if (isNativeUiTest) {
    try {
      const result = await require('./test/codex-native-ui-e2e.js').runCodexNativeUiE2E(win);
      app.exit(result.failed ? 1 : 0);
    } catch (error) {
      console.error('TEST_FAIL codex_native_ui:', error.stack || error.message || String(error));
      app.exit(1);
    }
  }
  if (isResponsesConfigUiTest) {
    try {
      const result = await require('./test/responses-config-v6-ui-e2e.js').runResponsesConfigV6UiE2E(win);
      app.exit(result.failed ? 1 : 0);
    } catch (error) {
      console.error('TEST_FAIL responses_config_v6_ui:', error.stack || error.message || String(error));
      app.exit(1);
    }
  }
  if (isCodexSubscriptionUiTest) {
    try {
      const result = await require('./test/codex-subscription-ui-e2e.js').runCodexSubscriptionUiE2E(win);
      app.exit(result.failed ? 1 : 0);
    } catch (error) {
      console.error('TEST_FAIL codex_subscription_ui:', error.stack || error.message || String(error));
      app.exit(1);
    }
  }
  if (isLunaFiftyKUiTest) {
    try {
      const result = await require('./test/luna-50k-ui-e2e.js').runLunaFiftyKUiE2E(win);
      app.exit(result.failed ? 1 : 0);
    } catch (error) {
      console.error('TEST_FAIL luna_50k_ui:', error.stack || error.message || String(error));
      app.exit(1);
    }
  }
  if (isDeepSeekLiveProviderTest) {
    try {
      const result = await require('./test/deepseek-live-provider-ui-e2e.js').runDeepSeekLiveProviderUiE2E(win);
      app.exit(result.failed ? 1 : 0);
    } catch (error) {
      console.error('TEST_FAIL deepseek_live_provider_ui:', error.stack || error.message || String(error));
      app.exit(1);
    }
  }
  if (isDeepSeekLiveNovelTest) {
    try {
      const result = await require('./test/deepseek-live-novel-ui-e2e.js').runDeepSeekLiveNovelUiE2E(win);
      app.exit(result.failed ? 1 : 0);
    } catch (error) {
      console.error('TEST_FAIL deepseek_live_novel_ui:', error.stack || error.message || String(error));
      app.exit(1);
    }
  }
  return win;
}

app.whenReady().then(async () => {
  try { await getSessionManager().prepareSecureState(); }
  catch (error) { console.error('[main] secure credential migration failed:', error?.code || 'secure_storage_unavailable'); }
  try { await backend.initBackend(); }
  catch (error) { console.error('[main] backend init failed', error); }
  try { await ensureDevAuthRelayConfig(); }
  catch (error) { console.error('[main] dev auth bootstrap failed', error); }

  if (!isAutomatedTest) {
    try {
      let result = await verifyLicense({ silent: true });
      if (!result.valid) result = await showAuthDialog();
      if (!result?.valid) return app.quit();
    } catch (error) {
      console.error('[main] license verification error:', error);
      return app.quit();
    }
    setTimeout(() => verifyLicense({ silent: true, forceOnline: true }).catch((error) => console.error('[main] background license verify error:', error.message)), 1500);
    const { checkForUpdates } = require('./src/main/updater/versionChecker');
    setTimeout(() => checkForUpdates({ silent: true }).catch((error) => console.error('[main] update check failed:', error.message)), 5000);
  }

  await createWindow();
  backend.startDeferredStartup?.().catch((error) => console.error('[main] deferred startup scheduling failed', error));
  app.on('activate', async () => { if (BrowserWindow.getAllWindows().length === 0) await createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  if (typeof session.defaultSession.setDevicePermissionHandler === 'function') session.defaultSession.setDevicePermissionHandler(() => false);
});
app.on('before-quit', () => { require('./src/main/codex-runtime').disposeCodexSessionService().catch(() => {}); });
