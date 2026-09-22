'use strict';

const path = require('node:path');
const { ImportRunStore } = require('./importRunStore');
const { clone } = require('../codex-runtime/contracts');
const { paths } = require('../store/paths');

const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'recovery_required']);

function errorWithCode(message, code, retryable = false) {
  const error = new Error(message);
  error.code = code;
  error.retryable = retryable;
  return error;
}

class ImportSagaService {
  constructor(options = {}) {
    this.store = options.store || new ImportRunStore(options.storeOptions);
    this.fileParser = options.fileParser || require('./fileParser');
    this.staging = options.staging || require('./stagingProject');
    this.analyzer = options.analyzer || require('./analyzer');
    this.merge = options.merge || require('./mergeEngine');
    this.novels = options.novels || require('../store/novels');
    this.stagingRoot = options.stagingRoot || path.join(paths().root, 'import-staging');
    this.deadlines = { parse: 60_000, analyze: 15 * 60_000, promote: 120_000, ...(options.deadlines || {}) };
    this.controllers = new Map();
    this.analysisTimers = new Map();
    this.activeAnalyses = new Set();
  }

  _snapshot(run) {
    return clone({
      ...run,
      allowedActions: TERMINAL.has(run.state) ? [] : run.state === 'interrupted' ? ['resume', 'cancel'] : ['cancel', ...(run.state === 'review' || run.state === 'merging' ? ['resolveConflict', 'finalize'] : ['resume'])],
    });
  }

  async _save(run) {
    const durable = clone(run);
    delete durable.allowedActions;
    return this._snapshot(await this.store.save(durable));
  }

  async _transition(run, state, checkpoint) {
    const now = new Date().toISOString();
    const current = run.phases?.[run.phases.length - 1];
    if (current && !current.completedAt) current.completedAt = now;
    run.state = state;
    run.revision = Number(run.revision || 0) + 1;
    run.error = null;
    run.retryable = false;
    run.phases = [...(run.phases || []), {
      phase: state,
      revision: run.revision,
      inputFingerprint: run.inputFingerprint || '',
      checkpoint: clone(checkpoint || {}),
      startedAt: now,
      completedAt: TERMINAL.has(state) ? now : null,
    }];
    if (checkpoint) run.checkpoints = [...(run.checkpoints || []), { phase: state, at: now, ...clone(checkpoint) }];
    return this._save(run);
  }

  _controller(runId) {
    this.controllers.get(runId)?.abort(errorWithCode('superseded import phase', 'cancelled'));
    const controller = new AbortController();
    this.controllers.set(runId, controller);
    return controller;
  }

  async _deadline(runId, phase, operation) {
    const root = this._controller(runId);
    const timeout = setTimeout(() => root.abort(errorWithCode(`${phase} deadline exceeded`, 'import_timeout', true)), this.deadlines[phase] || 120_000);
    const abort = new Promise((_, reject) => root.signal.addEventListener('abort', () => reject(root.signal.reason || errorWithCode(`${phase} aborted`, 'cancelled')), { once: true }));
    const work = Promise.resolve().then(() => operation(root.signal));
    work.catch(() => {});
    try { return await Promise.race([work, abort]); }
    finally { clearTimeout(timeout); if (this.controllers.get(runId) === root) this.controllers.delete(runId); }
  }

  async _fail(run, error) {
    if (run.state === 'cancelled') return this._snapshot(run);
    const aborted = error?.name === 'AbortError' || error?.code === 'cancelled';
    const failedPhase = run.phases?.at(-1)?.phase || run.state;
    run.state = aborted ? 'cancelled' : error?.retryable === true ? 'interrupted' : 'failed';
    run.error = { code: error?.code || 'import_failed', message: error?.message || String(error), phase: failedPhase };
    run.retryable = !aborted && error?.retryable !== false;
    run.revision = Number(run.revision || 0) + 1;
    const now = new Date().toISOString();
    const current = run.phases?.[run.phases.length - 1];
    if (current && !current.completedAt) current.completedAt = now;
    run.phases = [...(run.phases || []), {
      phase: run.state,
      revision: run.revision,
      inputFingerprint: run.inputFingerprint || '',
      checkpoint: { errorCode: run.error.code, failedPhase },
      startedAt: now,
      completedAt: now,
    }];
    return this._save(run);
  }

