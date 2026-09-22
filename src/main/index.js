'use strict';

const { ensureLayout } = require('./store/paths');
const skillsStore = require('./store/skills');
const appConfig = require('./store/appConfig');
const { registerFsIpc } = require('./ipc/fs');
const { registerConfigIpc } = require('./ipc/config');
const { registerNovelIpc } = require('./ipc/novel');
const { registerModelConfigIpc } = require('./ipc/modelConfig');
const { registerCodexIpc } = require('./ipc/codex');
const { registerChatHistoryIpc } = require('./ipc/chatHistory');
const { registerOfflineLogIpc } = require('./ipc/offlineLog');
const { registerImportIpc } = require('./ipc/import');
const { registerFeedbackIpc } = require('./ipc/feedback');
const { registerFeedbackSyncIpc } = require('./ipc/feedbackSync');
const { registerUpdaterIpc } = require('./ipc/updater');
const { registerLanRemoteIpc } = require('./ipc/lanRemote');
const { FeedbackSyncWorker } = require('./sync/feedbackSyncWorker');
const chatHistory = require('./store/chatHistory');
const offlineLog = require('./store/offlineLog');
const recentLogBuffer = require('./store/recentLogBuffer');
const stagingProject = require('./import/stagingProject');
const ipcBridge = require('./lan/ipcBridge');
const lanRemote = require('./lan/remoteServer');

let initialized = false;
let feedbackSyncWorker = null;
let deferredStartupPromise = null;

function getFeedbackSyncWorker() { return feedbackSyncWorker; }

async function migrateSkills() {
  try { await skillsStore.migrateLegacy(); }
  catch (error) { console.error('[init] Codex Skills migration failed:', error.message); }
}

async function startDeferredStartup() {
  if (deferredStartupPromise) return deferredStartupPromise;
  deferredStartupPromise = (async () => {
    await migrateSkills();
    try {
      const cfg = await appConfig.load();
      const quotaTasks = [];
      if (cfg?.storageQuota?.chatHistoryMaxMB) quotaTasks.push(chatHistory.enforceQuota(cfg.storageQuota.chatHistoryMaxMB * 1024 * 1024));
      if (cfg?.storageQuota?.offlineLogMaxMB) quotaTasks.push(offlineLog.enforceQuota(cfg.storageQuota.offlineLogMaxMB * 1024 * 1024));
      await Promise.allSettled(quotaTasks);
      if (cfg?.feishuSync && !feedbackSyncWorker) {
        feedbackSyncWorker = new FeedbackSyncWorker();
        feedbackSyncWorker.setConfig(cfg.feishuSync);
        feedbackSyncWorker.start();
      }
    } catch (error) {
      console.error('[main] deferred startup failed', error);
    }
    try { await stagingProject.cleanupExpiredProjects(); }
    catch (error) { console.error('[main] staging cleanup failed', error); }
  })();
  return deferredStartupPromise;
}

async function initBackend() {
  if (initialized) return;
  initialized = true;
  recentLogBuffer.installConsoleCapture();
  ensureLayout();
  ipcBridge.install();
  registerFsIpc();
  registerConfigIpc();
  registerNovelIpc();
  registerModelConfigIpc();
  registerCodexIpc();
  registerChatHistoryIpc();
  registerOfflineLogIpc();
  registerImportIpc();
  registerFeedbackIpc();
  registerFeedbackSyncIpc();
  registerUpdaterIpc();
  registerLanRemoteIpc();
  try { await lanRemote.syncFromAppConfig(); }
  catch (error) { console.error('[main] LAN remote startup failed', error.message || String(error)); }
}

function attachWindow() {}

module.exports = { initBackend, startDeferredStartup, attachWindow, getFeedbackSyncWorker };
