const { contextBridge, ipcRenderer } = require('electron');

function unwrap(promise) {
  return promise.then((res) => {
    if (res && typeof res === 'object' && 'ok' in res) {
      if (res.ok) return res.value;
      throw new Error(res.error || 'IPC error');
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
  listSubagents: () => invoke('mana:config:listSubagents'),
  getSubagent: (id) => invoke('mana:config:getSubagent', { id }),
  saveSubagent: (subagent) => invoke('mana:config:saveSubagent', { subagent }),
  deleteSubagent: (id) => invoke('mana:config:deleteSubagent', { id }),
  cloneBuiltinSubagent: (id, newId) => invoke('mana:config:cloneBuiltinSubagent', { id, newId }),
  listDags: () => invoke('mana:config:listDags'),
  listDagsByStage: (stage) => invoke('mana:config:listDagsByStage', { stage }),
  getDag: (id) => invoke('mana:config:getDag', { id }),
  saveDag: (dag) => invoke('mana:config:saveDag', { dag }),
  deleteDag: (id) => invoke('mana:config:deleteDag', { id }),
  cloneDag: (id, newId, newName) => invoke('mana:config:cloneDag', { id, newId, newName }),
  setSecret: (id, value) => invoke('mana:config:setSecret', { id, value }),
  deleteSecret: (id) => invoke('mana:config:deleteSecret', { id }),
  listSecretIds: () => invoke('mana:config:listSecretIds'),
  secretsAvailable: () => invoke('mana:config:secretsAvailable'),
  listSkills: () => invoke('mana:config:listSkills'),
  getSkill: (id) => invoke('mana:config:getSkill', { id }),
  saveSkill: (skill) => invoke('mana:config:saveSkill', { skill }),
  deleteSkill: (id) => invoke('mana:config:deleteSkill', { id }),
  assignSkill: (skillId, subagentId) => invoke('mana:config:assignSkill', { skillId, subagentId }),
  unassignSkill: (skillId, subagentId) => invoke('mana:config:unassignSkill', { skillId, subagentId }),
  exportSkill: (id) => invoke('mana:config:exportSkill', { id }),
  importSkill: (bundle) => invoke('mana:config:importSkill', { bundle }),
};

const runtime = {
  runSubagent: (payload) => invoke('mana:runtime:runSubagent', payload),
  cancel: (runId) => invoke('mana:runtime:cancel', { runId }),
  listRuns: () => invoke('mana:runtime:listRuns'),
  getRunEvents: (runId) => invoke('mana:runtime:getRunEvents', { runId }),
  resolveToolConfirmation: (runId, toolUseId, decision) =>
    invoke('mana:runtime:resolveToolConfirmation', { runId, toolUseId, decision }),
  listPendingConfirmations: () => invoke('mana:runtime:listPendingConfirmations'),
  runPipeline: (payload) => invoke('mana:runtime:runPipeline', payload),
  cancelPipeline: (pipelineRunId) => invoke('mana:runtime:cancelPipeline', { pipelineRunId }),
  resumePipeline: (pipelineRunId, nodeId, payload) =>
    invoke('mana:runtime:resumePipeline', { pipelineRunId, nodeId, payload }),
  listActivePipelines: () => invoke('mana:runtime:listActivePipelines'),
  // ---------- Driver management (Phase 5) ----------
  listDrivers: () => invoke('mana:runtime:listDrivers'),
  getActiveDriver: () => invoke('mana:runtime:getActiveDriver'),
  setActiveDriver: (id) => invoke('mana:runtime:setActiveDriver', { id }),
  getDriverCapabilities: (id) => invoke('mana:runtime:getDriverCapabilities', { id }),
  driverAvailability: (id) => invoke('mana:runtime:driverAvailability', { id }),
  autoDetectDriverBinPath: (id) => invoke('mana:runtime:autoDetectDriverBinPath', { id }),
  on: (channel, handler) => {
    if (channel !== 'agent:event' && channel !== 'pipeline:event' && channel !== 'runtime:changed') {
      throw new Error(`Unsupported runtime event channel: ${channel}`);
    }
    const wrapped = (_event, payload) => handler(payload);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
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
  readChapter: (id, name) => invoke('mana:novel:readChapter', { id, name }),
  saveChapter: (id, name, content, metadata) => invoke('mana:novel:saveChapter', { id, name, content, metadata }),
  deleteChapter: (id, name) => invoke('mana:novel:deleteChapter', { id, name }),
  readChapterMeta: (id, name) => invoke('mana:novel:readChapterMeta', { id, name }),
  computeNextInsertName: (id, afterFileName) => invoke('mana:novel:computeNextInsertName', { id, afterFileName }),
  getChapterNaming: (id) => invoke('mana:novel:getChapterNaming', { id }),
  setChapterNaming: (id, rule, separator) => invoke('mana:novel:setChapterNaming', { id, rule, separator }),
  nextChapterName: (id) => invoke('mana:novel:nextChapterName', { id }),
  onChapterChanged: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('mana:chapter:changed', handler);
    return () => ipcRenderer.removeListener('mana:chapter:changed', handler);
  },
  listCharacters: (id) => invoke('mana:novel:listCharacters', { id }),
  readCharacter: (id, charId) => invoke('mana:novel:readCharacter', { id, charId }),
  writeCharacter: (id, character) => invoke('mana:novel:writeCharacter', { id, character }),
  deleteCharacter: (id, charId) => invoke('mana:novel:deleteCharacter', { id, charId }),
  listAssets: (id) => invoke('mana:novel:listAssets', { id }),
  upsertAsset: (id, asset) => invoke('mana:novel:upsertAsset', { id, asset }),
  listTimeline: (id) => invoke('mana:novel:listTimeline', { id }),
  appendTimeline: (id, event) => invoke('mana:novel:appendTimeline', { id, event }),
  replaceTimeline: (id, events) => invoke('mana:novel:replaceTimeline', { id, events }),
  readWorld: (id) => invoke('mana:novel:readWorld', { id }),
  writeWorld: (id, world) => invoke('mana:novel:writeWorld', { id, world }),
  readStyleMemory: (id) => invoke('mana:novel:readStyleMemory', { id }),
  writeStyleMemory: (id, text) => invoke('mana:novel:writeStyleMemory', { id, text }),
  enrichCharacters: (id, fanworkName, characterIds, runId) => invoke('mana:novel:enrichCharacters', { id, fanworkName, characterIds, runId }),
  regenerateCharacters: (id, confirmed) => invoke('mana:novel:regenerateCharacters', { id, confirmed }),
};

const mcp = {
  listTools: () => invoke('mana:mcp:listTools'),
  callTool: (name, args) => invoke('mana:mcp:callTool', { name, args }),
};

const ccs = {
  detect:  () => invoke('mana:provider:detect'),
  list:    () => invoke('mana:provider:list'),
  current: () => invoke('mana:provider:current'),
  use:     (name) => invoke('mana:provider:use', { name }),
  add:     (payload) => invoke('mana:provider:add', payload || {}),
  remove:  (name) => invoke('mana:provider:remove', { name }),
  getProvider:   (id) => invoke('mana:provider:getProvider', { id }),
  addModel:      (providerId, model) => invoke('mana:provider:addModel', { providerId, model }),
  removeModel:   (providerId, modelId) => invoke('mana:provider:removeModel', { providerId, modelId }),
  discoverModels:(providerId) => invoke('mana:provider:discoverModels', { providerId }),
};

const modelAliases = {
  list:          () => invoke('mana:modelAliases:list'),
  getAlias:      (id) => invoke('mana:modelAliases:getAlias', { id }),
  saveAlias:     (alias) => invoke('mana:modelAliases:saveAlias', { alias }),
  deleteAlias:   (id) => invoke('mana:modelAliases:deleteAlias', { id }),
  resetToDefaults: () => invoke('mana:modelAliases:resetToDefaults'),
};

const chat = {
  complete: (payload) => invoke('mana:chat:complete', payload),
};

const chatAgent = {
  createSession: (ctx) => invoke('mana:chatAgent:createSession', ctx || {}),
  sendMessage: (sessionId, text) => invoke('mana:chatAgent:sendMessage', { sessionId, text }),
  cancel: (sessionId) => invoke('mana:chatAgent:cancel', { sessionId }),
  resolveAction: (sessionId, actionId, result) => invoke('mana:chatAgent:resolveAction', { sessionId, actionId, result }),
  closeSession: (sessionId) => invoke('mana:chatAgent:closeSession', { sessionId }),
  updateContext: (sessionId, editorContext) => invoke('mana:chatAgent:updateContext', { sessionId, editorContext }),
  getSessionInfo: (sessionId) => invoke('mana:chatAgent:getSessionInfo', { sessionId }),
  onEvent: (handler) => {
    const wrapped = (_event, payload) => handler(payload);
    ipcRenderer.on('chatAgent:event', wrapped);
    return () => ipcRenderer.removeListener('chatAgent:event', wrapped);
  },
};


const chatHistory = {
  listThreads: () => invoke("mana:chatHistory:listThreads"),
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
  runtime,
  novel,
  mcp,
  ccs,
  modelAliases,
  chat,
  chatAgent,
  chatHistory,
  offlineLog,
  feedback,
  networkStatus,
  prompt,
  import: importBridge,
  // Legacy bridge (kept for old WorkflowPanel until Phase 2 migration is complete).
  chatCompletions: (payload) => ipcRenderer.invoke('mana-chat-completions', payload),
});