  async start(input = {}) {
    const sourceFiles = [...(input.filePaths || input.sourceFiles || [])];
    if (!sourceFiles.length && !input.parsed) throw errorWithCode('import source files are required', 'invalid_import_input', false);
    let run = await this.store.create({ sourceFiles, targetNovelId: input.targetNovelId, target: input.target });
    try {
      const duplicate = sourceFiles.length ? await this.staging.checkDuplicateImport(sourceFiles) : { fingerprint: input.inputFingerprint || '' };
      run.inputFingerprint = duplicate.fingerprint || '';
      const picked = run.phases?.at(-1);
      if (picked?.phase === 'picked') {
        picked.inputFingerprint = run.inputFingerprint;
        picked.checkpoint = { sourceCount: sourceFiles.length, fingerprint: run.inputFingerprint };
      }
      const parsed = input.parsed || await this._deadline(run.runId, 'parse', () => this.fileParser.parseNovelFiles(sourceFiles));
      run.parsed = { chapters: parsed.chapters || [], metadata: parsed.metadata || {} };
      await this._transition(run, 'parsed', { chapterCount: run.parsed.chapters.length, fingerprint: run.inputFingerprint });
      const staged = await this.staging.createStagingProject({ sourceFiles, chapters: run.parsed.chapters, metadata: { ...run.parsed.metadata, ...(input.metadata || {}) }, targetNovelId: input.targetNovelId || null });
      run.importId = staged.importId;
      delete run.parsed;
      return this._transition(run, 'staged', { importId: staged.importId, chapterCount: staged.chapterCount });
    } catch (error) { return this._fail(run, error); }
  }

  async get(id) {
    let run = await this.store.get(id);
    if (!run) run = await this.store.findByImportId(id);
    if (!run) {
      const staging = await this.staging.getStagingProject(id);
      if (!staging) throw errorWithCode('staging project is missing', 'staging_missing', true);
      run = await this.store.create({ importId: id, state: (staging.characters?.length || staging.outline || staging.world?.lore) ? 'review' : 'staged', sourceFiles: staging.novelMeta?.importMeta?.sourceFiles || [], targetNovelId: staging.novelMeta?.importMeta?.targetNovelId || null });
      run.checkpoints.push({ phase: run.state, at: new Date().toISOString(), synthesizedFromDisk: true });
      await this.store.save(run);
    }
    if (run.state === 'analyzing' && !this.activeAnalyses.has(run.runId)) {
      return this._fail(run, errorWithCode('analysis was interrupted before a durable completion checkpoint', 'provider_state_lost', true));
    }
    return this._snapshot(run);
  }

