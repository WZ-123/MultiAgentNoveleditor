const { contextBridge, ipcRenderer } = require('electron');

function unwrap(promise) {
  return promise.then((res) => {
    if (res && typeof res === 'object' && 'ok' in res) {
      if (res.ok) return res.value;
      const err = new Error(res.error || 'IPC error');
      if (res.errorCode || res.code) err.code = res.errorCode || res.code;
      if (res.details) err.details = res.details;
      throw err;
    }
    return res;
  });
}

function invoke(channel, payload) {
  return unwrap(ipcRenderer.invoke(channel, payload));
}

const fs = {
  readFile: (filePath, encoding) => invoke('mana:fs:readFile', { filePath, encoding }),
  writeFile: (filePath, content, encoding) => invoke('mana:fs:writeFile', { filePath, content, encoding }),
  readJson: (filePath, fallback) => invoke('mana:fs:readJson', { filePath, fallback }),
  writeJson: (filePath, data) => invoke('mana:fs:writeJson', { filePath, data }),
  appendJsonl: (filePath, line) => invoke('mana:fs:appendJsonl', { filePath, line }),
  listDir: (dir) => invoke('mana:fs:listDir', { dir }),
  ensureDir: (dir) => invoke('mana:fs:ensureDir', { dir }),
  pathExists: (p) => invoke('mana:fs:pathExists', { path: p }),
  deleteFile: (filePath) => invoke('mana:fs:deleteFile', { filePath }),
  pickDirectory: (opts) => invoke('mana:fs:pickDirectory', opts || {}),
  pickFile: (opts) => invoke('mana:fs:pickFile', opts || {}),
};

const config = {
  getApp: () => invoke('mana:config:getApp'),
  setApp: (patch) => invoke('mana:config:setApp', { patch }),
  setSecret: (id, value) => invoke('mana:config:setSecret', { id, value }),
  deleteSecret: (id) => invoke('mana:config:deleteSecret', { id }),
  listSecretIds: () => invoke('mana:config:listSecretIds'),
  secretsAvailable: () => invoke('mana:config:secretsAvailable'),
  listSkills: () => invoke('mana:config:listSkills'),
  getSkill: (id) => invoke('mana:config:getSkill', { id }),
  saveSkill: (skill) => invoke('mana:config:saveSkill', { skill }),
  deleteSkill: (id) => invoke('mana:config:deleteSkill', { id }),
  setSkillEnabled: (id, enabled) => invoke('mana:config:setSkillEnabled', { id, enabled }),
  exportSkill: (id) => invoke('mana:config:exportSkill', { id }),
  importSkill: (bundle) => invoke('mana:config:importSkill', { bundle }),
};

