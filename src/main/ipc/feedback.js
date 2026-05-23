'use strict';

const { ipcMain } = require('electron');
const feedbackOutbox = require('../store/feedbackOutbox');
const recentLogBuffer = require('../store/recentLogBuffer');
const appConfig = require('../store/appConfig');
const providerManager = require('../providerManager');

function getFeedbackSyncWorker() {
  return require('../index').getFeedbackSyncWorker();
}

async function hideUiOverlaysForScreenshot(webContents) {
  if (!webContents?.executeJavaScript) return [];
  return webContents.executeJavaScript(`
    (() => {
      const targets = Array.from(document.querySelectorAll('[role="dialog"][aria-modal="true"]'));
      const hidden = targets.map((element, index) => {
        const marker = 'mana-feedback-screenshot-hidden-' + Date.now() + '-' + index;
        element.dataset.manaFeedbackScreenshotHidden = marker;
        const previousVisibility = element.style.visibility || '';
        const previousPointerEvents = element.style.pointerEvents || '';
        element.style.visibility = 'hidden';
        element.style.pointerEvents = 'none';
        return { marker, previousVisibility, previousPointerEvents };
      });
      return new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve(hidden)));
      });
    })()
  `);
}

async function restoreUiOverlaysAfterScreenshot(webContents, hiddenEntries) {
  if (!webContents?.executeJavaScript || !Array.isArray(hiddenEntries) || hiddenEntries.length === 0) return;
  const payload = JSON.stringify(hiddenEntries);
  await webContents.executeJavaScript(`
    (() => {
      const hiddenEntries = ${payload};
      for (const entry of hiddenEntries) {
        const element = document.querySelector('[data-mana-feedback-screenshot-hidden="' + entry.marker + '"]');
        if (!element) continue;
        element.style.visibility = entry.previousVisibility;
        element.style.pointerEvents = entry.previousPointerEvents;
        delete element.dataset.manaFeedbackScreenshotHidden;
      }
    })()
  `);
}

const SENSITIVE_KEY_PATTERNS = [
  'apiKey', 'api_key', 'apiKeyRef', 'appSecret', 'relayApiKey',
  'authCode', 'authToken', 'AUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN',
  'password', 'secret', 'token',
];

function isSensitiveKey(key) {
  const lower = String(key).toLowerCase();
  return SENSITIVE_KEY_PATTERNS.some((p) => lower.includes(p.toLowerCase()));
}

function redactSensitive(obj) {
  if (obj == null) return obj;
  if (Array.isArray(obj)) return obj.map(redactSensitive);
  if (typeof obj !== 'object') return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (isSensitiveKey(k)) {
      out[k] = v ? '[REDACTED]' : '';
    } else if (typeof v === 'object' && v !== null) {
      out[k] = redactSensitive(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

async function collectSanitizedSettings() {
  try {
    const cfg = await appConfig.load();
    const providers = await providerManager.list();
    return redactSensitive({
      language: cfg.language,
      activeDriverId: cfg.activeDriverId,
      drivers: cfg.drivers,
      storageQuota: cfg.storageQuota,
      searchEngine: cfg.searchEngine,
      enrichmentConcurrency: cfg.enrichmentConcurrency,
      enrichmentMode: cfg.enrichmentMode,
      feishuSync: cfg.feishuSync,
      license: cfg.license,
      updater: cfg.updater,
      providers,
    });
  } catch {
    return null;
  }
}

function safeIpc(handler) {
  return async (event, ...args) => {
    try { return { ok: true, value: await handler(event, ...args) }; }
    catch (err) { return { ok: false, error: err.message || String(err) }; }
  };
}

function registerFeedbackIpc() {
  ipcMain.handle('mana:feedback:submit', safeIpc(async (event, { payload, options }) => {
    const nextPayload = payload && typeof payload === 'object' ? { ...payload } : {};
    const includeLogs = nextPayload?.userInput?.feedbackMode === 'context-with-logs';
    const mainLogs = recentLogBuffer.getFeedbackLogSnapshot();

    nextPayload.errors = {
      ...(nextPayload.errors && typeof nextPayload.errors === 'object' ? nextPayload.errors : {}),
      latestMainProcessError: includeLogs ? mainLogs.latestMainProcessError : null,
      latestChatAgentError: includeLogs ? mainLogs.latestChatAgentError : null,
    };

    nextPayload.recentLogs = includeLogs
      ? {
          ...(nextPayload.recentLogs && typeof nextPayload.recentLogs === 'object' ? nextPayload.recentLogs : {}),
          mainProcess: mainLogs.recentMainLogs,
          chatAgent: mainLogs.recentChatAgentLogs,
        }
      : {};

    const attachmentFiles = [];
    if (options?.includeScreenshot && event?.sender?.capturePage) {
      let hiddenEntries = [];
      try {
        hiddenEntries = await hideUiOverlaysForScreenshot(event.sender);
        const image = await event.sender.capturePage();
        const png = image?.toPNG?.();
        if (Buffer.isBuffer(png) && png.length) {
          attachmentFiles.push({
            kind: 'window-screenshot',
            label: '当前窗口截图',
            fileName: 'screenshot.png',
            mimeType: 'image/png',
            data: png,
          });
        }
      } catch (err) {
        nextPayload.errors = {
          ...(nextPayload.errors && typeof nextPayload.errors === 'object' ? nextPayload.errors : {}),
          screenshotCaptureError: err.message || String(err),
        };
      } finally {
        try {
          await restoreUiOverlaysAfterScreenshot(event.sender, hiddenEntries);
        } catch {
          // Ignore restore failures; they should not block feedback submission.
        }
      }
    }

    // Attach sanitized app settings (excluding API keys and secrets)
    const settings = await collectSanitizedSettings();
    if (settings) {
      nextPayload.appSettings = settings;
    }

    const result = await feedbackOutbox.submitFeedback(nextPayload, { attachments: attachmentFiles });

    // Trigger async sync to Feishu after a short delay
    setTimeout(() => {
      try {
        const worker = getFeedbackSyncWorker();
        if (worker) worker.triggerSync();
      } catch {
        // Non-critical; sync worker will pick it up on next scan
      }
    }, 2_000);

    return result;
  }));
}

module.exports = { registerFeedbackIpc };