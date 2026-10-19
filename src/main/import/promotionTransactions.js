'use strict';
// One durable promotion decision owns the directory, registry entry and receipt.
// Before that decision cancellation wins. Afterwards recovery only rolls forward.
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { paths, generateId } = require('../store/paths');
const { readJson, writeJson } = require('../store/jsonStore');
const storage = require('../store/projectTransactions');
const { assertEntityId, assertContainedFile } = require('../store/entityIdentity');
function directory(importId) { return path.join(paths().root, 'import-promotions', assertEntityId(importId)); }
function stateFile(importId) { return path.join(directory(importId), 'state.json'); }
function requestDirectory(importId) { return path.join(paths().root, 'import-promotion-requests', assertEntityId(importId)); }
function failure(message, code = 'recovery_required') { return Object.assign(new Error(message), { code, retryable: true }); }
async function exists(file) { return fs.access(file).then(() => true, (e) => { if (e.code === 'ENOENT') return false; throw e; }); }
async function readOperation(importId) {
  const text = await storage.read(stateFile(importId));
  if (text === null) return null;
  let operation; try { operation = JSON.parse(text); } catch { throw Object.assign(failure('提升事务记录损坏，保留现场以待核对'), { invalidRecord: true }); }
  if (operation?.schemaVersion !== 1 || operation.importId !== importId || !['preparing', 'committing', 'committed', 'cancelled'].includes(operation.state)) throw Object.assign(failure('提升事务记录身份或版本不匹配'), { invalidRecord: true });
  return operation;
}
async function get(importId) {
  const operation = await storage.exclusive(directory(importId), () => readOperation(importId));
  const run = await new (require('./importRunStore').ImportRunStore)().findByImportId(importId);
  if (!run) return operation;
  return { ...(operation || { importId }), state: run.state === 'cancelled' ? 'cancelled' : run.state === 'completed' ? 'committed' : run.commitDecision ? 'committing' : 'preparing' };
}
async function save(operation) { await writeJson(stateFile(operation.importId), operation); }
function owner(operation) { return { operationId: operation.operationId, importId: operation.importId, projectId: operation.result.id, targetDir: operation.targetDir }; }
function targetLease(operation) {
  return operation.targetLease || path.join(paths().root, 'import-promotion-targets', storage.hash(storage.canonicalRoot(operation.targetDir)));
}
async function checkReservation(root, operation) {
  const reservation = await readJson(path.join(root, 'reservation.json'), null);
  if (!reservation) return;
  if (reservation.operationId === operation.operationId) {
    if (JSON.stringify(reservation) !== JSON.stringify(owner(operation))) throw failure('提升目录保留记录身份不匹配');
    return;
  }
  // A completed/cancelled operation no longer owns a removed formal directory.
  // The target lease prevents that operation changing its terminal state here.
  const previous = await readOperation(reservation.importId);
  if (previous && ['committed', 'cancelled'].includes(previous.state) && !await exists(operation.targetDir)
    && !(await require('../store/novels').listNovels()).some((n) => path.resolve(n.dir) === operation.targetDir)) {
    await storage.writeFile(path.join(root, 'reservation.json'), null); return;
  }
  throw failure('该目录已由另一份未完成的导入保留，请先恢复或取消该导入', 'resource_name_conflict');
}
async function reserve(root, operation) {
  await checkReservation(root, operation);
  await writeJson(path.join(root, 'reservation.json'), owner(operation));
}
async function releaseReservation(root, operation) {
  const reservation = await readJson(path.join(root, 'reservation.json'), null);
  if (reservation?.operationId === operation.operationId) await storage.writeFile(path.join(root, 'reservation.json'), null);
}
async function requestCancel(importId) {
  const root = requestDirectory(importId);
  await storage.transaction(root, () => writeJson(path.join(root, 'cancel.json'), { importId, requestedAt: new Date().toISOString() }));
}
async function assertActive(operation, signal, authority) {
  const run = await authority.read();
  if (run.commitDecision) return;
  if (run.state === 'cancelled') throw failure('导入已取消', 'cancelled');
  if (signal?.aborted) throw signal.reason || failure('导入已取消', 'cancelled');
}
async function assertOwned(root, operation) {
  const markerFile = path.join(root, '.mana', 'promotion-owner.json');
  await assertContainedFile(root, markerFile);
  const marker = await readJson(markerFile, null);
  if (JSON.stringify(marker) !== JSON.stringify(owner(operation))) throw failure('提升目录身份不匹配，保留现场以待核对');
}
async function assertBootstrapOnly(root, operation) {
  // A crash can precede the first owner-marker rename. Only the exact initial
  // marker intent is recoverable without that marker; user files are never owned.
  await assertContainedFile(root, path.join(root, '.mana', 'promotion-owner.json'));
  if ((await fs.readdir(root)).some((n) => n !== '.mana')) throw failure('临时目录包含未归属文件');
  const metadata = await fs.readdir(path.join(root, '.mana'));
  if (metadata.some((n) => !['transactions', 'storage.lock'].includes(n))) throw failure('临时目录缺少可验证身份');
  const journals = path.join(root, '.mana', 'transactions');
  if (!await exists(journals)) return;
  for (const name of await fs.readdir(journals)) {
    const file = path.join(journals, name); await assertContainedFile(root, file);
    const tx = await readJson(file, null);
    if (!tx?.entries?.length) throw failure('临时目录初始日志不可验证');
    for (const entry of tx.entries) {
      const bytes = entry.encoding === 'base64' ? Buffer.from(entry.after || '', 'base64').toString('utf8') : entry.after;
      if (entry.relative !== path.join('.mana', 'promotion-owner.json') || entry.before !== null || bytes !== JSON.stringify(owner(operation))) throw failure('临时目录日志不属于身份标记初始化');
    }
  }
}
async function cleanTemporary(operation) {
  if (!await exists(operation.tempDir)) return;
  if ((await fs.readdir(operation.tempDir)).length) {
    const marker = await readJson(path.join(operation.tempDir, '.mana', 'promotion-owner.json'), null);
    if (marker) await assertOwned(operation.tempDir, operation); else await assertBootstrapOnly(operation.tempDir, operation);
    await storage.exclusive(operation.tempDir, async () => {
      const recovered = await readJson(path.join(operation.tempDir, '.mana', 'promotion-owner.json'), null);
      if (recovered) await assertOwned(operation.tempDir, operation); else await assertBootstrapOnly(operation.tempDir, operation);
    });
  }
  await fs.rm(operation.tempDir, { recursive: true, force: true });
}
async function verify(root, operation, readResources = true) {
  await assertOwned(root, operation);
  const manifestFile = path.join(root, '.mana', 'import-manifest.json');
  await assertContainedFile(root, manifestFile);
  const manifest = await readJson(manifestFile, null);
  if (manifest?.operationId !== operation.operationId || storage.hash(JSON.stringify(manifest.resources)) !== operation.manifestHash) throw failure('提升清单身份不匹配');
  if (!readResources) {
    await assertContainedFile(root, path.join(root, 'novel.json'));
    if ((await readJson(path.join(root, 'novel.json'), null))?.id !== operation.result.id) throw failure('已登记项目的正式身份已改变');
    return;
  }
  const expected = new Set(manifest.resources.map((r) => r.path));
  async function membership(dir, prefix = '') {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const relative = prefix ? path.join(prefix, entry.name) : entry.name;
      if ([path.join('.mana', 'transactions'), path.join('.mana', 'storage.lock'), path.join('.mana', 'import-manifest.json')].includes(relative)) continue;
      const file = path.join(dir, entry.name); await assertContainedFile(root, file);
      if (entry.isDirectory()) await membership(file, relative);
      else if (!expected.has(relative)) throw failure(`提升目录包含清单外资源：${relative}`);
    }
  }
  // Ownership covers the complete unpublished tree, including absence of
  // unreviewed additions. Published projects may subsequently gain user files.
  await membership(root);
  for (const resource of manifest.resources) {
    const file = path.resolve(root, resource.path);
    await assertContainedFile(root, file);
    const bytes = await fs.readFile(file).catch((e) => { if (e.code === 'ENOENT') throw failure(`提升资源缺失：${resource.path}`); throw e; });
    if (bytes.length !== resource.bytes || storage.hash(bytes) !== resource.hash) throw failure(`提升资源已发生外部修改：${resource.path}`);
  }
}
async function rollForward(operation, complete, targetRoot) {
  if (operation.state === 'committed') return operation.result;
  if (operation.state !== 'committing') throw failure('提升尚未作出提交决定');
  await reserve(targetRoot, operation);
  if (!await exists(operation.targetDir)) {
    await verify(operation.tempDir, operation);
    await fs.rename(operation.tempDir, operation.targetDir);
    const handle = await fs.open(path.dirname(operation.targetDir), 'r');
    try { await handle.sync(); } finally { await handle.close(); }
  }
  // The registry and its receipt are one atomic save. Once published, domain
  // edits are newer user work, not an excuse to replay the original manifest.
  const novels = require('../store/novels');
  const entry = (await novels.listNovels()).find((n) => n.id === operation.result.id && path.resolve(n.dir) === operation.targetDir);
  const published = JSON.stringify(entry?.importPromotionReceipt) === JSON.stringify(operation.result.receipt);
  await verify(operation.targetDir, operation, !published);
  if (!published) await novels.importExistingNovel(operation.targetDir, { allowMove: false, promotionReceipt: operation.result.receipt });
  await complete(operation.importId);
  operation.state = 'committed';
  await save(operation);
  await releaseReservation(targetRoot, operation);
  return operation.result;
}
async function commit(importId, options, prepare, complete, authority) {
  try { return await storage.exclusive(directory(importId), async () => {
    let operation = await readOperation(importId);
    const run = await authority.read();
    if (run.state === 'cancelled') throw failure('导入已取消', 'cancelled');
    if (run.commitDecision) {
      if (run.commitDecision.kind !== 'promotion') throw failure('提交类型不匹配');
      operation = { ...run.commitDecision.operation, state: operation?.state === 'committed' ? 'committed' : 'committing' };
    } else if (operation && ['committing', 'committed'].includes(operation.state)) {
      // One-time adoption of a legacy irreversible decision, through the same
      // authority command. Its physical ownership is verified during recovery.
      await authority.decide(operation);
    }
    if (operation?.state === 'cancelled') throw failure('导入已取消', 'cancelled');
    if (operation && options.dir && path.resolve(options.dir) !== operation.targetDir) {
      await assertActive(operation, options.abortSignal, authority);
      if (operation.state !== 'preparing') throw failure('提升目标与已保存事务不一致', 'import_target_mismatch');
      await cleanTemporary(operation);
      await storage.exclusive(targetLease(operation), () => releaseReservation(targetLease(operation), operation));
      const targetDir = path.resolve(options.dir);
      operation.targetDir = targetDir; operation.result.dir = targetDir;
      delete operation.targetLease;
      operation.tempDir = path.join(path.dirname(targetDir), `.${path.basename(targetDir)}.import-${operation.operationId}`);
      await save(operation);
    }
    if (!operation) {
      if (!options.dir || typeof options.dir !== 'string') throw new Error('promotion target directory is required');
      const targetDir = path.resolve(options.dir), operationId = `promotion-${randomUUID()}`;
      operation = { schemaVersion: 1, operationId, importId, state: 'preparing', targetDir,
        tempDir: path.join(path.dirname(targetDir), `.${path.basename(targetDir)}.import-${operationId}`),
        result: { id: generateId('novel'), title: options.title || null, dir: targetDir } };
      await assertActive(operation, options.abortSignal, authority);
      await save(operation);
    }
    // Cooperating imports of different sources serialize on the target too.
    const targetLock = targetLease(operation);
    operation.targetLease = targetLock;
    return storage.exclusive(targetLock, async () => {
      if (['committing', 'committed'].includes(operation.state)) return rollForward(operation, complete, targetLock);
      await assertActive(operation, options.abortSignal, authority);
      await checkReservation(targetLock, operation);
      if (await exists(operation.targetDir)) throw failure('promotion target already exists', 'resource_name_conflict');
      if ((await require('../store/novels').listNovels()).some((n) => path.resolve(n.dir) === operation.targetDir)) throw failure('promotion target conflicts with a registered project', 'resource_name_conflict');
      await cleanTemporary(operation);
      const resources = await prepare(importId, operation, options.abortSignal);
      operation.manifestHash = storage.hash(JSON.stringify(resources));
      await assertActive(operation, options.abortSignal, authority);
      await reserve(targetLock, operation);
      operation.state = 'committing';
      operation.result.receipt = { schemaVersion: 1, operationId: operation.operationId, importId, projectId: operation.result.id,
        targetDir: operation.targetDir, manifestHash: operation.manifestHash, committedAt: new Date().toISOString() };
      // The run command is the only commit/cancel arbiter. This file is an
      // execution checkpoint; a crash here is recovered from the run decision.
      await authority.decide(operation);
      await save(operation);
      return rollForward(operation, complete, targetLock);
    });
  }); } catch (error) { throw error; }
}
async function cleanup(importId, authority) {
  return storage.exclusive(directory(importId), async () => {
    const run = await authority.read();
    if (run.commitDecision || run.state !== 'cancelled') throw failure('清理缺少权威取消决定');
    const operation = await readOperation(importId);
    if (operation) {
      await cleanTemporary(operation);
      await storage.exclusive(targetLease(operation), () => releaseReservation(targetLease(operation), operation));
    }
    await save({ ...(operation || { schemaVersion: 1, importId, operationId: `promotion-${randomUUID()}` }), state: 'cancelled' });
  });
}
module.exports = { commit, cleanup, get, owner, requestCancel, savedOperation: (id) => storage.exclusive(directory(id), () => readOperation(id)) };
