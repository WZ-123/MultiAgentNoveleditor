'use strict';

const { safeStorage } = require('electron');
const { paths } = require('./paths');
const { readJson, writeJson } = require('./jsonStore');

const MCP_SECRET_BRIDGE_TIMEOUT_MS = 10_000;
let secretBridgeSequence = 0;
let secretBridgeListening = false;
const pendingSecretBridgeReads = new Map();

async function loadStore() {
  const data = await readJson(paths().secrets, { records: {} });
  return data && typeof data === 'object' ? data : { records: {} };
}

async function saveStore(store) {
  await writeJson(paths().secrets, store, { mode: 0o600 });
  try {
    await require('node:fs/promises').chmod(paths().secrets, 0o600);
  } catch {
    // Windows and some sandboxed filesystems may not support POSIX modes.
  }
}

function isAvailable() {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
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

function encryptValue(value) {
  if (!isAvailable()) {
    return { plain: true, value };
  }
  const buf = safeStorage.encryptString(String(value));
  return { plain: false, value: buf.toString('base64') };
}

function readRecord(rec) {
  if (!rec) return { value: '', present: false, readable: false, issue: 'missing' };
  if (rec.plain) {
    const value = String(rec.value || '');
    return value
      ? { value, present: true, readable: true, issue: null }
      : { value: '', present: true, readable: false, issue: 'empty' };
  }
  if (!isAvailable()) {
    return { value: '', present: true, readable: false, issue: 'safe-storage-unavailable' };
  }
  try {
    const value = safeStorage.decryptString(Buffer.from(rec.value, 'base64'));
    return value
      ? { value, present: true, readable: true, issue: null }
      : { value: '', present: true, readable: false, issue: 'empty' };
  } catch {
    return { value: '', present: true, readable: false, issue: 'decrypt-failed' };
  }
}

async function setSecret(id, value) {
  const store = await loadStore();
  store.records = store.records || {};
  store.records[id] = encryptValue(value);
  await saveStore(store);
  return id;
}

async function getSecret(id) {
  return (await getSecretStatus(id)).value;
}

async function getSecretStatus(id) {
  const store = await loadStore();
  const status = readRecord(store.records?.[id]);
  // The stdio MCP server intentionally runs as Electron-as-Node, where
  // safeStorage is unavailable. Ask its Electron-main parent for this one
  // provider secret over the already-private child IPC channel instead of
  // serializing keys into environment variables or configuration files.
  if (status.present && !status.readable && status.issue === 'safe-storage-unavailable') {
    const bridged = await readSecretFromMcpHost(id);
    if (bridged && typeof bridged === 'object') {
      const value = String(bridged.value || '');
      if (bridged.readable && value) {
        return { value, present: true, readable: true, issue: null };
      }
    }
  }
  return status;
}

async function deleteSecret(id) {
  const store = await loadStore();
  if (store.records) {
    delete store.records[id];
    await saveStore(store);
  }
}

async function listSecretIds() {
  const store = await loadStore();
  return Object.keys(store.records || {});
}

async function status() {
  return {
    encryptionAvailable: isAvailable(),
    storageMode: isAvailable() ? 'safe-storage' : 'restricted-plaintext',
  };
}

module.exports = {
  isAvailable,
  setSecret,
  getSecret,
  getSecretStatus,
  deleteSecret,
  listSecretIds,
  status,
};
