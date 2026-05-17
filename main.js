// Guard: ELECTRON_RUN_AS_NODE makes require('electron') return a path string
// instead of the Electron API. Re-launch cleanly if set.
if (process.env.ELECTRON_RUN_AS_NODE) {
  const { spawn } = require('node:child_process');
  const child = spawn(process.execPath, process.argv.slice(1), {
    stdio: 'inherit',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
  });
  child.on('exit', (code) => process.exit(code ?? 0));
  process.on('SIGINT', () => { /* hand off to child */ });
  process.on('SIGTERM', () => child.kill('SIGTERM'));
  return; // stop loading this script
}

const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const backend = require('./src/main/index.js')
const { verifyLicense } = require('./src/main/license/authVerifier.js')
const { showAuthDialog } = require('./src/main/license/authDialog.js')

const isUiTest = process.argv.includes('--test-ui');
const isChatTest = process.argv.includes('--test-chat');
const isFlowTest = process.argv.includes('--test-flow');
const isDiagTest = process.argv.includes('--test-diag');
const isRealChatTest = process.argv.includes('--test-real-chat');
const isRealFullChainTest = process.argv.includes('--test-real-full-chain');
const isChatTimelineRegressionTest = process.argv.includes('--test-chat-timeline-regression');
const isChatReplaceRegressionTest = process.argv.includes('--test-chat-replace-regression');
const isChatOutlineUiRegressionTest = process.argv.includes('--test-chat-outline-ui-regression');
const isChatFeedbackUiRegressionTest = process.argv.includes('--test-chat-feedback-ui-regression');
const isChatFeedbackFeishuE2ETest = process.argv.includes('--test-chat-feedback-feishu-e2e');
const isUserE2ETest = process.argv.includes('--test-user-e2e');
const isCharacterCardUiTest = process.argv.includes('--test-character-card-ui');
const isDataTabEditUiTest = process.argv.includes('--test-datatab-edit-ui');