const novel = {
  list: () => invoke('mana:novel:list'),
  create: (payload) => invoke('mana:novel:create', payload || {}),
  open: (id) => invoke('mana:novel:open', { id }),
  close: () => invoke('mana:novel:close'),
  active: () => invoke('mana:novel:active'),
  saveMeta: (id, patch) => invoke('mana:novel:saveMeta', { id, patch }),
  importExisting: (dir) => invoke('mana:novel:importExisting', { dir }),
  remove: (id) => invoke('mana:novel:remove', { id }),
  listChapters: (id) => invoke('mana:novel:listChapters', { id }),
  listChapterMetas: (id) => invoke('mana:novel:listChapterMetas', { id }),
  readChapter: (id, name) => invoke('mana:novel:readChapter', { id, name }),
  saveChapter: (id, name, content, metadata, options) => invoke('mana:novel:saveChapter', { id, name, content, metadata, options }),
  deleteChapter: (id, name, options) => invoke('mana:novel:deleteChapter', { id, name, options }),
  listChapterRevisions: (id, name) => invoke('mana:novel:listChapterRevisions', { id, name }),
  readChapterRevision: (id, name, revisionId) => invoke('mana:novel:readChapterRevision', { id, name, revisionId }),
  restoreChapterRevision: (id, name, revisionId) => invoke('mana:novel:restoreChapterRevision', { id, name, revisionId }),
  readChapterMeta: (id, name) => invoke('mana:novel:readChapterMeta', { id, name }),
  computeChapterDisplayName: (id, seq, title) => invoke('mana:novel:computeChapterDisplayName', { id, seq, title }),
  computeNextInsertName: (id, afterFileName) => invoke('mana:novel:computeNextInsertName', { id, afterFileName }),
  getChapterNaming: (id) => invoke('mana:novel:getChapterNaming', { id }),
  setChapterNaming: (id, rule, separator) => invoke('mana:novel:setChapterNaming', { id, rule, separator }),
  nextChapterName: (id) => invoke('mana:novel:nextChapterName', { id }),
  onChapterChanged: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('mana:chapter:changed', handler);
    return () => ipcRenderer.removeListener('mana:chapter:changed', handler);
  },
  onActiveChanged: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('mana:novel:activeChanged', handler);
    return () => ipcRenderer.removeListener('mana:novel:activeChanged', handler);
  },
  listCharacters: (id) => invoke('mana:novel:listCharacters', { id }),
  readCharacter: (id, charId) => invoke('mana:novel:readCharacter', { id, charId }),
  writeCharacter: (id, character) => invoke('mana:novel:writeCharacter', { id, character }),
  deleteCharacter: (id, charId) => invoke('mana:novel:deleteCharacter', { id, charId }),
  listAssets: (id) => invoke('mana:novel:listAssets', { id }),
  readAsset: (id, assetId) => invoke('mana:novel:readAsset', { id, assetId }),
  upsertAsset: (id, asset) => invoke('mana:novel:upsertAsset', { id, asset }),
  deleteAsset: (id, assetId) => invoke('mana:novel:deleteAsset', { id, assetId }),
  grantAsset: (id, payload) => invoke('mana:novel:grantAsset', { id, payload }),
  revokeAsset: (id, payload) => invoke('mana:novel:revokeAsset', { id, payload }),
  applyAssetPatch: (id, patch) => invoke('mana:novel:applyAssetPatch', { id, patch }),
  auditAssets: (id) => invoke('mana:novel:auditAssets', { id }),
  listTimeline: (id) => invoke('mana:novel:listTimeline', { id }),
  appendTimeline: (id, event) => invoke('mana:novel:appendTimeline', { id, event }),
  replaceTimeline: (id, events) => invoke('mana:novel:replaceTimeline', { id, events }),
  readWorld: (id) => invoke('mana:novel:readWorld', { id }),
  writeWorld: (id, world) => invoke('mana:novel:writeWorld', { id, world }),
  readStyleMemory: (id) => invoke('mana:novel:readStyleMemory', { id }),
  writeStyleMemory: (id, text) => invoke('mana:novel:writeStyleMemory', { id, text }),
  enrichCharacters: (id, fanworkName, characterIds, runId) => invoke('mana:novel:enrichCharacters', { id, fanworkName, characterIds, runId }),
  regenerateCharacters: (id, confirmed) => invoke('mana:novel:regenerateCharacters', { id, confirmed }),
  search: (id, query, options) => invoke('mana:novel:search', { id, query, options }),
};

const modelConfig = {
  snapshot: () => invoke('mana:modelConfig:snapshot'),
  startSetup: (payload) => invoke('mana:modelConfig:startSetup', payload),
  querySetup: (id) => invoke('mana:modelConfig:querySetup', { id }),
  retrySetup: (payload) => invoke('mana:modelConfig:retrySetup', payload),
  cancelSetup: (id) => invoke('mana:modelConfig:cancelSetup', { id }),
  onSetupProgress: (handler) => {
    const wrapped = (_event, payload) => handler(payload);
    ipcRenderer.on('mana:modelConfig:setupProgress', wrapped);
    return () => ipcRenderer.removeListener('mana:modelConfig:setupProgress', wrapped);
  },

  saveCredential: (credential, expectedRevision) => invoke('mana:modelConfig:saveCredential', { credential, expectedRevision }),
  deleteCredential: (id, expectedRevision) => invoke('mana:modelConfig:deleteCredential', { id, expectedRevision }),
  previewConnection: (payload) => invoke('mana:modelConfig:previewConnection', payload),
  discoverConnection: (payload) => invoke('mana:modelConfig:discoverConnection', payload),
  saveConnection: (connection, expectedRevision) => invoke('mana:modelConfig:saveConnection', { connection, expectedRevision }),
  deleteConnection: (id, expectedRevision) => invoke('mana:modelConfig:deleteConnection', { id, expectedRevision }),
  verifyModel: (payload) => invoke('mana:modelConfig:verifyModel', payload),
  setActive: (connectionId, modelId, reasoningEffort, expectedRevision, interruptActive = false) => invoke('mana:modelConfig:setActive', { connectionId, modelId, reasoningEffort, expectedRevision, interruptActive }),
  onChanged: (handler) => {
    const wrapped = (_event, payload) => handler(payload);
    ipcRenderer.on('mana:modelConfig:changed', wrapped);
    return () => ipcRenderer.removeListener('mana:modelConfig:changed', wrapped);
  },
};

