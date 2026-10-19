'use strict';
// Independent counterexample audit. Product code is not modified.
// Each case asserts correct behavior; a reproduced defect makes this script fail.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const repo = path.resolve(__dirname, '../..');
const load = (file) => require(path.join(repo, file));
const reviews = load('src/main/import/reviewStore');
const plans = load('src/main/import/resourcePlan');
const merger = load('src/main/import/resultMerger');
const staging = load('src/main/import/stagingProject');
const novels = load('src/main/store/novels');
const merge = load('src/main/import/mergeEngine');
const { ensureNovelLayout } = load('src/main/store/paths');
const { ImportSagaService } = load('src/main/import/importSaga');
const analyzer = { startAnalyses: async () => ({ chunkCount: 1 }), finalizeAnalyses: async () => ({ status: 'complete' }) };
async function start(saga, target = {}) {
  return saga.start({ parsed: { chapters: [{ title: '审计章节', content: '本次导入的完整新正文' }], metadata: { title: '独立反例' } }, ...target });
}
async function ready(saga, target = {}) {
  const run = await start(saga, target); await saga.resume(run.runId);
  assert.equal((await saga.resume(run.runId)).state, 'review'); return run;
}
(async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'mana-post-p1-audit-'));
  process.env.MANA_USER_DATA_ROOT = path.join(temp, 'user-data');
  const results = { createdAt: new Date().toISOString(), type: 'strict-correctness-counterexample-audit', productEdits: false, cases: [] };
  async function check(id, title, fn) {
    const item = { id, title, observed: {} }; results.cases.push(item);
    try { await fn(item.observed); item.status = 'correct-behavior-confirmed'; console.log('PASS ' + id + ' ' + title); }
    catch (error) { item.status = 'correctness-assertion-failed'; item.error = error.stack; console.error('FAIL ' + id + ' ' + title + '\n' + error.stack); }
  }
  try {
    await check('PA-01', 'A selectable alternative name must not invalidate later fields of an ID-less place', async (observed) => {
      const root = path.join(temp, 'place'); ensureNovelLayout(root);
      const old = { lore: '原世界', places: [{ name: '古城', description: '用户旧说明', custom: '必须保留' }] };
      await fs.writeFile(path.join(root, 'world/meta.json'), JSON.stringify(old));
      await fs.writeFile(path.join(root, 'world/places.json'), JSON.stringify({ places: old.places }));
      // Real chunk merger groups spelling/whitespace variants into one entity.
      const world = merger.mergeWorld([
        { chunkIndex: 0, world: { places: [{ name: '古城', description: '候选说明甲' }] } },
        { chunkIndex: 1, world: { places: [{ name: '古 城', description: '候选说明乙' }] } },
      ]);
      const changes = [
        { ...await plans.snapshot(root, 'world/meta.json'), after: JSON.stringify(world) },
        { ...await plans.snapshot(root, 'world/places.json'), after: JSON.stringify({ places: world.places }) },
      ];
      const review = await reviews.create(root, { kind: 'analysis', fields: reviews.fieldsForChanges(changes), plan: { changes } });
      const name = review.fields.find((f) => f.id === 'world/meta.json:places.0.name');
      assert.equal(name.candidates[1].value, '古 城');
      const decisions = Object.fromEntries(review.fields.map((f) => [f.id, f.id === name.id ? 1 : f.id.endsWith('.description') ? 'reject' : 0]));
      await reviews.decide(root, review.id, decisions);
      let error; try { await reviews.finish(root, review.id, true); } catch (e) { error = e; }
      observed.selectedName = name.candidates[1].value; observed.error = error?.message || null;
      observed.reviewState = (await reviews.get(root, review.id)).state;
      observed.places = JSON.parse(await fs.readFile(path.join(root, 'world/places.json'))).places;
      assert.equal(error, undefined, 'a valid alternative name must complete instead of losing its own entity binding');
      assert.equal(observed.places[0].description, '用户旧说明');
    });

    await check('PA-02', 'Cancellation acknowledged before a pending compatibility submission enters commit must prevent formal writes', async (observed) => {
      const target = path.join(temp, 'merge-target'); const entry = await novels.createNovel({ title: '原项目', dir: target });
      const saga = new ImportSagaService({ analyzer }); const run = await ready(saga, { targetNovelId: entry.id });
      const session = await saga.createMerge(run.runId, entry.id);
      for (const item of session.items) merge.resolveConflict(session.sessionId, item.id, 'left');
      // A real second process is suspended at the stale-read/save instruction.
      // The hook adds no async yield and changes no data or return value. It
      // controls OS scheduling; SIGCONT runs the original production save.
      const code = `const fs=require('node:fs');const S=require(process.argv[1]).ImportSagaService;const s=new S();const save=s.store.save.bind(s.store);let once=true;s.store.save=(run)=>{if(once&&run.state==='merging'){once=false;fs.writeSync(1,'AUDIT_BEFORE_SAVE\\n');process.kill(process.pid,'SIGSTOP')}return save(run)};s.finalizeSession(process.argv[2]).then(r=>{fs.writeSync(1,'AUDIT_RESULT '+JSON.stringify(r)+'\\n')}).catch(e=>{console.error(e);process.exitCode=2});`;
      const child = spawn(process.execPath, ['-e', code, path.join(repo, 'src/main/import/importSaga.js'), session.sessionId], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = ''; child.stderr.on('data', (b) => { stderr += b; });
      const finished = new Promise((resolve) => child.on('exit', (exitCode, signal) => resolve({ exitCode, signal })));
      let timeout;
      const entered = new Promise((resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('child did not reach the scheduling boundary: ' + stderr)), 10000);
        child.stdout.on('data', (b) => { stdout += b; if (stdout.includes('AUDIT_BEFORE_SAVE\n')) { clearTimeout(timeout); resolve(); } });
      });
      await entered;
      try {
        const cancelled = await saga.cancel(run.runId); observed.cancelResponse = cancelled.state;
        assert.equal(cancelled.state, 'cancelled');
        observed.formalTextAtCancellation = await fs.readFile(path.join(target, 'chapters/chapter-001.md'), 'utf8').catch((e) => { if (e.code === 'ENOENT') return null; throw e; });
      } finally { child.kill('SIGCONT'); clearTimeout(timeout); }
      observed.child = await finished; observed.childStderr = stderr;
      observed.receiptReturned = stdout.includes('AUDIT_RESULT ');
      observed.newUserActionAfterCancellation = false;
      observed.formalText = await fs.readFile(path.join(target, 'chapters/chapter-001.md'), 'utf8').catch((e) => { if (e.code === 'ENOENT') return null; throw e; });
      observed.durableState = (await saga.store.get(run.runId)).state;
      assert.equal(observed.formalText, null, 'a cancelled run must not later write its imported chapter into the formal project');
      assert.equal(observed.durableState, 'cancelled');
    });

    await check('PA-03', 'Cancelling a retryable failed promotion must persist and return cancelled', async (observed) => {
      const target = path.join(temp, 'failed-target'); const saga = new ImportSagaService({ analyzer });
      const run = await ready(saga, { target: { dir: target } }); const copy = fs.copyFile;
      fs.copyFile = async (...args) => { if (String(args[0]).endsWith('chapter-001.md')) throw Object.assign(new Error('isolated EIO'), { code: 'EIO' }); return copy(...args); };
      let failed; try { failed = await saga.finalize(run.runId); } finally { fs.copyFile = copy; }
      assert.equal(failed.state, 'failed'); assert.equal(failed.retryable, true);
      observed.before = { state: failed.state, retryable: failed.retryable, actions: failed.allowedActions };
      const cancelled = await saga.cancel(run.runId);
      observed.response = { state: cancelled.state, actions: cancelled.allowedActions };
      observed.durableState = (await saga.store.get(run.runId)).state;
      observed.promotionState = (await staging.getPromotion(run.importId)).state;
      assert.equal(cancelled.state, 'cancelled', 'the advertised cancel action must terminate the run as well as its promotion ledger');
      assert.equal(observed.durableState, 'cancelled');
    });

    await check('PA-04', 'Reading an active analysis from another service must not declare it interrupted', async (observed) => {
      const active = new ImportSagaService({ analyzer }); const run = await start(active);
      assert.equal((await active.resume(run.runId)).state, 'analyzing');
      const firstTimer = active.analysisTimers.get(run.runId);
      const another = new ImportSagaService({ analyzer }); const read = await another.get(run.runId);
      observed.otherServiceState = read.state; observed.error = read.error;
      observed.originalServiceState = (await active.store.get(run.runId)).state;
      const after = await active.resume(run.runId); observed.originalResumeState = after.state;
      await active.cancel(run.runId); // clear only this probe's analysis timer/controller
      clearTimeout(firstTimer); // a second resume replaced this probe's first timer
      assert.equal(read.state, 'analyzing', 'a process-local controller map cannot establish that another owner has stopped');
    });
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
    await fs.writeFile(path.join(__dirname, 'post-p1-re-audit-results.json'), JSON.stringify(results, null, 2) + '\n');
  }
  process.exitCode = results.cases.some((r) => r.status === 'correctness-assertion-failed') ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 2; });