async function createWindow () {
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    show: isRealChatTest || isUserE2ETest || isCharacterCardUiTest || isDataTabEditUiTest || (!isUiTest && !isChatTest && !isFlowTest && !isDiagTest && !isRealFullChainTest && !isChatTimelineRegressionTest && !isChatOutlineUiRegressionTest && !isChatFeedbackUiRegressionTest && !isChatFeedbackFeishuE2ETest),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    }
  })

  backend.attachWindow(mainWindow);

  const isDev = process.env.NODE_ENV !== 'production' && !app.isPackaged;

  if (isDev) {
    setTimeout(async () => {
      const candidatePorts = [5173, 5174, 5175, 5176];
      let loaded = false;
      for (const port of candidatePorts) {
        const url = `http://localhost:${port}`;
        try {
          await mainWindow.loadURL(url);
          loaded = true;
          break;
        } catch {
          // try next
        }
      }
      if (!loaded) {
        mainWindow.loadURL('data:text/html;charset=utf-8,<h2>Dev server not found</h2><p>Please run Vite and retry.</p>');
      } else if (!isUiTest) {
        mainWindow.webContents.openDevTools();
      }
    }, 1000);
  } else if (isUiTest) {
    // UI test mode
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Page load timeout')), 15000);
      mainWindow.webContents.once('did-finish-load', async () => {
        clearTimeout(timeout);
        try {
          const { runUiTests } = require('./test/ui-tests.js');
          const results = await runUiTests(mainWindow);
          process.exit(results.failed > 0 ? 1 : 0);
        } catch (err) {
          console.error('TEST_FAIL harness_error:', err.message || String(err));
          process.exit(1);
        }
      });
      mainWindow.webContents.once('did-fail-load', (_e, code, desc) => {
        clearTimeout(timeout);
        reject(new Error(`Page load failed: ${code} ${desc}`));
      });
      mainWindow.loadFile(path.join(__dirname, 'dist', 'index.html'));
    });
  } else if (isChatTest) {
    // Chat test mode
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Page load timeout')), 15000);
      mainWindow.webContents.once('did-finish-load', async () => {
        clearTimeout(timeout);
        try {
          const { runChatTests } = require('./test/chat-tests.js');
          const results = await runChatTests(mainWindow);
          process.exit(results.failed > 0 ? 1 : 0);
        } catch (err) {
          console.error('TEST_FAIL harness_error:', err.message || String(err));
          process.exit(1);
        }
      });
      mainWindow.webContents.once('did-fail-load', (_e, code, desc) => {
        clearTimeout(timeout);
        reject(new Error(`Page load failed: ${code} ${desc}`));
      });
      mainWindow.loadFile(path.join(__dirname, 'dist', 'index.html'));
    });
  } else if (isUserE2ETest) {
    // User-facing E2E test
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Page load timeout')), 15000);
      mainWindow.webContents.once('did-finish-load', async () => {
        clearTimeout(timeout);
        try {
          const { runUserE2E } = require('./test/user-e2e.js');
          const results = await runUserE2E(mainWindow);
          process.exit(results.failed > 0 ? 1 : 0);
        } catch (err) {
          console.error('TEST_FAIL harness_error:', err.message || String(err));
          process.exit(1);
        }
      });
      mainWindow.webContents.once('did-fail-load', (_e, code, desc) => {
        clearTimeout(timeout);
        reject(new Error(`Page load failed: ${code} ${desc}`));
      });
      mainWindow.loadFile(path.join(__dirname, 'dist', 'index.html'));
    });
  } else if (isRealChatTest) {
    // Real chat E2E test: needs a visible window for DOM interaction
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Page load timeout')), 15000);
      mainWindow.webContents.once('did-finish-load', async () => {
        clearTimeout(timeout);
        try {
          const { runChatRealE2E } = require('./test/chat-real-e2e.js');
          const results = await runChatRealE2E(mainWindow);
          process.exit(results.failed > 0 ? 1 : 0);
        } catch (err) {
          console.error('TEST_FAIL harness_error:', err.message || String(err));
          process.exit(1);
        }
      });
      mainWindow.webContents.once('did-fail-load', (_e, code, desc) => {
        clearTimeout(timeout);
        reject(new Error(`Page load failed: ${code} ${desc}`));
      });
      mainWindow.loadFile(path.join(__dirname, 'dist', 'index.html'));
    });
  } else if (isCharacterCardUiTest) {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Page load timeout')), 15000);
      mainWindow.webContents.once('did-finish-load', async () => {
        clearTimeout(timeout);
        try {
          const { runCharacterCardUiE2E } = require('./test/character-card-ui-e2e.js');
          const results = await runCharacterCardUiE2E(mainWindow);
          process.exit(results.failed > 0 ? 1 : 0);
        } catch (err) {
          console.error('TEST_FAIL harness_error:', err.message || String(err));
          process.exit(1);
        }
      });
      mainWindow.webContents.once('did-fail-load', (_e, code, desc) => {
        clearTimeout(timeout);
        reject(new Error(`Page load failed: ${code} ${desc}`));
      });
      mainWindow.loadFile(path.join(__dirname, 'dist', 'index.html'));
    });
  } else if (isDataTabEditUiTest) {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Page load timeout')), 15000);
      mainWindow.webContents.once('did-finish-load', async () => {
        clearTimeout(timeout);
        try {
          const { runDataTabEditUiE2E } = require('./test/datatab-edit-ui-e2e.js');
          const results = await runDataTabEditUiE2E(mainWindow);
          process.exit(results.failed > 0 ? 1 : 0);
        } catch (err) {
          console.error('TEST_FAIL harness_error:', err.message || String(err));
          process.exit(1);
        }
      });
      mainWindow.webContents.once('did-fail-load', (_e, code, desc) => {
        clearTimeout(timeout);
        reject(new Error(`Page load failed: ${code} ${desc}`));
      });
      mainWindow.loadFile(path.join(__dirname, 'dist', 'index.html'));
    });
  } else if (isChatReplaceRegressionTest) {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Page load timeout')), 15000);
      mainWindow.webContents.once('did-finish-load', async () => {
        clearTimeout(timeout);
        try {
          const { runChatReplaceSelectionRegressionTest } = require('./test/chat-replace-selection-regression.test.js');
          const results = await runChatReplaceSelectionRegressionTest(mainWindow);
          process.exit(results.failed > 0 ? 1 : 0);
        } catch (err) {
          console.error('TEST_FAIL harness_error:', err.message || String(err));
          process.exit(1);
        }
      });
      mainWindow.webContents.once('did-fail-load', (_e, code, desc) => {
        clearTimeout(timeout);
        reject(new Error(`Page load failed: ${code} ${desc}`));
      });
      mainWindow.loadFile(path.join(__dirname, 'dist', 'index.html'));
    });
  } else if (isChatOutlineUiRegressionTest) {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Page load timeout')), 15000);
      mainWindow.webContents.once('did-finish-load', async () => {
        clearTimeout(timeout);
        try {
          const { runChatOutlineUiRegressionTest } = require('./test/chat-outline-ui-e2e.js');
          const results = await runChatOutlineUiRegressionTest(mainWindow);
          process.exit(results.failed > 0 ? 1 : 0);
        } catch (err) {
          console.error('TEST_FAIL harness_error:', err.message || String(err));
          process.exit(1);
        }
      });
      mainWindow.webContents.once('did-fail-load', (_e, code, desc) => {
        clearTimeout(timeout);
        reject(new Error(`Page load failed: ${code} ${desc}`));
      });
      mainWindow.loadFile(path.join(__dirname, 'dist', 'index.html'));
    });
  } else if (isChatFeedbackUiRegressionTest) {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Page load timeout')), 15000);
      mainWindow.webContents.once('did-finish-load', async () => {
        clearTimeout(timeout);
        try {
          const { runChatFeedbackUiRegressionTest } = require('./test/chat-feedback-ui-e2e.js');
          const results = await runChatFeedbackUiRegressionTest(mainWindow);
          process.exit(results.failed > 0 ? 1 : 0);
        } catch (err) {
          console.error('TEST_FAIL harness_error:', err.message || String(err));
          process.exit(1);
        }
      });
      mainWindow.webContents.once('did-fail-load', (_e, code, desc) => {
        clearTimeout(timeout);
        reject(new Error(`Page load failed: ${code} ${desc}`));
      });
      mainWindow.loadFile(path.join(__dirname, 'dist', 'index.html'));
    });
  } else if (isChatFeedbackFeishuE2ETest) {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Page load timeout')), 15000);
      mainWindow.webContents.once('did-finish-load', async () => {
        clearTimeout(timeout);
        try {
          const { runChatFeedbackFeishuE2E } = require('./test/chat-feedback-feishu-e2e.js');
          const results = await runChatFeedbackFeishuE2E(mainWindow);
          process.exit(results.failed > 0 ? 1 : 0);
        } catch (err) {
          console.error('TEST_FAIL harness_error:', err.message || String(err));
          process.exit(1);
        }
      });
      mainWindow.webContents.once('did-fail-load', (_e, code, desc) => {
        clearTimeout(timeout);
        reject(new Error(`Page load failed: ${code} ${desc}`));
      });
      mainWindow.loadFile(path.join(__dirname, 'dist', 'index.html'));
    });
  } else {
    await mainWindow.loadFile(path.join(__dirname, 'dist', 'index.html'));
  }
}