const codex = {
  status: () => invoke('mana:codex:status'),
  accountStatus: (payload) => invoke('mana:codex:accountStatus', payload || {}),
  accountLogin: (mode) => invoke('mana:codex:accountLogin', { mode }),
  accountCancel: (loginId) => invoke('mana:codex:accountCancel', { loginId }),
  accountLogout: () => invoke('mana:codex:accountLogout'),
  accountRateLimits: () => invoke('mana:codex:accountRateLimits'),
  refreshSubscriptionModels: (expectedRevision) => invoke('mana:codex:refreshSubscriptionModels', { expectedRevision }),
  startTurn: (payload) => invoke('mana:codex:startTurn', payload || {}),
    getConversationState: (payload) => invoke('mana:codex:getConversationState', payload || {}),
    getRunState: (payload) => invoke('mana:codex:getRunState', payload || {}),
    getResourceContext: (payload) => invoke('mana:codex:getResourceContext', payload || {}),
  interrupt: (payload) => invoke('mana:codex:interrupt', payload || {}),
  resolveConfirmation: (payload) => invoke('mana:codex:resolveConfirmation', payload || {}),
  getWritingAuthorization: (novelId) => invoke('mana:codex:getWritingAuthorization', { novelId }),
  setWritingAuthorization: (novelId, mode) => invoke('mana:codex:setWritingAuthorization', { novelId, mode }),
  revokeWritingAuthorization: (novelId) => invoke('mana:codex:revokeWritingAuthorization', { novelId }),
  getWritingProgress: (novelId, conversationId) => invoke('mana:codex:getWritingProgress', { novelId, conversationId }),
  onEvent: (handler) => {
    const wrapped = (_event, payload) => handler(payload);
    ipcRenderer.on('mana:codex:event', wrapped);
    return () => ipcRenderer.removeListener('mana:codex:event', wrapped);
  },
};


const chatHistory = {
  listThreads: (novelId) => invoke("mana:chatHistory:listThreads", { novelId }),
  createThread: (payload) => invoke("mana:chatHistory:createThread", payload || {}),
  getThread: (threadId) => invoke("mana:chatHistory:getThread", { threadId }),
  deleteThread: (threadId) => invoke("mana:chatHistory:deleteThread", { threadId }),
  renameThread: (threadId, title) => invoke("mana:chatHistory:renameThread", { threadId, title }),
  appendMessage: (threadId, message) => invoke("mana:chatHistory:appendMessage", { threadId, message }),
  editMessage: (threadId, messageId, text) => invoke("mana:chatHistory:editMessage", { threadId, messageId, text }),
  revertToNode: (threadId, messageId) => invoke("mana:chatHistory:revertToNode", { threadId, messageId }),
  getStorageStats: () => invoke("mana:chatHistory:getStorageStats"),
  enforceQuota: (maxBytes) => invoke("mana:chatHistory:enforceQuota", { maxBytes }),
};

const offlineLog = {
  appendEntry: (entry) => invoke("mana:offlineLog:appendEntry", entry || {}),
  listUnsynced: (novelId) => invoke("mana:offlineLog:listUnsynced", { novelId }),
  listUnsyncedByType: (novelId) => invoke("mana:offlineLog:listUnsyncedByType", { novelId }),
  markSynced: (entryIds) => invoke("mana:offlineLog:markSynced", { entryIds }),
  discardUnsynced: (novelId) => invoke("mana:offlineLog:discardUnsynced", { novelId }),
  getStorageStats: () => invoke("mana:offlineLog:getStorageStats"),
  enforceQuota: (maxBytes) => invoke("mana:offlineLog:enforceQuota", { maxBytes }),
};

const networkStatus = {
  set: (status) => invoke("mana:networkStatus:set", { status }),
};

const feedback = {
  submit: (payload, options) => invoke('mana:feedback:submit', { payload: payload || {}, options: options || {} }),
};

const lanRemote = {
  getStatus: () => invoke('mana:lan:getStatus'),
  setEnabled: (enabled, port) => invoke('mana:lan:setEnabled', { enabled, port }),
  rotateCode: () => invoke('mana:lan:rotateCode'),
};

/**
 * prompt — custom modal dialog to replace the removed window.prompt().
 * Uses DOM directly (preload and renderer share the DOM).
 * Returns Promise<string | null> — null means user cancelled.
 */
