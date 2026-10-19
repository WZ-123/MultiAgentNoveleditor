'use strict';
const path = require('node:path');
const fs = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const { paths, generateId } = require('../store/paths');
const { readJson, writeJson } = require('../store/jsonStore');
const storage = require('../store/projectTransactions');
const { assertEntityId } = require('../store/entityIdentity');
const state = require('./importState');
const ACTIVE_STATES = new Set(['picked', 'parsed', 'staged', 'analyzing', 'review', 'merging', 'promoting', 'interrupted', 'recovery_required']);
class ImportRunStore {
  constructor(options = {}) { this.root = options.root || path.join(paths().root, 'import-runs'); }
  file(id) { return path.join(this.root, `${assertEntityId(id)}.json`); }
  withRun(id, fn) { return storage.exclusive(path.join(this.root, '.operations', assertEntityId(id)), fn); }
  get(id) { return storage.exclusive(this.root, () => readJson(this.file(id), null)); }
  async _list() {
    const names = await fs.readdir(this.root).catch((e) => { if (e.code === 'ENOENT') return []; throw e; });
    return Promise.all(names.filter((n) => n.endsWith('.json')).map((n) => readJson(path.join(this.root, n), null)));
  }
  findByImportId(id) { return storage.exclusive(this.root, async () => {
    const found = (await this._list()).filter((r) => r?.importId === id);
    if (found.length > 1) throw state.error('同一导入存在多个运行身份，请核对', 'recovery_required', true);
    return found[0] || null;
  }); }
  listActive() { return storage.exclusive(this.root, async () => (await this._list()).filter((r) => r && (ACTIVE_STATES.has(r.state) || r.state === 'failed' && r.retryable)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))); }
  create(input = {}) { return storage.transaction(this.root, async () => {
    if (input.importId) { const old = await this.findByImportId(input.importId); if (old) return old; }
    const now = new Date().toISOString(), initial = input.state || 'picked';
    const run = { schemaVersion: input.legacy ? 1 : 2, runId: input.runId || generateId('import-run'), importId: input.importId || null, state: initial,
      sourceFiles: [...(input.sourceFiles || [])], request: input.request || null, inputFingerprint: input.inputFingerprint || '', targetNovelId: input.targetNovelId || null, target: input.target || null,
      checkpoints: [], phases: [{ phase: initial, revision: 1, inputFingerprint: input.inputFingerprint || '', checkpoint: { sourceCount: input.sourceFiles?.length || 0 }, startedAt: now, completedAt: null }],
      error: null, retryable: false, revision: 1, generation: 1, work: input.work || (initial === 'picked' ? { kind: 'parse', token: randomUUID(), generation: 1 } : null), commitDecision: null, createdAt: now, updatedAt: now };
    if (await readJson(this.file(run.runId), null)) throw state.error('run identity already exists');
    await writeJson(this.file(run.runId), run); return structuredClone(run);
  }); }
  command(id, command, payload = {}, options = {}) { return this.withRun(id, async () => {
    const current = await this.get(id);
    // Retrying the same immutable decision is idempotent even when completion
    // has advanced the revision. A different decision still requires its CAS.
    state.guard(current, command, command === 'decideCommit' && current?.commitDecision?.id === payload.id ? {} : options);
    const execute = async () => {
      if (options.effect) payload = { ...payload, ...await options.effect(structuredClone(current)) };
      const next = state.apply(current, command, payload);
      if (next !== current) await storage.transaction(this.root, async () => {
        if (next.importId && next.importId !== current.importId && (await this._list()).some((r) => r?.importId === next.importId && r.runId !== id)) throw state.error('导入身份已归属另一运行', 'recovery_required', true);
        await writeJson(this.file(id), next);
      });
      return structuredClone(next);
    };
    // Domain effects remain uncommitted until their revision fence is durable.
    // A crash can conservatively advance the fence and roll back the effect;
    // it cannot acknowledge an effect without its fence or publish an old plan.
    return options.effectRoot ? storage.transaction(options.effectRoot, execute) : execute();
  }); }
  // Compatibility CAS cannot change authority. Product transitions use commands.
  save(input) { return this.withRun(input.runId, async () => {
    const current = await this.get(input.runId); state.guard(current, 'checkpoint', { expectedRevision: input.revision });
    const before = structuredClone(current), after = structuredClone(input);
    for (const key of ['allowedActions', 'updatedAt', 'lastViewedAt']) { delete before[key]; delete after[key]; }
    if (!require('node:util').isDeepStrictEqual(before, after)) throw state.error('整份快照不能修改导入权威状态', 'stale_import_operation', true);
    const next = { ...current, ...(input.lastViewedAt ? { lastViewedAt: input.lastViewedAt } : {}), revision: current.revision + 1, updatedAt: new Date().toISOString() };
    await storage.transaction(this.root, () => writeJson(this.file(next.runId), next)); return next;
  }); }
}
module.exports = { ImportRunStore, ACTIVE_STATES };
