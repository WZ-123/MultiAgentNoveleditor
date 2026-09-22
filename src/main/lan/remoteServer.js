'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = fs.promises;
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const appConfig = require('../store/appConfig');
const { paths } = require('../store/paths');
const novelsStore = require('../store/novels');
const clientEvents = require('../events/clientEvents');
const ipcBridge = require('./ipcBridge');
const { getRendererDevOrigin } = require('./rendererDevOrigin');

const DEFAULT_PORT = 8788;
const COOKIE_NAME = 'mana_lan_token';
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

let server = null;
let serverPort = DEFAULT_PORT;
let accessCode = generateAccessCode();
let sessionToken = generateToken();

const BLOCKED_CHANNELS = new Set([
  'mana:fs:pickDirectory',
  'mana:fs:pickFile',
  'mana:import:pickFiles',
  'mana:import:parseFiles',
  'mana:import:checkDuplicate',
  'mana:import:promoteToNovel',
  'mana:novel:create',
  'mana:novel:importExisting',
]);

const ALLOWED_PREFIXES = [
  'mana:chatHistory:',
  'mana:codex:',
  'mana:config:',
  'mana:feedback:',
  'mana:import:',
  'mana:modelConfig:',
  'mana:networkStatus:',
  'mana:novel:',
  'mana:offlineLog:',
  'mana:updater:',
];

const FS_PATH_KEYS = {
  'mana:fs:readFile': ['filePath'],
  'mana:fs:writeFile': ['filePath'],
  'mana:fs:readJson': ['filePath'],
  'mana:fs:writeJson': ['filePath'],
  'mana:fs:appendJsonl': ['filePath'],
  'mana:fs:listDir': ['dir'],
  'mana:fs:ensureDir': ['dir'],
  'mana:fs:pathExists': ['path'],
  'mana:fs:deleteFile': ['filePath'],
};

const CONTENT_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.webp': 'image/webp',
};

function generateAccessCode() {
  return String(crypto.randomInt(100000, 1000000));
}