const prompt = {
  show: (message, defaultValue) => {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;';
      const dialog = document.createElement('div');
      dialog.style.cssText = 'background:#1e1e1e;border:1px solid #3c3c3c;border-radius:8px;padding:20px;min-width:320px;box-shadow:0 8px 32px rgba(0,0,0,0.3);';
      const msgEl = document.createElement('div');
      msgEl.textContent = message;
      msgEl.style.cssText = 'color:#cccccc;margin-bottom:12px;font-size:14px;';
      const input = document.createElement('input');
      input.type = 'text';
      input.value = defaultValue ?? '';
      input.style.cssText = 'width:100%;padding:8px 12px;background:#252526;border:1px solid #3c3c3c;color:#cccccc;border-radius:4px;font-size:14px;outline:none;box-sizing:border-box;';
      const btnRow = document.createElement('div');
      btnRow.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;margin-top:16px;';
      const cancelBtn = document.createElement('button');
      cancelBtn.textContent = '取消';
      cancelBtn.style.cssText = 'padding:6px 16px;background:#3c3c3c;color:#cccccc;border:none;border-radius:4px;cursor:pointer;font-size:13px;';
      const okBtn = document.createElement('button');
      okBtn.textContent = '确定';
      okBtn.style.cssText = 'padding:6px 16px;background:#007acc;color:white;border:none;border-radius:4px;cursor:pointer;font-size:13px;';
      btnRow.appendChild(cancelBtn);
      btnRow.appendChild(okBtn);
      dialog.appendChild(msgEl);
      dialog.appendChild(input);
      dialog.appendChild(btnRow);
      overlay.appendChild(dialog);
      document.body.appendChild(overlay);
      input.focus();
      input.select();
      const close = (result) => { if (document.body.contains(overlay)) document.body.removeChild(overlay); resolve(result); };
      const onKeyDown = (e) => {
        if (e.key === 'Enter') { e.preventDefault(); close(input.value); }
        if (e.key === 'Escape') { e.preventDefault(); close(null); }
      };
      okBtn.onclick = () => close(input.value);
      cancelBtn.onclick = () => close(null);
      overlay.addEventListener('click', (e) => { if (e.target === overlay) close(null); });
      input.addEventListener('keydown', onKeyDown);
    });
  },
};

const importBridge = {
  start: (payload) => invoke('mana:import:start', payload || {}),
  get: (runId) => invoke('mana:import:get', { runId }),
  cancel: (runId) => invoke('mana:import:cancel', { runId }),
  resume: (runId) => invoke('mana:import:resume', { runId }),
  finalize: (runId, target) => invoke('mana:import:finalize', { runId, target }),
  pickFiles: () => invoke("mana:import:pickFiles"),
  parseFiles: (filePaths) => invoke("mana:import:parseFiles", { filePaths }),
  checkDuplicate: (filePaths) => invoke("mana:import:checkDuplicate", { filePaths }),
  createStaging: (payload) => invoke("mana:import:createStaging", payload || {}),
  getStaging: (importId) => invoke("mana:import:getStaging", { importId }),
  listStaging: () => invoke("mana:import:listStaging"),
  discardStaging: (importId) => invoke("mana:import:discardStaging", { importId }),
  promoteToNovel: (importId, title, dir) => invoke("mana:import:promoteToNovel", { importId, title, dir }),
  cleanup: () => invoke("mana:import:cleanup"),
  analyze: (importId) => invoke("mana:import:analyze", { importId }),
  finalizeAnalysis: (importId) => invoke("mana:import:finalizeAnalysis", { importId }),
  checkAnalysis: (importId) => invoke("mana:import:checkAnalysis", { importId }),
  detectConflicts: (importId, novelId) => invoke("mana:import:detectConflicts", { importId, novelId }),
  createMerge: (importId, novelId) => invoke("mana:import:createMerge", { importId, novelId }),
  getMerge: (sessionId) => invoke("mana:import:getMerge", { sessionId }),
  resolveConflict: (sessionId, itemId, decision, opts) => invoke("mana:import:resolveConflict", { sessionId, itemId, decision, ...opts }),
  resolveRunConflict: (runId, itemId, decision, opts) => invoke('mana:import:resolveConflict', { runId, itemId, decision, ...(opts || {}) }),
  resetMerge: (sessionId) => invoke("mana:import:resetMerge", { sessionId }),
  getMergeSummary: (sessionId) => invoke("mana:import:getMergeSummary", { sessionId }),
  finalizeMerge: (sessionId) => invoke("mana:import:finalizeMerge", { sessionId }),
  getStagingCharacters: (importId) => invoke("mana:import:getStagingCharacters", { importId }),
  saveStagingCharacters: (importId, characters) => invoke("mana:import:saveStagingCharacters", { importId, characters }),
  enrichStagingCharacters: (importId, workAssignments) => invoke("mana:import:enrichStagingCharacters", { importId, workAssignments }),
  aiMerge: (leftContent, rightContent, conflictType, userNote) =>
    invoke("mana:import:aiMerge", { leftContent, rightContent, conflictType, userNote }),
};

contextBridge.exposeInMainWorld('mana', {
  ipcVersion: () => 1,
  fs,
  config,
  novel,
  modelConfig,
  codex,
  chatHistory,
  offlineLog,
  feedback,
  lanRemote,
  networkStatus,
  prompt,
  import: importBridge,
  updater: {
    checkNow: () => invoke('mana:updater:checkNow'),
  },
});
