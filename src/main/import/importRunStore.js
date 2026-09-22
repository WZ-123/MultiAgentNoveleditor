'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');
const { paths, generateId } = require('../store/paths');
const { readJson, writeJson } = require('../store/jsonStore');
const { clone } = require('../codex-runtime/contracts');

const ACTIVE_STATES = new Set(['picked', 'parsed', 'staged', 'analyzing', 'review', 'merging', 'promoting', 'interrupted']);

class ImportRunStore {
  constructor(options = {}) {
    this.root = options.root || path.join(paths().root, 'import-runs');
    this.queue = Promise.resolve();
  }

  file(runId) { return path.join(this.root, `${String(runId)}.json`); }

  async create(input = {}) {
    const now = new Date().toISOString();
    const run = {
      schemaVersion: 1,
      runId: input.runId || generateId('import-run'),
      importId: input.importId || null,
      state: input.state || 'picked',
      sourceFiles: [...(input.sourceFiles || [])],
      inputFingerprint: input.inputFingerprint || '',
      targetNovelId: input.targetNovelId || null,
      target: input.target || null,
      checkpoints: [],
      phases: [{
        phase: input.state || 'picked',
        revision: 1,
        inputFingerprint: input.inputFingerprint || '',
        checkpoint: { sourceCount: (input.sourceFiles || []).length },
        startedAt: now,
        completedAt: null,
      }],
      error: null,
      retryable: false,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };
    await this.save(run);
    return clone(run);
  }

  async get(runId) { return readJson(this.file(runId), null); }

  async findByImportId(importId) {
    let names = [];
    try { names = await fs.readdir(this.root); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    for (const name of names.filter((item) => item.endsWith('.json'))) {
      const run = await readJson(path.join(this.root, name), null);
      if (run?.importId === importId) return run;
    }
    return null;
  }

  async listActive() {
    let names = [];
    try { names = await fs.readdir(this.root); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    const runs = [];
    for (const name of names.filter((item) => item.endsWith('.json'))) {
      const run = await readJson(path.join(this.root, name), null);
      if (run && ACTIVE_STATES.has(run.state)) runs.push(run);
    }
    return runs.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).map(clone);
  }

  async save(run) {
    const next = clone(run);
    next.updatedAt = new Date().toISOString();
    const operation = this.queue.then(() => writeJson(this.file(next.runId), next, { mode: 0o600 }));
    this.queue = operation.catch(() => {});
    await operation;
    return clone(next);
  }
}

module.exports = { ACTIVE_STATES, ImportRunStore };