// Flow test mode: runs directly in main process, no window needed.
// Modules are loaded after initBackend sets up paths and registries.
if (isFlowTest) {
  app.whenReady().then(async () => {
    try {
      await backend.initBackend();
    } catch (err) {
      console.error('TEST_FAIL backend_init:', err.message || String(err));
      process.exit(1);
    }
    try {
      const { runFlowTests } = require('./test/flow-tests.js');
      const results = await runFlowTests(null);
      process.exit(results.failed > 0 ? 1 : 0);
    } catch (err) {
      console.error('TEST_FAIL harness_error:', err.message || String(err));
      process.exit(1);
    }
  });
} else if (isDiagTest) {
  app.whenReady().then(async () => {
    try {
      await backend.initBackend();
    } catch (err) {
      console.error('TEST_FAIL backend_init:', err.message || String(err));
      process.exit(1);
    }
    try {
      const { runChatDiagnostic } = require('./test/chat-diagnostic-test.js');
      const results = await runChatDiagnostic(null);
      process.exit(results.failed > 0 ? 1 : 0);
    } catch (err) {
      console.error('TEST_FAIL harness_error:', err.message || String(err));
      process.exit(1);
    }
  });
} else if (isRealFullChainTest) {
  app.whenReady().then(async () => {
    try {
      await backend.initBackend();
    } catch (err) {
      console.error('TEST_FAIL backend_init:', err.message || String(err));
      process.exit(1);
    }
    try {
      const { runRealFullChainTest } = require('./test/chat-real-full-chain-test.js');
      const results = await runRealFullChainTest(null);
      process.exit(results.failed > 0 ? 1 : 0);
    } catch (err) {
      console.error('TEST_FAIL harness_error:', err.message || String(err));
      process.exit(1);
    }
  });
} else if (isChatTimelineRegressionTest) {
  app.whenReady().then(async () => {
    try {
      await backend.initBackend();
    } catch (err) {
      console.error('TEST_FAIL backend_init:', err.message || String(err));
      process.exit(1);
    }
    try {
      const { runChatTimelineRegressionTest } = require('./test/chat-timeline-regression.test.js');
      const results = await runChatTimelineRegressionTest(null);
      process.exit(results.failed > 0 ? 1 : 0);
    } catch (err) {
      console.error('TEST_FAIL harness_error:', err.message || String(err));
      process.exit(1);
    }
  });
} else {
  app.whenReady().then(async () => {
    try {
      await backend.initBackend();
    } catch (err) {
      console.error('[main] backend init failed', err);
    }

    // License verification
    try {
      let result = await verifyLicense();
      if (!result.valid) {
        console.error('[main] license verification failed:', result.reason);
        try {
          result = await showAuthDialog();
        } catch (dialogErr) {
          console.error('[main] auth dialog closed/quited:', dialogErr.message);
          app.quit();
          return;
        }
      }
    } catch (err) {
      console.error('[main] license verification error:', err);
    }

    // Check for updates (delay to avoid blocking startup)
    const { checkForUpdates } = require('./src/main/updater/versionChecker');
    setTimeout(() => {
      checkForUpdates({ silent: true }).catch((err) => {
        console.error('[main] update check failed:', err.message);
      });
    }, 5000);

    await createWindow();

    app.on('activate', async function () {
      if (BrowserWindow.getAllWindows().length === 0) await createWindow();
    });
  });
}

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit();
});
