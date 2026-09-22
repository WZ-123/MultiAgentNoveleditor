'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const { paths } = require('../store/paths');
const { readJson, writeJson } = require('../store/jsonStore');

const MODE_CONFIRM = 'confirm-each-change';
const MODE_APPEND = 'append-prose';
let queue = Promise.resolve();

async function canonicalDirectory(directory) {
  const resolved = path.resolve(String(directory || ''));
  const canonical = await fsp.realpath(resolved).catch(() => resolved);
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
}

async function load() {
  const value = await readJson(paths().codexWritingAuthorizations, { schemaVersion: 1, projects: {} });
  return value?.schemaVersion === 1 && value.projects && typeof value.projects === 'object'
    ? value
    : { schemaVersion: 1, projects: {} };
}

async function getAuthorization(entry) {
  await queue;
  return getAuthorizationNow(entry);
}

async function getAuthorizationNow(entry) {
  if (!entry?.id || !entry?.dir) return { novelId: null, mode: MODE_CONFIRM, version: 0, granted: false };
  const store = await load();
  const record = store.projects[String(entry.id)] || null;
  const novelDir = await canonicalDirectory(entry.dir);
  const valid = record?.novelId === String(entry.id)
    && record?.novelDir === novelDir
    && record?.mode === MODE_APPEND;
  return {
    novelId: String(entry.id),
    novelDir,
    mode: valid ? MODE_APPEND : MODE_CONFIRM,
    version: Number(record?.version) || 0,
    granted: valid,
    updatedAt: record?.updatedAt || null,
  };
}

async function setAuthorization(entry, mode) {
  if (!entry?.id || !entry?.dir) throw new Error('小说项目不存在');
  const operation = queue.then(async () => {
    const normalizedMode = mode === MODE_APPEND ? MODE_APPEND : MODE_CONFIRM;
    const store = await load();
    const previous = store.projects[String(entry.id)] || null;
    const record = {
      novelId: String(entry.id),
      novelDir: await canonicalDirectory(entry.dir),
      mode: normalizedMode,
      version: (Number(previous?.version) || 0) + 1,
      updatedAt: new Date().toISOString(),
    };
    store.projects[String(entry.id)] = record;
    await writeJson(paths().codexWritingAuthorizations, store, { mode: 0o600 });
    return { ...record, granted: normalizedMode === MODE_APPEND };
  });
  queue = operation.catch(() => {});
  return operation;
}

async function revokeAuthorization(entry) {
  return setAuthorization(entry, MODE_CONFIRM);
}

function sameAuthorization(left, right) {
  return !!left && !!right
    && left.granted === true
    && right.granted === true
    && left.novelId === right.novelId
    && left.novelDir === right.novelDir
    && left.version === right.version
    && left.mode === right.mode;
}

async function withAuthorization(entry, expected, action) {
  const operation = queue.then(async () => {
    const current = await getAuthorizationNow(entry);
    if (!sameAuthorization(expected, current)) {
      const error = new Error('项目新增正文授权已撤销或变更，本次补丁未写入正式小说');
      error.code = 'authorization_revoked';
      throw error;
    }
    return action();
  });
  queue = operation.catch(() => {});
  return operation;
}

module.exports = {
  MODE_APPEND,
  MODE_CONFIRM,
  canonicalDirectory,
  getAuthorization,
  revokeAuthorization,
  sameAuthorization,
  setAuthorization,
  withAuthorization,
};
