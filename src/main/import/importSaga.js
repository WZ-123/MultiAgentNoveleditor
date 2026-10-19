'use strict';
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { ImportRunStore } = require('./importRunStore');
const state = require('./importState');
const work = require('./importWork');
const { paths } = require('../store/paths');
const TERMINAL = state.TERMINAL;
const errorWithCode = state.error;
class ImportSagaService {
  constructor(options = {}) {
    this.store = options.store || new ImportRunStore(options.storeOptions);
    this.fileParser = options.fileParser || require('./fileParser');
    this.staging = options.staging || require('./stagingProject');
    this.analyzer = options.analyzer || require('./analyzer');
    this.merge = options.merge || require('./mergeEngine');
    this.novels = options.novels || require('../store/novels');
    this.stagingRoot = options.stagingRoot || path.join(paths().root, 'import-staging');
    this.deadlines = { parse: 60000, analyze: 900000, promote: 120000, ...(options.deadlines || {}) };
    this.controllers = new Map(); this.analysisTimers = new Map();
  }
  _snapshot(r) { return state.snapshot(r); }
  async _command(id, command, payload, options) { return this._snapshot(await this.store.command(id, command, payload, options)); }
  async _fail(run, error) {
    if (error.code === 'stale_import_operation') return this.get(run.runId);
    const latest = await this.store.get(run.runId);
    const fence = run.work?.token ? { token: run.work.token } : latest.commitDecision?.id === run.mergeSessionId ? { decisionId: run.mergeSessionId } : { expectedRevision: run.revision };
    try { return await this._command(run.runId, 'fail', { error: { code: error.code, message: error.message || String(error), name: error.name, retryable: error.retryable } }, fence); }
    catch (e) { if (e.code === 'stale_import_operation') return this.get(run.runId); throw e; }
  }
  async _deadline(id, phase, fn) {
    const controller = new AbortController(); this.controllers.set(id, controller);
    let reject; const aborted = new Promise((_, r) => { reject = r; }); aborted.catch(() => {});
    controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
    const timer = setTimeout(() => controller.abort(errorWithCode(`${phase} deadline exceeded`, 'import_timeout', true)), this.deadlines[phase]);
    try { const pending = Promise.resolve().then(() => fn(controller.signal)); return await (phase === 'promote' ? pending : Promise.race([pending, aborted])); }
    finally { clearTimeout(timer); this.controllers.delete(id); }
  }
  async start(input = {}) {
    const sourceFiles = [...(input.filePaths || input.sourceFiles || [])];
    if (!sourceFiles.length && !input.parsed) throw errorWithCode('import source files are required', 'invalid_import_input');
    const runId = `import-run-${randomUUID()}`, token = randomUUID();
    const release = await work.acquire(this.store, runId, token);
    let run;
    try { run = await this.store.create({ runId, work: { kind: 'parse', token, generation: 1 }, request: { parsed: input.parsed || null, metadata: input.metadata || {} }, sourceFiles, targetNovelId: input.targetNovelId, target: input.target }); }
    catch (e) { await release(); throw e; }
    return this._sourceWork(run, input, release);
  }
  async _sourceWork(run, input = {}, release) {
    release ||= await work.acquire(this.store, run.runId, run.work.token);
    const job = { token: run.work.token, stop: async () => { this.controllers.get(run.runId)?.abort(errorWithCode('import cancelled', 'cancelled')); await release(); } };
    work.jobs.set(work.key(this.store, run.runId), job);
    const pending = (async () => {
      try {
        if (run.state === 'picked') {
          const duplicate = run.sourceFiles.length ? await this.staging.checkDuplicateImport(run.sourceFiles) : { fingerprint: input.inputFingerprint || '' };
          const parsed = input.parsed || run.request?.parsed || await this._deadline(run.runId, 'parse', () => this.fileParser.parseNovelFiles(run.sourceFiles));
          run = await this.store.command(run.runId, 'parsed', { parsed: { chapters: parsed.chapters || [], metadata: { ...parsed.metadata, ...run.request?.metadata } }, fingerprint: duplicate.fingerprint }, { token: run.work.token });
        }
        const staged = await this.staging.createStagingProject({ runId: run.runId, sourceFiles: run.sourceFiles, chapters: run.parsed.chapters, metadata: run.parsed.metadata, targetNovelId: run.targetNovelId });
        return await this._command(run.runId, 'staged', staged, { token: run.work.token });
      } catch (e) { return this._fail(run, e); } finally { await release(); }
    })();
    job.finish = () => pending;
    return pending;
  }

