'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const { paths } = require('./paths');
const { readJson, writeJson } = require('./jsonStore');

const MCP_SECRET_BRIDGE_TIMEOUT_MS = 10_000;
let secretBridgeSequence = 0;
let secretBridgeListening = false;
const pendingSecretBridgeReads = new Map();

async function loadStore() {
  const data = await readJson(paths().secrets, { schemaVersion: 2, records: {} });
  return data && typeof data === 'object' ? data : { schemaVersion: 2, records: {} };
}

async function saveStore(store) {
  const directory = path.dirname(paths().secrets);
  await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
  try { await fsp.chmod(directory, 0o700); } catch { /* non-POSIX filesystem */ }
  await writeJson(paths().secrets, { schemaVersion: 2, ...store }, { mode: 0o600 });
  try { await fsp.chmod(paths().secrets, 0o600); } catch { /* non-POSIX filesystem */ }
}

// Provider and Relay credentials are deliberately stored in the application's
// local user-data directory. This avoids OS keychain prompts interrupting chat.
// The file is never packaged or synchronized and is permission-limited where
// the platform supports POSIX modes.
function isAvailable() {
  return true;
}

function automatedTestStorageEnabled() {
  return !isPackagedRuntime() && process.env.MANA_AUTOMATED_TEST === '1';
}

function isPackagedRuntime() {
  try {
    const { app } = require('electron');
    return app?.isPackaged === true;
  } catch {
    return false;
  }
}

// Kept as a compatibility export for callers that used the old storage API.
function allowInsecurePlaintext() {
  return true;
}

function canUseMcpSecretBridge() {
  return process.env.MANA_MCP_SECRET_BRIDGE === '1'
    && typeof process.send === 'function'
    && process.connected !== false;
}

function ensureMcpSecretBridgeListener() {
  if (secretBridgeListening || !canUseMcpSecretBridge()) return;
  secretBridgeListening = true;
  process.on('message', (message) => {
    if (message?.type !== 'secret-read-response' || !message.requestId) return;
    const pending = pendingSecretBridgeReads.get(message.requestId);
    if (!pending) return;
    pendingSecretBridgeReads.delete(message.requestId);
    clearTimeout(pending.timeout);
    pending.resolve(message.status || null);
  });
}

async function readSecretFromMcpHost(secretRef) {
  if (!canUseMcpSecretBridge()) return null;
  ensureMcpSecretBridgeListener();
  const requestId = `secret-${process.pid}-${(++secretBridgeSequence).toString(36)}-${Date.now().toString(36)}`;
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      pendingSecretBridgeReads.delete(requestId);
      resolve(null);
    }, MCP_SECRET_BRIDGE_TIMEOUT_MS);
    pendingSecretBridgeReads.set(requestId, { resolve, timeout });
    try {
      process.send({ type: 'secret-read-request', requestId, secretRef });
    } catch {
      pendingSecretBridgeReads.delete(requestId);
      clearTimeout(timeout);
      resolve(null);
    }
  });
}

function localRecord(value, revision = 1) {
  return { plain: true, localOnly: true, value: String(value), revision };
}

function readRecord(rec) {
  if (!rec) return { value: '', present: false, readable: false, issue: 'missing', revision: 0 };
  const revision = Number.isInteger(rec.revision) && rec.revision > 0 ? rec.revision : 1;
  if (rec.deleted === true) return { value: '', present: false, readable: false, issue: 'missing', revision };
  if (rec.plain === true) {
    const value = String(rec.value || '');
    return value
      ? { value, present: true, readable: true, issue: null, revision }
      : { value: '', present: true, readable: false, issue: 'empty', revision };
  }
  // Never invoke the OS keychain for records written by older releases.
  return { value: '', present: true, readable: false, issue: 'legacy-encrypted-record', revision };
}

async function setSecret(id, value) {
  const store = await loadStore();
  store.records = store.records || {};
  const currentRevision = Number.isInteger(store.records[id]?.revision) && store.records[id].revision > 0
    ? store.records[id].revision
    : store.records[id] ? 1 : 0;
  store.records[id] = localRecord(value, currentRevision + 1);
  await saveStore(store);
  return id;
}

async function migratePlainRecords() {
  const store = await loadStore();
  const records = store.records || {};
  const legacyProviders = await readJson(path.join(paths().root, 'providers.json'), { providers: [] });
  const providerKeys = new Map((legacyProviders.providers || [])
    .filter((provider) => provider?.id && provider?.apiKey)
    .map((provider) => [`provider:${provider.id}:api-key`, String(provider.apiKey)]));
  let migrated = 0;
  let unrecoverable = 0;
  let changed = false;
  for (const [id, record] of Object.entries(records)) {
    if (record?.deleted === true) continue;
    const revision = Number.isInteger(record?.revision) && record.revision > 0 ? record.revision : 1;
    if (record?.plain === true) {
      if (record.localOnly !== true) {
        records[id] = localRecord(record.value || '', revision);
        changed = true;
      }
      continue;
    }
    const legacyValue = providerKeys.get(id);
    if (legacyValue) {
      records[id] = localRecord(legacyValue, revision + 1);
      migrated += 1;
      changed = true;
    } else {
      unrecoverable += 1;
    }
  }
  for (const [id, legacyValue] of providerKeys) {
    if (Object.prototype.hasOwnProperty.call(records, id)) continue;
    records[id] = localRecord(legacyValue, 1);
    migrated += 1;
    changed = true;
  }
  store.records = records;
  if (changed) await saveStore(store);
  return { migrated, blocked: false, unrecoverable };
}

async function getSecret(id) {
  return (await getSecretStatus(id)).value;
}

async function getSecretStatus(id) {
  const store = await loadStore();
  const status = readRecord(store.records?.[id]);
  // MCP children may still use their authenticated private IPC bridge. This
  // keeps one authoritative reader without placing keys in child environments.
  if (status.present && !status.readable && canUseMcpSecretBridge()) {
    const bridged = await readSecretFromMcpHost(id);
    if (bridged && typeof bridged === 'object') {
      const value = String(bridged.value || '');
      if (bridged.readable && value) return { value, present: true, readable: true, issue: null, revision: bridged.revision || status.revision };
    }
  }
  return status;
}

async function deleteSecret(id) {
  const store = await loadStore();
  store.records = store.records || {};
  const current = store.records[id];
  const revision = Number.isInteger(current?.revision) && current.revision > 0 ? current.revision + 1 : current ? 2 : 1;
  store.records[id] = { deleted: true, revision };
  await saveStore(store);
}

async function listSecretIds() {
  const store = await loadStore();
  return Object.entries(store.records || {}).filter(([, record]) => record?.deleted !== true).map(([id]) => id);
}

async function status() {
  return {
    encryptionAvailable: false,
    storageMode: 'local-plaintext',
    plaintextAllowed: true,
  };
}

module.exports = {
  isAvailable,
  automatedTestStorageEnabled,
  allowInsecurePlaintext,
  setSecret,
  getSecret,
  getSecretStatus,
  deleteSecret,
  listSecretIds,
  migratePlainRecords,
  status,
};
