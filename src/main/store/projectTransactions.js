'use strict';

// The storage boundary, shared by ordinary saves and reviewed batch plans.
// The project lock covers read/modify/write, not just the final rename. A durable
// intent is recorded before each attempted write; recovery only owns those intents.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const lockfile = require('proper-lockfile');
const { rawAtomicWriteFile } = require('./atomicFile');
const context = new AsyncLocalStorage();
const leases = new AsyncLocalStorage();
const activeTransactions = new WeakSet();
const roots = new Set(), rootAliases = new Map(), tails = new Map();
function canonicalRoot(root) { try { return require('node:fs').realpathSync(root); } catch (e) { if (e.code !== 'ENOENT') throw e; const absolute = path.resolve(root); const parent = path.dirname(absolute); return parent === absolute ? absolute : path.join(canonicalRoot(parent), path.basename(absolute)); } }
function canonicalFile(file) { return path.join(canonicalRoot(path.dirname(file)), path.basename(file)); }
const hash = (v) => v === null ? 'missing' : crypto.createHash('sha256').update(v).digest('hex');
async function read(file) { try { return await fs.readFile(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }
function registerRoot(root) { const canonical = canonicalRoot(root); roots.add(canonical); rootAliases.set(path.resolve(root), canonical); }
function within(root, file) { const r = path.relative(root, file); return !!r && !r.startsWith('..') && !path.isAbsolute(r); }
async function rootFor(file) {
  const alias = [...rootAliases.keys()].filter((r) => within(r, file)).sort((a, b) => b.length - a.length)[0];
  if (alias) { await require('./entityIdentity').assertContainedFile(alias, file); return rootAliases.get(alias); }
  const known = [...roots].filter((r) => within(r, file)).sort((a, b) => b.length - a.length)[0];
  if (known) return known;
  for (let dir = path.dirname(file); dir !== path.dirname(dir); dir = path.dirname(dir)) {
    try { if ((await fs.stat(path.join(dir, '.mana'))).isDirectory()) { await require('./entityIdentity').assertContainedFile(dir, file); registerRoot(dir); return canonicalRoot(dir); } } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  return null;
}
function journalFile(root, id) { return path.join(root, '.mana', 'transactions', `${hash(id)}.json`); }
async function persist(tx) { await rawAtomicWriteFile(journalFile(tx.root, tx.id), JSON.stringify(tx, null, 2)); }
async function put(file, value, options) {
  if (value !== null) return rawAtomicWriteFile(file, value, options);
  try { await fs.unlink(file); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
  try { const directory = await fs.open(path.dirname(file), 'r'); try { await directory.sync(); } finally { await directory.close(); } } catch (e) { if (!['EINVAL', 'ENOTSUP', 'EPERM', 'EISDIR'].includes(e.code)) throw e; }
}
async function rollback(tx) {
  tx.state = 'rolling_back'; await persist(tx);
  for (const entry of [...tx.entries].reverse()) {
    if (entry.state === 'restored') continue;
    const file = path.resolve(tx.root, entry.relative);
    await require('./entityIdentity').assertContainedFile(tx.root, file);
    const decode = (v) => v === null ? null : entry.encoding === 'base64' ? Buffer.from(v, 'base64') : v;
    const before = decode(entry.before), after = decode(entry.after);
    const current = await fs.readFile(file).then(hash, (e) => { if (e.code === 'ENOENT') return hash(null); throw e; });
    if (current !== hash(before)) {
      if (current !== hash(after)) throw Object.assign(new Error(`恢复遇到外部修改：${entry.relative}`), { code: 'recovery_required' });
      await put(file, before);
    }
    if (await fs.readFile(file).then(hash, (e) => { if (e.code === 'ENOENT') return hash(null); throw e; }) !== hash(before)) throw new Error('rollback readback mismatch');
    entry.state = 'restored'; await persist(tx);
  }
  tx.state = 'rolled_back'; await persist(tx);
}
async function recover(root) {
  let names; try { names = await fs.readdir(path.join(root, '.mana', 'transactions')); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
  for (const name of names.filter((n) => n.endsWith('.json')).sort()) {
    const journal = path.join(root, '.mana', 'transactions', name);
    await require('./entityIdentity').assertContainedFile(root, journal);
    const tx = JSON.parse(await fs.readFile(journal, 'utf8'));
    if (tx.root !== root || !Array.isArray(tx.entries)) throw new Error('transaction identity mismatch');
    if (!['committed', 'rolled_back'].includes(tx.state)) await rollback(tx);
  }
}
async function locked(root, fn) {
  // Keep the caller's alias as well as the canonical identity. Otherwise a
  // registered parent alias can capture a child scope's first managed write.
  registerRoot(root); root = canonicalRoot(root);
  if (context.getStore()?.root === root && activeTransactions.has(context.getStore())) return fn(context.getStore());
  if (leases.getStore()?.get(root)?.active) return fn(null);
  const prev = tails.get(root) || Promise.resolve();
  let releaseQueue; const gate = new Promise((r) => { releaseQueue = r; });
  const tail = prev.then(() => gate); tails.set(root, tail);
  await prev;
  let releaseDisk;
  const token = { active: true };
  try {
    await require('./entityIdentity').assertContainedFile(root, path.join(root, '.mana', 'storage'));
    await fs.mkdir(path.join(root, '.mana'), { recursive: true });
    releaseDisk = await lockfile.lock(path.join(root, '.mana', 'storage'), { realpath: false, retries: { retries: 100, minTimeout: 20, maxTimeout: 200 }, stale: 10000 });
    await recover(root);
    return await leases.run(new Map([...(leases.getStore() || []), [root, token]]), () => fn(null));
  } finally {
    token.active = false;
    try { if (releaseDisk) await releaseDisk(); }
    finally { releaseQueue(); if (tails.get(root) === tail) tails.delete(root); }
  }
}
async function transaction(root, fn, options = {}) {
  return locked(root, async (active) => {
    if (active) return fn(active);
    const tx = { schemaVersion: 1, id: options.id || crypto.randomUUID(), root: canonicalRoot(root), state: 'prepared', fingerprint: options.fingerprint || null, entries: [] };
    const previous = options.id ? await read(journalFile(tx.root, tx.id)) : null;
    if (previous) {
      const old = JSON.parse(previous);
      if (old.fingerprint !== tx.fingerprint) throw new Error('transaction id reused with different content');
      if (old.state === 'committed') return old.result;
    }
    return context.run(tx, async () => {
      activeTransactions.add(tx);
      try {
        const result = await fn(tx);
        tx.state = 'committed'; if (options.id) tx.result = result;
        if (tx.entries.length || options.id) await persist(tx);
        if (tx.entries.length && !options.id) await fs.unlink(journalFile(tx.root, tx.id)).catch(() => {});
        return result;
      } catch (error) {
        if (tx.entries.length) {
          try { await rollback(tx); } catch (failure) { error.code = 'recovery_required'; error.recoveryError = failure.message; }
        }
        throw error;
      } finally {
        activeTransactions.delete(tx);
      }
    });
  });
}
async function writeFile(file, value, options = {}) {
  const original = path.resolve(file);
  const root = await rootFor(original);
  file = canonicalFile(original);
  if (!root) return put(file, value, options);
  return transaction(root, async (tx) => {
    await require('./entityIdentity').assertContainedFile(root, file);
    const after = value === null ? null : Buffer.isBuffer(value) ? value : Buffer.from(String(value), options.encoding || 'utf8');
    const before = await fs.readFile(file).catch((e) => { if (e.code === 'ENOENT') return null; throw e; });
    if (hash(before) === hash(after)) return { path: file, bytes: after?.length || 0, contentHash: hash(after) };
    const entry = { relative: path.relative(root, file), before: before?.toString('base64') ?? null, after: after?.toString('base64') ?? null, encoding: 'base64', state: 'intent' };
    tx.entries.push(entry); tx.state = 'writing'; await persist(tx);
    const receipt = await put(file, after, options);
    const actual = await fs.readFile(file).catch((e) => { if (e.code === 'ENOENT') return null; throw e; });
    if (hash(actual) !== hash(after)) throw new Error('storage readback mismatch');
    entry.state = 'applied'; await persist(tx);
    return receipt;
  });
}

async function commitPlan(root, plan) {
  root = canonicalRoot(root);
  if (new Set(plan.changes.map((c) => c.relative)).size !== plan.changes.length) throw new Error('duplicate plan resource');
  for (const c of plan.changes) if (hash(c.before) !== c.beforeHash) throw new Error('plan baseline hash mismatch');
  const fingerprint = hash(JSON.stringify(plan.changes.map(({ relative, beforeHash, after }) => ({ relative, beforeHash, after }))));
  return transaction(root, async () => {
    const resources = [];
    for (const c of plan.changes) {
      await require('./entityIdentity').assertContainedFile(root, path.resolve(root, c.relative));
      if (hash(await read(path.resolve(root, c.relative))) !== c.beforeHash) throw Object.assign(new Error(`审阅后资源已变化，请重新审阅：${c.relative}`), { code: 'stale_import_review', retryable: true });
    }
    for (const c of plan.changes) {
      await writeFile(path.resolve(root, c.relative), c.after);
      resources.push({ path: c.relative, beforeHash: c.beforeHash, afterHash: hash(c.after), changed: c.beforeHash !== hash(c.after) });
    }
    return { schemaVersion: 2, planId: plan.id, written: resources.filter((c) => c.changed).length, preserved: resources.filter((c) => !c.changed).length, resources, committedAt: new Date().toISOString() };
  }, { id: plan.id, fingerprint });
}
async function appendFile(file, value) {
  const original = path.resolve(file);
  const root = await rootFor(original);
  file = canonicalFile(original);
  if (!root) { await fs.mkdir(path.dirname(file), { recursive: true }); return fs.appendFile(file, value, 'utf8'); }
  return transaction(root, async () => writeFile(file, (await read(file) || '') + value));
}
// A durable business protocol may commit several journaled decisions under one
// lease. A later step's failure must not roll back a committed earlier decision.
async function exclusive(root, fn) { return locked(root, () => fn()); }
async function committedReceipt(root, plan) {
  return exclusive(root, async () => {
    const text = await read(journalFile(canonicalRoot(root), plan.id));
    if (!text) return null;
    const tx = JSON.parse(text);
    const fingerprint = hash(JSON.stringify(plan.changes.map(({ relative, beforeHash, after }) => ({ relative, beforeHash, after }))));
    if (tx.root !== canonicalRoot(root) || tx.id !== plan.id || tx.fingerprint !== fingerprint) throw Object.assign(new Error('已提交计划的身份不匹配'), { code: 'recovery_required', retryable: true });
    return tx.state === 'committed' ? tx.result : null;
  });
}
module.exports = { appendFile, transaction, exclusive, committedReceipt, commitPlan, writeFile, registerRoot, recover, read, hash, canonicalRoot };