  async resume(id) {
    let run = await this.get(id);
    if (run.state === 'interrupted' || (run.state === 'failed' && run.retryable)) {
      const recoveryState = run.checkpoints.some((item) => item.phase === 'review') ? 'review' : 'staged';
      await this._transition(run, recoveryState, { resumedFrom: run.error?.phase || run.state });
      run = await this.get(run.runId);
    }
    if (run.state === 'staged') {
      if (!await this.staging.getStagingProject(run.importId)) return this._fail(run, errorWithCode('staging project is missing', 'staging_missing', true));
      const stagingDir = path.join(this.stagingRoot, run.importId);
      try {
        await this._transition(run, 'analyzing');
        const controller = this._controller(run.runId);
        const timer = setTimeout(() => controller.abort(errorWithCode('analyze deadline exceeded', 'import_timeout', true)), this.deadlines.analyze);
        this.analysisTimers.set(run.runId, timer);
        this.activeAnalyses.add(run.runId);
        const started = await this.analyzer.startAnalyses(stagingDir, { abortSignal: controller.signal });
        run.analysis = { ...started, startedAt: new Date().toISOString() };
        await this.store.save(run);
        return this._snapshot(run);
      } catch (error) { clearTimeout(this.analysisTimers.get(run.runId)); this.analysisTimers.delete(run.runId); this.activeAnalyses.delete(run.runId); return this._fail(run, error); }
    }
    if (run.state === 'analyzing') {
      const stagingDir = path.join(this.stagingRoot, run.importId);
      try {
        const result = await this.analyzer.finalizeAnalyses(stagingDir);
        clearTimeout(this.analysisTimers.get(run.runId));
        this.analysisTimers.delete(run.runId);
        this.controllers.delete(run.runId);
        this.activeAnalyses.delete(run.runId);
        return this._transition(run, 'review', { analysis: result });
      } catch (error) { clearTimeout(this.analysisTimers.get(run.runId)); this.analysisTimers.delete(run.runId); this.controllers.delete(run.runId); this.activeAnalyses.delete(run.runId); return this._fail(run, error); }
    }
    return this._snapshot(run);
  }

  async cancel(id) {
    const run = await this.get(id);
    this.controllers.get(run.runId)?.abort(errorWithCode('import cancelled', 'cancelled', false));
    clearTimeout(this.analysisTimers.get(run.runId));
    this.analysisTimers.delete(run.runId);
    this.activeAnalyses.delete(run.runId);
    if (!TERMINAL.has(run.state)) await this._transition(run, 'cancelled', { cancelled: true });
    return this.get(run.runId);
  }

  async resolveConflict(id, input = {}) {
    const run = await this.get(id);
    if (!run.mergeSessionId) throw errorWithCode('merge session is not ready', 'unresolved_conflicts', true);
    this.merge.resolveConflict(run.mergeSessionId, input.itemId, input.decision, input);
    run.mergeSummary = this.merge.getMergeSummary(run.mergeSessionId);
    await this.store.save(run);
    return this._snapshot(run);
  }

  async finalize(id, input = {}) {
    const run = await this.get(id);
    try {
      if (run.targetNovelId) {
        if (!run.mergeSessionId) {
          const target = await this.novels.pathsFor(run.targetNovelId);
          const session = await this.merge.createMergeSession(path.join(this.stagingRoot, run.importId), run.targetNovelId, target.root);
          run.mergeSessionId = session.sessionId;
          run.mergeSummary = session.summary;
          await this._transition(run, 'merging', { mergeSessionId: session.sessionId });
        }
        const summary = this.merge.getMergeSummary(run.mergeSessionId);
        if (!summary || summary.pending || summary.disputed) throw errorWithCode('all pending and disputed conflicts must be resolved before finalize', 'unresolved_conflicts', true);
        const receipt = await this.merge.finalizeMerge(run.mergeSessionId);
        await this._transition(run, 'promoting', { mergeReceipt: receipt, promotionRequired: false });
        return this._transition(run, 'completed', { mergeReceipt: receipt });
      }
      if (run.state !== 'review' && run.state !== 'promoting') throw errorWithCode('import must reach review before promotion', 'invalid_import_state', false);
      if (run.state === 'review') await this._transition(run, 'merging', { conflicts: 0, mergeRequired: false });
      await this._transition(run, 'promoting');
      const result = await this._deadline(run.runId, 'promote', (abortSignal) => this.staging.promoteToNovel(run.importId, { ...(input.target || run.target || {}), abortSignal }));
      run.result = result;
      return this._transition(run, 'completed', { promotion: result });
    } catch (error) {
      if (error?.code === 'unresolved_conflicts') {
        run.error = { code: error.code, message: error.message, phase: 'merging' };
        run.retryable = true;
        await this.store.save(run);
        return this._snapshot(run);
      }
      return this._fail(run, error);
    }
  }
}

module.exports = { ImportSagaService, TERMINAL, errorWithCode };
