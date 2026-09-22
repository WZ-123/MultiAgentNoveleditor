'use strict';
const path = require('node:path');
const crypto = require('node:crypto');
const { paths } = require('./paths');
const { readJson, writeJson, readAllJson } = require('./jsonStore');
const queues = new Map();
function directory() { return path.join(paths().root, 'chat-runs'); }
function file(runId) { return path.join(directory(), `${crypto.createHash('sha256').update(String(runId)).digest('hex')}.json`); }
async function get(runId) { return readJson(file(runId), null); }
async function list() { return readAllJson(directory()); }
function save(value) {
  const target = file(value.runId);
  const snapshot = JSON.parse(JSON.stringify(value));
  const next = (queues.get(target) || Promise.resolve()).catch(() => {}).then(async () => {
    const prior = await readJson(target, null);
    if (prior && prior.version > snapshot.version) return;
    await writeJson(target, snapshot, { mode: 0o600 });
  });
  queues.set(target, next);
  next.finally(() => { if (queues.get(target) === next) queues.delete(target); }).catch(() => {});
  return next;
}
module.exports = { get, list, save };
