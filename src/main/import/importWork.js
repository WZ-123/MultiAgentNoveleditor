'use strict';
// Physical worker ownership, not business authority. The durable run carries
// the token; the lock proves that its process still owns the active work.
const fs = require('node:fs/promises');
const path = require('node:path');
const locks = require('proper-lockfile');
const jobs = new Map();
const key = (store, id) => `${path.resolve(store.root)}:${id}`;
function leasePath(store, token) { return path.join(store.root, '.workers', token); }
async function acquire(store, id, token) {
  const file = leasePath(store, token); await fs.mkdir(path.dirname(file), { recursive: true });
  const release = await locks.lock(file, { realpath: false, stale: 10000, update: 2000, retries: 0 });
  let closed = false;
  return async () => { if (closed) return; closed = true; jobs.delete(key(store, id)); await release(); };
}
async function alive(store, work) { return !!work?.token && locks.check(leasePath(store, work.token), { realpath: false, stale: 10000 }); }
function local(store, run) {
  if (typeof run.work?.token !== 'string' || !run.work.token) return null;
  const job = jobs.get(key(store, run.runId));
  return job?.token === run.work.token ? job : null;
}
module.exports = { jobs, key, acquire, alive, local };