  async get(id) {
    let run = await this.store.get(id) || await this.store.findByImportId(id);
    if (!run) {
      const staged = await this.staging.getStagingProject(id);
      if (!staged) throw errorWithCode('staging project is missing', 'staging_missing', true);
      const owner = staged.novelMeta?.importMeta?.runId;
      if (owner) {
        const bound = await this.store.get(owner);
        if (bound?.importId && bound.importId !== id) throw errorWithCode('暂存目录与运行身份不一致', 'recovery_required', true);
        if (bound) return this._snapshot(bound);
      }
      run = await this.store.create({ legacy: true, importId: id, state: staged.characters?.length || staged.outline || staged.world?.lore ? 'review' : 'staged', sourceFiles: staged.novelMeta?.importMeta?.sourceFiles || [], targetNovelId: staged.novelMeta?.importMeta?.targetNovelId });
    }
    return this._snapshot(run);
  }
  async _writable(id) {
    const run = await this.get(id);
    if (run.schemaVersion >= 2) return run;
    const operation = run.importId && this.staging.executePromotion ? await require('./promotionTransactions').savedOperation(run.importId) : null;
    const mergeDecision = run.importId && this.merge.legacyDecision ? await this.merge.legacyDecision(run.importId) : null;
    return this._command(run.runId, 'adoptLegacy', { operation, mergeDecision }, { expectedRevision: run.revision });
  }
  async resume(id) {
    let run = await this._writable(id);
    if (TERMINAL.has(run.state)) return run;
    if (['interrupted', 'failed', 'recovery_required'].includes(run.state)) run = await this._command(run.runId, 'recover', {}, { expectedRevision: run.revision });
    if (run.commitDecision || run.state === 'promoting') return this.finalize(run.runId);
    if (run.state === 'picked' || run.state === 'parsed') {
      const job = work.local(this.store, run);
      if (job) return job.finish();
      if (await work.alive(this.store, run.work)) return run;
      const token = randomUUID(), release = await work.acquire(this.store, run.runId, token);
      try { run = await this.store.command(run.runId, 'restartSource', { token, kind: 'parse' }, { expectedRevision: run.revision }); }
      catch (e) { await release(); throw e; }
      return this._sourceWork(run, {}, release);
    }
    if (run.state === 'staged') return this._beginAnalysis(run);
    if (run.state === 'analyzing') {
      const job = work.local(this.store, run);
      if (job) return job.finish();
      if (await work.alive(this.store, run.work)) return run;
      run = await this._command(run.runId, 'analysisLost', {}, { expectedRevision: run.revision });
      return this.resume(run.runId);
    }
    return run;
  }
  async _beginAnalysis(run) {
    if (!await this.staging.getStagingProject(run.importId)) return this._fail(run, errorWithCode('staging project is missing', 'staging_missing', true));
    const token = randomUUID(), controller = new AbortController();
    const release = await work.acquire(this.store, run.runId, token);
    const cleanup = async () => { clearTimeout(job.timer); this.analysisTimers.delete(run.runId); this.controllers.delete(run.runId); await release(); };
    const job = { token, controller, finish: null, timer: null };
    try {
      run = await this.store.command(run.runId, 'beginAnalysis', { token, ownerPid: process.pid }, { expectedRevision: run.revision });
      const stagingDir = path.join(this.stagingRoot, run.importId);
      let finishing;
      job.finish = () => finishing ||= (async () => {
        try { await job.started; const result = await (this.analyzer.executeFinalizeAnalyses || this.analyzer.finalizeAnalyses)(stagingDir); return await this._command(run.runId, 'analysisComplete', result, { token }); }
        catch (e) { return this._fail(run, e); } finally { await cleanup(); }
      })();
      job.stop = async () => { controller.abort(errorWithCode('import cancelled', 'cancelled')); await cleanup(); };
      work.jobs.set(work.key(this.store, run.runId), job); this.controllers.set(run.runId, controller);
      job.timer = setTimeout(() => { controller.abort(errorWithCode('analyze deadline exceeded', 'import_timeout', true)); this._fail(run, controller.signal.reason).finally(cleanup).catch(() => {}); }, this.deadlines.analyze);
      this.analysisTimers.set(run.runId, job.timer);
      job.started = (this.analyzer.executeStartAnalyses || this.analyzer.startAnalyses)(stagingDir, { abortSignal: controller.signal });
      const started = await job.started;
      return await this._command(run.runId, 'analysisStarted', { ...started, startedAt: new Date().toISOString() }, { token });
    } catch (e) { await cleanup(); return this._fail(run, e); }
  }
  async analyzeImport(id) {
    let run = await this._writable(id);
    if (run.state === 'analyzing' || run.state === 'review') {
      const job = work.jobs.get(work.key(this.store, run.runId));
      if (!job && await work.alive(this.store, run.work)) throw errorWithCode('分析正由另一所有者执行', 'import_worker_busy', true);
      await job?.stop?.();
      run = await this._command(run.runId, 'restartAnalysis', {}, { expectedRevision: run.revision });
    }
    const result = await this.resume(run.runId);
    if (result.state !== 'analyzing') throw errorWithCode(result.error?.message || '分析未启动', result.error?.code || 'invalid_import_state', result.retryable);
    return { ...result.analysis, importRun: result };
  }
  async finishAnalysisImport(id) {
    const run = await this.resume(id);
    if (run.state !== 'review') throw errorWithCode(run.error?.message || '分析未完成，请等待当前所有者', run.error?.code || 'import_worker_busy', true);
    return run.analysisResult;
  }
  async cancel(id) {
    const run = await this._writable(id);
    const current = await this._command(run.runId, 'cancel');
    this.controllers.get(run.runId)?.abort(errorWithCode('import cancelled', 'cancelled'));
    await work.jobs.get(work.key(this.store, run.runId))?.stop?.();
    // Notification is a projection for observers, never an authorization source.
    if (current.importId && this.staging.recordCancelRequest) await this.staging.recordCancelRequest(current.importId);
    if (current.commitDecision && current.state !== 'completed') return this.finalize(current.runId);
    if (current.state === 'cancelled' && current.importId && this.staging.cleanupPromotion) await this.staging.cleanupPromotion(current.importId);
    return this.get(current.runId);
  }
  async promoteImport(id, options = {}) {
    let run = await this._writable(id);
    if (options.abortSignal?.aborted) { await this.cancel(run.runId); throw options.abortSignal.reason || errorWithCode('cancelled', 'cancelled'); }
    let cancellation;
    const onAbort = () => { cancellation = this.cancel(run.runId); cancellation.catch(() => {}); };
    options.abortSignal?.addEventListener('abort', onAbort, { once: true });
    try {
      if (['failed', 'interrupted'].includes(run.state)) run = await this._command(run.runId, 'recover');
      if (run.state === 'staged') run = await this._command(run.runId, 'legacyReview', {}, { expectedRevision: run.revision });
      let result = await this.finalize(run.runId, { target: { dir: options.dir, title: options.title } });
      if (cancellation) result = await cancellation;
      if (result.state !== 'completed') throw errorWithCode(result.error?.message || '导入已取消', result.state === 'cancelled' ? 'cancelled' : result.error?.code, result.retryable);
      return result.result;
    } finally { options.abortSignal?.removeEventListener('abort', onAbort); }
  }
  async createMerge(id, novelId, options = {}) {
    let run = await this._writable(id);
    if (options.legacy && run.state === 'staged') run = await this._command(run.runId, 'legacyReview', {}, { expectedRevision: run.revision });
    state.guard(run, 'mergePrepared');
    if ((await require('./reviewStore').list(path.join(this.stagingRoot, run.importId))).length) throw errorWithCode('请完成候选事实审阅', 'unresolved_facts', true);
    const target = await this.novels.pathsFor(novelId);
    if (options.novelDir && path.resolve(options.novelDir) !== path.resolve(target.root)) throw errorWithCode('import merge target mismatch', 'import_target_mismatch');
    const prepare = this.merge.prepareSession || this.merge.createMergeSession;
    const session = await prepare(path.join(this.stagingRoot, run.importId), novelId, target.root);
    await this._command(run.runId, 'mergePrepared', { novelId, ...session, targetDir: require('../store/projectTransactions').canonicalRoot(target.root) }, { expectedRevision: run.revision });
    return session;
  }
  async _sessionRun(sessionId) {
    const session = await this.merge.getMergeSession(sessionId);
    if (!session) throw errorWithCode('merge session missing', 'merge_session_missing');
    let run = await this.get(session.stagingId);
    const legacy = run.schemaVersion < 2;
    if (legacy) run = await this._writable(run.runId);
    if (!run.mergeSessionId && legacy && !TERMINAL.has(run.state)) {
      await this.createMerge(run.runId, session.novelId, { legacy: true }); run = await this.get(run.runId);
    }
    if (run.targetNovelId && run.targetNovelId !== session.novelId) throw errorWithCode('merge target mismatch', 'import_target_mismatch');
    return { run, session };
  }
  async finalizeSession(sessionId) {
    const { run, session } = await this._sessionRun(sessionId);
    if (run.mergeSessionId !== session.id && run.mergeSessionId !== sessionId) throw errorWithCode('merge session is not bound to this run', 'import_target_mismatch');
    let snapshot = run;
    if (['failed', 'interrupted'].includes(run.state)) snapshot = await this._command(run.runId, 'recover', {}, { expectedRevision: run.revision });
    snapshot = await this.finalize(snapshot.runId);
    if (snapshot.state !== 'completed') throw errorWithCode(snapshot.error?.message || 'merge incomplete', snapshot.error?.code || 'invalid_import_state', snapshot.retryable);
    return snapshot.result?.receipt || snapshot.checkpoints.findLast((c) => c.mergeReceipt)?.mergeReceipt;
  }
  async resolveConflict(id, input = {}) {
    const run = await this.get(id);
    if (!run.mergeSessionId) throw errorWithCode('merge session is not ready', 'unresolved_conflicts', true);
    return this._command(run.runId, 'mergeChanged', {}, { effectRoot: this.merge.materialRoot?.(), effect: async (current) => {
      await (this.merge.applyDecision || this.merge.resolveConflict)(current.mergeSessionId, input.itemId, input.decision, input);
      return { summary: await this.merge.getMergeSummary(current.mergeSessionId) };
    } });
  }
  async resolveSession(sessionId, itemId, decision, options = {}) {
    const { run } = await this._sessionRun(sessionId);
    await this.resolveConflict(run.runId, { itemId, decision, ...options });
    return (await this.merge.getMergeSession(sessionId)).items.find((item) => item.id === itemId);
  }
  async resetSession(sessionId, itemId) {
    const { run } = await this._sessionRun(sessionId);
    return this._command(run.runId, 'mergeChanged', {}, { effectRoot: this.merge.materialRoot?.(), effect: async () => { await this.merge.resetChoices(sessionId, itemId); return { summary: await this.merge.getMergeSummary(sessionId) }; } });
  }
  async reviewImport(id, reviewId, action, input) {
    let run = await this._writable(id);
    const root = path.join(this.stagingRoot, run.importId), reviews = require('./reviewStore');
    const review = await reviews.get(root, reviewId);
    if (review.state === 'committed' && action === 'finish') return review;
    if (run.state === 'staged') run = await this._command(run.runId, 'legacyReview', {}, { expectedRevision: run.revision });
    let result;
    await this._command(run.runId, 'reviewChanged', {}, { effectRoot: root, effect: async () => {
      result = action === 'decide' ? await reviews.executeDecide(root, reviewId, input) : await reviews.executeFinish(root, reviewId, input);
      return {};
    } });
    return result;
  }
  async finalize(id, input = {}) {
    let run = await this._writable(id);
    if (run.state === 'completed') return run;
    if (!['review', 'merging', 'promoting'].includes(run.state)) throw errorWithCode('import must be reviewed before finalize', 'invalid_import_state');
    if ((await require('./reviewStore').list(path.join(this.stagingRoot, run.importId))).length) throw errorWithCode('请完成候选事实审阅后再提交', 'unresolved_facts', true);
    try {
      if (run.targetNovelId) {
        if (!run.mergeSessionId) { await this.createMerge(run.runId, run.targetNovelId); run = await this.get(run.runId); }
        const decide = async (decision) => this.store.command(run.runId, 'decideCommit', decision, run.commitDecision ? {} : { expectedRevision: run.revision });
        let receipt;
        if (this.merge.executeMerge) receipt = await this.merge.executeMerge(run.mergeSessionId, { target: { id: run.targetNovelId, importId: run.importId, root: run.mergeTargetDir }, read: () => this.store.get(run.runId), decide, stale: async (session, error) => this.store.command(run.runId, 'mergeChanged', { error: { code: error.code, message: error.message, phase: 'merging' } }, { expectedRevision: run.revision, effectRoot: this.merge.materialRoot(), effect: async () => { await this.merge.saveMaterial(session); return { summary: await this.merge.getMergeSummary(session.id) }; } }) });
        else { const summary = await this.merge.getMergeSummary(run.mergeSessionId); if (summary.pending || summary.disputed) throw errorWithCode('all conflicts require decisions', 'unresolved_conflicts', true); await decide({ id: run.mergeSessionId, kind: 'merge', sessionId: run.mergeSessionId, novelId: run.targetNovelId, importId: run.importId, targetDir: run.mergeTargetDir }); receipt = await this.merge.finalizeMerge(run.mergeSessionId); }
        return this._command(run.runId, 'completed', { decisionId: run.mergeSessionId, result: { id: run.targetNovelId, receipt }, mergeReceipt: receipt });
      }
      run = await this.store.command(run.runId, 'beginPromotion', { target: input.target });
      const authority = { read: () => this.store.get(run.runId), decide: (operation) => this.store.command(run.runId, 'decideCommit', { id: operation.operationId, kind: 'promotion', operation }, run.commitDecision ? {} : { token: run.work.token }) };
      const result = await this._deadline(run.runId, 'promote', async (abortSignal) => {
        if (this.staging.executePromotion) return this.staging.executePromotion(run.importId, { ...(input.target || run.target || {}), abortSignal }, authority);
        await this.store.command(run.runId, 'decideCommit', { id: run.runId, kind: 'promotion' }, { token: run.work.token });
        return this.staging.promoteToNovel(run.importId, { ...(input.target || run.target || {}), abortSignal });
      });
      const current = await this.store.get(run.runId);
      return this._command(run.runId, 'completed', { decisionId: current.commitDecision.id, result });
    } catch (e) { const result = await this._fail(run, e); if (e.invalidRecord) throw e; return result; }
  }
}
module.exports = { ImportSagaService, TERMINAL, errorWithCode };