function generateToken() {
  return crypto.randomBytes(24).toString('base64url');
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function isAuthenticated(req) {
  return parseCookies(req)[COOKIE_NAME] === sessionToken;
}

function send(res, statusCode, body, headers = {}) {
  res.writeHead(statusCode, {
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

function sendJson(res, statusCode, body, headers = {}) {
  send(res, statusCode, JSON.stringify(body), {
    'Content-Type': 'application/json; charset=utf-8',
    ...headers,
  });
}

async function readJsonBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > 10 * 1024 * 1024) throw new Error('Request body too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function isPrivateIPv4(address) {
  return /^10\./.test(address) ||
    /^192\.168\./.test(address) ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(address);
}

function getLocalHostName() {
  try {
    const value = execFileSync('scutil', ['--get', 'LocalHostName'], {
      encoding: 'utf8',
      timeout: 1000,
    }).trim();
    if (value) return value;
  } catch {
    // Non-macOS or unavailable in sandbox; fall back below.
  }
  const host = os.hostname().replace(/\.local$/i, '').split('.')[0];
  return host || '';
}

function getHostCandidates(port = serverPort) {
  const names = new Set();
  const localHostName = getLocalHostName();
  const osHostName = os.hostname().replace(/\.local$/i, '');
  if (localHostName) names.add(localHostName);
  if (osHostName) names.add(osHostName);
  return Array.from(names)
    .filter(Boolean)
    .map((name) => ({
      host: `${name}.local`,
      url: `http://${name}.local:${port}`,
      testUrl: `http://${name}.local:${port}/api/lan/status`,
    }));
}

function getLanAddresses(port = serverPort) {
  const nets = os.networkInterfaces();
  const addresses = [];
  for (const [interfaceName, entries] of Object.entries(nets)) {
    for (const entry of entries || []) {
      if (entry.family !== 'IPv4' || entry.internal || !entry.address) continue;
      addresses.push({
        interfaceName,
        address: entry.address,
        url: `http://${entry.address}:${port}`,
        testUrl: `http://${entry.address}:${port}/api/lan/status`,
        private: isPrivateIPv4(entry.address),
      });
    }
  }
  return addresses.sort((a, b) => {
    if (a.interfaceName === 'en0' && b.interfaceName !== 'en0') return -1;
    if (b.interfaceName === 'en0' && a.interfaceName !== 'en0') return 1;
    if (a.private !== b.private) return a.private ? -1 : 1;
    return a.address.localeCompare(b.address);
  });
}

function getStatus() {
  const addresses = getLanAddresses(serverPort);
  const hostnames = getHostCandidates(serverPort);
  return {
    enabled: !!server,
    running: !!server,
    port: serverPort,
    accessCode,
    addresses,
    hostnames,
    primaryUrl: hostnames[0]?.url || addresses[0]?.url || null,
    loopbackUrl: `http://127.0.0.1:${serverPort}`,
    statusPath: '/api/lan/status',
    updatedAt: new Date().toISOString(),
  };
}

async function getAllowedRoots() {
  const roots = [paths().root];
  try {
    const novels = await novelsStore.listNovels();
    for (const novel of novels) {
      if (novel?.dir) roots.push(novel.dir);
    }
  } catch {
    // The app data root still covers import staging and runtime state.
  }
  return roots.map((root) => path.resolve(root));
}

function isPathInside(childPath, parentPath) {
  const child = path.resolve(childPath);
  const parent = path.resolve(parentPath);
  return child === parent || child.startsWith(parent + path.sep);
}

async function assertAllowedPath(rawPath) {
  if (!rawPath || typeof rawPath !== 'string') {
    throw new Error('Path is required');
  }
  const target = path.resolve(rawPath);
  const roots = await getAllowedRoots();
  if (!roots.some((root) => isPathInside(target, root))) {
    throw new Error('LAN remote file access is limited to app data and registered novel folders');
  }
}

async function assertRpcAllowed(channel, payload) {
  if (BLOCKED_CHANNELS.has(channel)) {
    throw new Error(`This operation must be completed in the Mac desktop window: ${channel}`);
  }
  if (channel.startsWith('mana:lan:')) {
    if (channel === 'mana:lan:getStatus') return;
    throw new Error(`This LAN setting can only be changed in the Mac desktop window: ${channel}`);
  }
  if (
    channel === 'mana:config:setApp' &&
    payload?.patch &&
    (Object.prototype.hasOwnProperty.call(payload.patch, 'lanRemote')
      || Object.prototype.hasOwnProperty.call(payload.patch, 'testing'))
  ) {
    throw new Error('LAN remote and local test settings can only be changed in the Mac desktop window');
  }
  if (channel.startsWith('mana:fs:')) {
    const keys = FS_PATH_KEYS[channel];
    if (!keys) throw new Error(`LAN remote file channel is not allowed: ${channel}`);
    for (const key of keys) {
      await assertAllowedPath(payload?.[key]);
    }
    return;
  }
  if (ALLOWED_PREFIXES.some((prefix) => channel.startsWith(prefix))) return;
  throw new Error(`LAN remote channel is not allowed: ${channel}`);
}

function sanitizeRpcResultForLan(channel, result) {
  if (channel !== 'mana:config:getApp' || !result || typeof result !== 'object') return result;
  const value = result.value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
  const sanitizedValue = { ...value };
  // Local test switches are a desktop-only control plane. The generic app
  // config getter remains available to the LAN client, but must not become a
  // side channel for reading whether a local Codex account is under test.
  delete sanitizedValue.testing;
  return { ...result, value: sanitizedValue };
}

function sanitizeClientEventForLan(packet) {
  if (packet?.channel !== 'runtime:changed' || !packet.payload || typeof packet.payload !== 'object') {
    return packet;
  }
  if (!Object.prototype.hasOwnProperty.call(packet.payload, 'codexMock')) return packet;
  const payload = { ...packet.payload };
  delete payload.codexMock;
  // A Codex toggle event currently contains only its private status plus a
  // timestamp. Do not forward a meaningless shell event to remote clients.
  const meaningfulKeys = Object.keys(payload).filter((key) => key !== 'ts');
  if (meaningfulKeys.length === 0) return null;
  return { ...packet, payload };
}

function bridgeScript() {
  return `
(() => {
  if (window.mana) return;

  async function rpc(channel, payload) {
    const res = await fetch('/api/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel, payload }),
    });
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    if (res.status === 401) {
      window.location.reload();
      throw new Error('LAN remote login expired');
    }
    if (!res.ok) {
      throw new Error(data?.error || ('LAN RPC failed: ' + res.status));
    }
    if (data && typeof data === 'object' && 'ok' in data) {
      if (data.ok) return data.value;
      throw new Error(data.error || 'IPC error');
    }
    return data;
  }

  function invoke(channel, payload) {
    return rpc(channel, payload);
  }

  function localOnly() {
    return Promise.reject(new Error('此操作需要在 Mac 本机窗口完成'));
  }

  const eventListeners = new Map();
  let eventSource = null;

  function ensureEvents() {
    if (eventSource) return;
    eventSource = new EventSource('/api/events');
    eventSource.onmessage = (event) => {
      if (!event.data || event.data === ':heartbeat') return;
      let packet = null;
      try { packet = JSON.parse(event.data); } catch { return; }
      const listeners = eventListeners.get(packet.channel);
      if (!listeners) return;
      for (const handler of Array.from(listeners)) {
        try { handler(packet.payload); } catch (err) { console.error('[lanRemote] event handler failed', err); }
      }
    };
    eventSource.onerror = () => {
      if (eventSource) {
        eventSource.close();
        eventSource = null;
      }
      setTimeout(() => {
        if (eventListeners.size > 0) ensureEvents();
      }, 1500);
    };
  }

  function onChannel(channel, handler) {
    if (!eventListeners.has(channel)) eventListeners.set(channel, new Set());
    eventListeners.get(channel).add(handler);
    ensureEvents();
    return () => {
      const set = eventListeners.get(channel);
      if (!set) return;
      set.delete(handler);
      if (set.size === 0) eventListeners.delete(channel);
      if (eventListeners.size === 0 && eventSource) {
        eventSource.close();
        eventSource = null;
      }
    };
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
    pickDirectory: localOnly,
    pickFile: localOnly,
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

  const codex = {
    status: () => invoke('mana:codex:status'),
    accountStatus: (payload) => invoke('mana:codex:accountStatus', payload || {}),
    accountLogin: (mode) => invoke('mana:codex:accountLogin', { mode }),
    accountCancel: (loginId) => invoke('mana:codex:accountCancel', { loginId }),
    accountLogout: () => invoke('mana:codex:accountLogout'),
    accountRateLimits: () => invoke('mana:codex:accountRateLimits'),
    refreshSubscriptionModels: (expectedRevision) => invoke('mana:codex:refreshSubscriptionModels', { expectedRevision }),
    startTurn: (payload) => invoke('mana:codex:startTurn', payload || {}),
    getWritingAuthorization: (novelId) => invoke('mana:codex:getWritingAuthorization', { novelId }),
    setWritingAuthorization: (novelId, mode) => invoke('mana:codex:setWritingAuthorization', { novelId, mode }),
    revokeWritingAuthorization: (novelId) => invoke('mana:codex:revokeWritingAuthorization', { novelId }),
    getWritingProgress: (novelId, conversationId) => invoke('mana:codex:getWritingProgress', { novelId, conversationId }),
    getConversationState: (payload) => invoke('mana:codex:getConversationState', payload || {}),
    getRunState: (payload) => invoke('mana:codex:getRunState', payload || {}),
    getResourceContext: (payload) => invoke('mana:codex:getResourceContext', payload || {}),
    interrupt: (payload) => invoke('mana:codex:interrupt', payload || {}),
    resolveConfirmation: (payload) => invoke('mana:codex:resolveConfirmation', payload || {}),
    onEvent: (handler) => onChannel('mana:codex:event', handler),
  };

  const novel = {
    list: () => invoke('mana:novel:list'),
    create: localOnly,
    open: (id) => invoke('mana:novel:open', { id }),
    close: () => invoke('mana:novel:close'),
    active: () => invoke('mana:novel:active'),
    saveMeta: (id, patch) => invoke('mana:novel:saveMeta', { id, patch }),
    importExisting: localOnly,
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
    onChapterChanged: (callback) => onChannel('mana:chapter:changed', callback),
    onActiveChanged: (callback) => onChannel('mana:novel:activeChanged', callback),
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
  onSetupProgress: (handler) => onChannel('mana:modelConfig:setupProgress', handler),
  onChanged: (handler) => onChannel('mana:modelConfig:changed', handler),

    saveCredential: (credential, expectedRevision) => invoke('mana:modelConfig:saveCredential', { credential, expectedRevision }),
    deleteCredential: (id, expectedRevision) => invoke('mana:modelConfig:deleteCredential', { id, expectedRevision }),
    previewConnection: (payload) => invoke('mana:modelConfig:previewConnection', payload),
    discoverConnection: (payload) => invoke('mana:modelConfig:discoverConnection', payload),
    saveConnection: (connection, expectedRevision) => invoke('mana:modelConfig:saveConnection', { connection, expectedRevision }),
    deleteConnection: (id, expectedRevision) => invoke('mana:modelConfig:deleteConnection', { id, expectedRevision }),
    verifyModel: (payload) => invoke('mana:modelConfig:verifyModel', payload),
    setActive: (connectionId, modelId, reasoningEffort, expectedRevision, interruptActive = false) => invoke('mana:modelConfig:setActive', { connectionId, modelId, reasoningEffort, expectedRevision, interruptActive }),
  };

  const chatHistory = {
    listThreads: (novelId) => invoke('mana:chatHistory:listThreads', { novelId }),
    createThread: (payload) => invoke('mana:chatHistory:createThread', payload || {}),
    getThread: (threadId) => invoke('mana:chatHistory:getThread', { threadId }),
    deleteThread: (threadId) => invoke('mana:chatHistory:deleteThread', { threadId }),
    renameThread: (threadId, title) => invoke('mana:chatHistory:renameThread', { threadId, title }),
    appendMessage: (threadId, message) => invoke('mana:chatHistory:appendMessage', { threadId, message }),
    editMessage: (threadId, messageId, text) => invoke('mana:chatHistory:editMessage', { threadId, messageId, text }),
    revertToNode: (threadId, messageId) => invoke('mana:chatHistory:revertToNode', { threadId, messageId }),
    getStorageStats: () => invoke('mana:chatHistory:getStorageStats'),
    enforceQuota: (maxBytes) => invoke('mana:chatHistory:enforceQuota', { maxBytes }),
  };

  const offlineLog = {
    appendEntry: (entry) => invoke('mana:offlineLog:appendEntry', entry || {}),
    listUnsynced: (novelId) => invoke('mana:offlineLog:listUnsynced', { novelId }),
    listUnsyncedByType: (novelId) => invoke('mana:offlineLog:listUnsyncedByType', { novelId }),
    markSynced: (entryIds) => invoke('mana:offlineLog:markSynced', { entryIds }),
    discardUnsynced: (novelId) => invoke('mana:offlineLog:discardUnsynced', { novelId }),
    getStorageStats: () => invoke('mana:offlineLog:getStorageStats'),
    enforceQuota: (maxBytes) => invoke('mana:offlineLog:enforceQuota', { maxBytes }),
  };

  const importBridge = {
    pickFiles: localOnly,
    parseFiles: localOnly,
    checkDuplicate: localOnly,
    createStaging: (payload) => invoke('mana:import:createStaging', payload || {}),
    start: (payload) => invoke('mana:import:start', payload || {}),
    get: (runId) => invoke('mana:import:get', { runId }),
    cancel: (runId) => invoke('mana:import:cancel', { runId }),
    resume: (runId) => invoke('mana:import:resume', { runId }),
    finalize: (runId, target) => invoke('mana:import:finalize', { runId, target }),
    getStaging: (importId) => invoke('mana:import:getStaging', { importId }),
    listStaging: () => invoke('mana:import:listStaging'),
    discardStaging: (importId) => invoke('mana:import:discardStaging', { importId }),
    promoteToNovel: localOnly,
    cleanup: () => invoke('mana:import:cleanup'),
    analyze: (importId) => invoke('mana:import:analyze', { importId }),
    finalizeAnalysis: (importId) => invoke('mana:import:finalizeAnalysis', { importId }),
    checkAnalysis: (importId) => invoke('mana:import:checkAnalysis', { importId }),
    detectConflicts: (importId, novelId) => invoke('mana:import:detectConflicts', { importId, novelId }),
    createMerge: (importId, novelId) => invoke('mana:import:createMerge', { importId, novelId }),
    getMerge: (sessionId) => invoke('mana:import:getMerge', { sessionId }),
    resolveConflict: (sessionId, itemId, decision, opts) => invoke('mana:import:resolveConflict', { sessionId, itemId, decision, ...opts }),
    resetMerge: (sessionId) => invoke('mana:import:resetMerge', { sessionId }),
    getMergeSummary: (sessionId) => invoke('mana:import:getMergeSummary', { sessionId }),
    finalizeMerge: (sessionId) => invoke('mana:import:finalizeMerge', { sessionId }),
    getStagingCharacters: (importId) => invoke('mana:import:getStagingCharacters', { importId }),
    saveStagingCharacters: (importId, characters) => invoke('mana:import:saveStagingCharacters', { importId, characters }),
    enrichStagingCharacters: (importId, workAssignments) => invoke('mana:import:enrichStagingCharacters', { importId, workAssignments }),
    aiMerge: (leftContent, rightContent, conflictType, userNote) => invoke('mana:import:aiMerge', { leftContent, rightContent, conflictType, userNote }),
  };

  window.mana = {
    ipcVersion: () => 1,
    isLanRemote: true,
    fs,
    config,
    codex,
    novel,
    modelConfig,
    chatHistory,
    offlineLog,
    feedback: {
      submit: (payload, options) => invoke('mana:feedback:submit', { payload: payload || {}, options: options || {} }),
    },
    networkStatus: {
      set: (status) => invoke('mana:networkStatus:set', { status }),
    },
    prompt: {
      show: (message, defaultValue) => Promise.resolve(window.prompt(message, defaultValue ?? '')),
    },
    import: importBridge,
    updater: {
      checkNow: () => invoke('mana:updater:checkNow'),
    },
    lanRemote: {
      getStatus: () => invoke('mana:lan:getStatus'),
    },
  };
})();
`;
}

function loginPage(errorMessage = '') {
  const safeError = String(errorMessage || '').replace(/[<>&"]/g, (ch) => ({
    '<': '&lt;',
    '>': '&gt;',
    '&': '&amp;',
    '"': '&quot;',
  }[ch]));
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>MultiAgentNovelAssistant LAN</title>
  <style>
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #1e1e1e; color: #d4d4d4; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    main { width: min(420px, calc(100vw - 32px)); border: 1px solid #3c3c3c; background: #252526; border-radius: 8px; padding: 24px; box-sizing: border-box; }
    h1 { margin: 0 0 8px; font-size: 18px; font-weight: 650; color: #fff; }
    p { margin: 0 0 18px; color: #9ca3af; font-size: 13px; line-height: 1.6; }
    label { display: block; font-size: 12px; color: #9ca3af; margin-bottom: 6px; }
    input { width: 100%; box-sizing: border-box; border: 1px solid #3c3c3c; border-radius: 6px; background: #1e1e1e; color: #fff; font-size: 22px; letter-spacing: 4px; padding: 10px 12px; text-align: center; }
    button { margin-top: 14px; width: 100%; border: 0; border-radius: 6px; background: #2563eb; color: white; font-weight: 650; padding: 10px 12px; cursor: pointer; }
    .error { color: #fca5a5; min-height: 20px; margin-top: 10px; font-size: 12px; }
  </style>
</head>
<body>
  <main>
    <h1>局域网遥控登录</h1>
    <p>输入 Mac 桌面端“局域网遥控”设置里显示的 6 位访问码。登录后，所有读写和 AI 调用仍在这台 Mac 上执行。</p>
    <form method="post" action="/api/lan/auth">
      <label for="code">访问码</label>
      <input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" autofocus />
      <button type="submit">连接</button>
      <div class="error">${safeError}</div>
    </form>
  </main>
</body>
</html>`;
}

function injectBridge(html) {
  if (html.includes('/__mana_remote_bridge.js')) return html;
  const script = '<script src="/__mana_remote_bridge.js"></script>';
  if (html.includes('<head>')) return html.replace('<head>', `<head>${script}`);
  return `${script}${html}`;
}

async function proxyDev(req, res, url) {
  const origin = getRendererDevOrigin();
  if (!origin) return false;
  const target = `${origin}${url.pathname}${url.search}`;
  const upstream = await fetch(target, {
    method: 'GET',
    headers: { Accept: req.headers.accept || '*/*' },
  });
  const headers = {};
  upstream.headers.forEach((value, key) => {
    if (key === 'content-length' || key === 'content-encoding') return;
    headers[key] = value;
  });
  const contentType = upstream.headers.get('content-type') || '';
  if (contentType.includes('text/html')) {
    const html = injectBridge(await upstream.text());
    send(res, upstream.status, html, { ...headers, 'Content-Type': 'text/html; charset=utf-8' });
    return true;
  }
  const body = Buffer.from(await upstream.arrayBuffer());
  send(res, upstream.status, body, headers);
  return true;
}

function safeStaticPath(distRoot, pathname) {
  const decoded = decodeURIComponent(pathname.split('?')[0]);
  const normalized = decoded === '/' ? '/index.html' : decoded;
  const target = path.resolve(distRoot, `.${normalized}`);
  if (!isPathInside(target, distRoot)) return null;
  return target;
}

async function serveDist(req, res, url) {
  const distRoot = path.resolve(__dirname, '../../..', 'dist');
  let file = safeStaticPath(distRoot, url.pathname);
  if (!file) {
    send(res, 403, 'Forbidden', { 'Content-Type': 'text/plain; charset=utf-8' });
    return;
  }
  let stat = null;
  try {
    stat = await fsp.stat(file);
    if (stat.isDirectory()) file = path.join(file, 'index.html');
  } catch {
    file = path.join(distRoot, 'index.html');
  }
  try {
    const ext = path.extname(file).toLowerCase();
    if (ext === '.html') {
      const html = injectBridge(await fsp.readFile(file, 'utf8'));
      send(res, 200, html, { 'Content-Type': 'text/html; charset=utf-8' });
      return;
    }
    const body = await fsp.readFile(file);
    send(res, 200, body, {
      'Cache-Control': 'public, max-age=3600',
      'Content-Type': CONTENT_TYPES[ext] || 'application/octet-stream',
    });
  } catch {
    send(res, 404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' });
  }
}

async function handleAuth(req, res) {
  let code = '';
  const contentType = req.headers['content-type'] || '';
  if (contentType.includes('application/json')) {
    const body = await readJsonBody(req);
    code = String(body.code || '').trim();
  } else {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const params = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
    code = String(params.get('code') || '').trim();
  }
  if (code !== accessCode) {
    send(res, 401, loginPage('访问码不正确'), { 'Content-Type': 'text/html; charset=utf-8' });
    return;
  }
  res.writeHead(302, {
    'Cache-Control': 'no-store',
    'Set-Cookie': `${COOKIE_NAME}=${encodeURIComponent(sessionToken)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}`,
    Location: '/',
  });
  res.end();
}

async function handleRpc(req, res) {
  const body = await readJsonBody(req);
  const channel = String(body.channel || '');
  await assertRpcAllowed(channel, body.payload);
  if (!ipcBridge.hasHandler(channel)) {
    throw new Error(`RPC channel is not available: ${channel}`);
  }
  const result = await ipcBridge.invoke(channel, body.payload);
  sendJson(res, 200, sanitizeRpcResultForLan(channel, result));
}

function handleEvents(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
  });
  res.write('\n');
  const unsubscribe = clientEvents.subscribe((packet) => {
    const safePacket = sanitizeClientEventForLan(packet);
    if (safePacket) res.write(`data: ${JSON.stringify(safePacket)}\n\n`);
  });
  const heartbeat = setInterval(() => {
    res.write(':heartbeat\n\n');
  }, 25000);
  req.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
}

async function handleRequest(req, res) {
  const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
  try {
    if (req.method === 'GET' && url.pathname === '/__mana_remote_bridge.js') {
      if (!isAuthenticated(req)) {
        send(res, 401, 'Unauthorized', { 'Content-Type': 'text/plain; charset=utf-8' });
        return;
      }
      send(res, 200, bridgeScript(), { 'Content-Type': 'text/javascript; charset=utf-8' });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/lan/auth') {
      await handleAuth(req, res);
      return;
    }

    if (url.pathname === '/api/lan/status') {
      if (!isAuthenticated(req)) {
        sendJson(res, 401, { ok: false, error: 'Unauthorized' });
        return;
      }
      sendJson(res, 200, { ok: true, value: getStatus() });
      return;
    }

    if (url.pathname === '/api/rpc') {
      if (!isAuthenticated(req)) {
        sendJson(res, 401, { ok: false, error: 'Unauthorized' });
        return;
      }
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'Method not allowed' });
        return;
      }
      await handleRpc(req, res);
      return;
    }

    if (url.pathname === '/api/events') {
      if (!isAuthenticated(req)) {
        sendJson(res, 401, { ok: false, error: 'Unauthorized' });
        return;
      }
      handleEvents(req, res);
      return;
    }

    if (!isAuthenticated(req)) {
      send(res, 200, loginPage(), { 'Content-Type': 'text/html; charset=utf-8' });
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      send(res, 405, 'Method not allowed', { 'Content-Type': 'text/plain; charset=utf-8' });
      return;
    }

    if (await proxyDev(req, res, url)) return;
    await serveDist(req, res, url);
  } catch (err) {
    const message = err?.message || String(err);
    if (url.pathname.startsWith('/api/')) {
      sendJson(res, 500, { ok: false, error: message });
      return;
    }
    send(res, 500, message, { 'Content-Type': 'text/plain; charset=utf-8' });
  }
}

async function start(options = {}) {
  const port = Number(options.port ?? DEFAULT_PORT);
  if (server && serverPort === port) return getStatus();
  if (server) await stop();
  serverPort = port;
  sessionToken = generateToken();
  accessCode = generateAccessCode();
  server = http.createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      sendJson(res, 500, { ok: false, error: err?.message || String(err) });
    });
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(serverPort, '0.0.0.0', () => {
        server.off('error', reject);
        const address = server.address();
        if (address && typeof address === 'object' && address.port) {
          serverPort = address.port;
        }
        resolve();
      });
    });
  } catch (err) {
    server = null;
    throw err;
  }
  console.log(`[lanRemote] listening on http://0.0.0.0:${serverPort}`);
  return getStatus();
}

async function stop() {
  if (!server) return getStatus();
  const closing = server;
  server = null;
  await new Promise((resolve) => closing.close(() => resolve()));
  return getStatus();
}

async function applyConfig(config = {}) {
  const next = {
    enabled: config.enabled === true,
    port: Number(config.port || DEFAULT_PORT),
  };
  if (!next.enabled) return stop();
  return start({ port: next.port });
}

async function syncFromAppConfig() {
  const cfg = await appConfig.load();
  return applyConfig(cfg.lanRemote || {});
}

function rotateCode() {
  accessCode = generateAccessCode();
  sessionToken = generateToken();
  return getStatus();
}

module.exports = {
  DEFAULT_PORT,
  applyConfig,
  getStatus,
  rotateCode,
  start,
  stop,
  syncFromAppConfig,
  _debug: {
    assertRpcAllowed,
    bridgeScript,
    loginPage,
    sanitizeClientEventForLan,
    sanitizeRpcResultForLan,
  },
};
