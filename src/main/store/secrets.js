'use strict';

const { safeStorage } = require('electron');
const { paths } = require('./paths');
const { readJson, writeJson } = require('./jsonStore');

async function loadStore() {
  const data = await readJson(paths().secrets, { records: {} });
  return data && typeof data === 'object' ? data : { records: {} };
}

async function saveStore(store) {
  await writeJson(paths().secrets, store);
}

function isAvailable() {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

function encryptValue(value) {
  if (!isAvailable()) {
    return { plain: true, value };
  }
  const buf = safeStorage.encryptString(String(value));
  return { plain: false, value: buf.toString('base64') };
}

function decryptRecord(rec) {
  if (!rec) return '';
  if (rec.plain) return rec.value || '';
  if (!isAvailable()) return '';
  try {
    const buf = Buffer.from(rec.value, 'base64');
    return safeStorage.decryptString(buf);
  } catch {
    return '';
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
  const store = await loadStore();
  const rec = store.records?.[id];
  return decryptRecord(rec);
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

module.exports = {
  isAvailable,
  setSecret,
  getSecret,
  deleteSecret,
  listSecretIds,
};
