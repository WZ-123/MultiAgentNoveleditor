'use strict';
// Independent counterexample audit. Product code is not modified.
// Each case asserts correct behavior; a reproduced defect makes this script fail.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const repo = path.resolve(__dirname, '..');
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
  const results = { createdAt: new Date().toISOString(), type: 'strict-authority-regression', cases: [] };
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
      for (const item of session.items) await merge.resolveConflict(session.sessionId, item.id, 'left');
      // A real second process is suspended at the stale-read/save instruction.
      // The hook adds no async yield and changes no data or return value. It
      // controls OS scheduling; SIGCONT runs the original production save.
      const code = `const fs=require('node:fs');const S=require(process.argv[1]).ImportSagaService;const s=new S();const get=s.store.get.bind(s.store);let once=true;s.store.get=async(...args)=>{const run=await get(...args);if(once&&run?.state==='merging'){once=false;fs.writeSync(1,'AUDIT_BEFORE_SAVE\\n');process.kill(process.pid,'SIGSTOP')}return run};s.finalizeSession(process.argv[2]).then(r=>{fs.writeSync(1,'AUDIT_RESULT '+JSON.stringify(r)+'\\n')}).catch(e=>{console.error(e);process.exitCode=2});`;
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
      assert.equal(after.state, 'review', 'the original owner is joined instead of restarting the analysis');
    });

    await check('AUTH-05', 'A stale snapshot cannot replace cancelled or manufacture a commit decision', async () => {
      const saga = new ImportSagaService({ analyzer }); const run = await ready(saga);
      const stale = await saga.store.get(run.runId); await saga.cancel(run.runId);
      await assert.rejects(saga.store.save(stale), { code: 'stale_import_operation' });
      const cancelled = await saga.store.get(run.runId);
      await assert.rejects(saga.store.command(run.runId, 'decideCommit', { id: 'forbidden', kind: 'merge' }), { code: 'invalid_import_state' });
      assert.deepEqual(await saga.store.get(run.runId), cancelled);
    });

    await check('AUTH-06', 'All direct compatibility mutation APIs respect the same cancellation', async () => {
      const target = await novels.createNovel({ title: '入口矩阵', dir: path.join(temp, 'entry-target') });
      const saga = new ImportSagaService({ analyzer }); const run = await ready(saga, { targetNovelId: target.id });
      const session = await saga.createMerge(run.runId, target.id);
      const before = await merge.getMergeSession(session.sessionId);
      await saga.cancel(run.runId);
      await assert.rejects(merge.resolveConflict(session.sessionId, session.items[0].id, 'left'), { code: 'invalid_import_state' });
      await assert.rejects(merge.resetAll(session.sessionId), { code: 'invalid_import_state' });
      await assert.rejects(merge.finalizeMerge(session.sessionId), { code: 'invalid_import_state' });
      await assert.rejects(merge.createMergeSession(before.stagingDir, target.id, target.dir), { code: 'invalid_import_state' });
      await assert.rejects(staging.promoteToNovel(run.importId, { dir: path.join(temp, 'forbidden-promotion') }));
      const actualAnalyzer = load('src/main/import/analyzer');
      await assert.rejects(actualAnalyzer.startAnalyses(before.stagingDir), { code: 'invalid_import_state' });
      assert.deepEqual(await merge.getMergeSession(session.sessionId), before, 'cancelled decisions cannot be edited through sessionId APIs');
      assert.equal(await fs.access(path.join(target.dir, 'chapters/chapter-001.md')).then(() => true, () => false), false);
    });

    await check('AUTH-07', 'Concurrent adoption of a legacy staging project returns one run identity', async () => {
      const staged = await staging.createStagingProject({ chapters: [{ title: '旧暂存', content: '原文' }], metadata: {} });
      const reads = await Promise.all(Array.from({ length: 5 }, () => new ImportSagaService({ analyzer }).get(staged.importId)));
      assert.equal(new Set(reads.map((r) => r.runId)).size, 1);
      await new ImportSagaService({ analyzer }).cancel(reads[0].runId);
    });

    await check('AUTH-08', 'A real dead analysis owner is recovered explicitly with a new generation', async (observed) => {
      const code = `const fs=require('node:fs');const S=require(process.argv[1]).ImportSagaService;const a={startAnalyses:async()=>({chunkCount:1}),finalizeAnalyses:async()=>({status:'complete'})};const s=new S({analyzer:a});s.start({parsed:{chapters:[{title:'中断',content:'原文'}]}}).then(r=>s.resume(r.runId)).then(r=>fs.writeSync(1,'OWNER '+JSON.stringify(r)+'\\n')).catch(e=>{console.error(e);process.exitCode=2});`;
      const child = spawn(process.execPath, ['-e', code, path.join(repo, 'src/main/import/importSaga.js')], { stdio: ['ignore', 'pipe', 'pipe'] });
      let text = '', error = ''; child.stderr.on('data', (b) => { error += b; });
      const ended = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
      let timeout;
      const owner = await new Promise((resolve, reject) => {
        timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('owner fixture timeout ' + error)); }, 10000);
        child.stdout.on('data', (b) => { text += b; const line = text.split('\n').find((s) => s.startsWith('OWNER ')); if (line) { clearTimeout(timeout); resolve(JSON.parse(line.slice(6))); } });
      });
      child.kill('SIGKILL'); assert.equal((await ended).signal, 'SIGKILL');
      const observer = new ImportSagaService({ analyzer });
      assert.equal((await observer.get(owner.runId)).state, 'analyzing', 'reading does not mutate the persisted state');
      const ownership = load('src/main/import/importWork'); const deadline = Date.now() + 15000;
      while (await ownership.alive(observer.store, owner.work)) { assert.ok(Date.now() < deadline, 'dead owner lease must expire'); await new Promise((r) => setTimeout(r, 50)); }
      const resumed = await observer.resume(owner.runId);
      assert.equal(resumed.state, 'analyzing'); assert.notEqual(resumed.work.token, owner.work.token);
      assert.ok(resumed.generation > owner.generation);
      observed.oldToken = owner.work.token; observed.newToken = resumed.work.token;
      assert.equal((await observer.resume(owner.runId)).state, 'review');
      await observer.cancel(owner.runId);
    });

    await check('AUTH-09', 'A legacy irreversible promotion decision wins over its contradictory old cancelled run', async () => {
      const saga = new ImportSagaService({ analyzer }); const target = path.join(temp, 'legacy-decision'); const run = await ready(saga, { target: { dir: target } });
      const child = spawn(process.execPath, [path.join(repo, 'test/import-promotion-crash-child.js'), run.runId, run.importId, target, 'rename'], { stdio: 'ignore' });
      assert.equal(await new Promise((r) => child.on('exit', r)), 73);
      const file = saga.store.file(run.runId), old = JSON.parse(await fs.readFile(file));
      old.schemaVersion = 1; old.state = 'cancelled'; delete old.commitDecision; delete old.work;
      await fs.writeFile(file, JSON.stringify(old));
      const recovered = await new ImportSagaService({ analyzer }).cancel(run.runId);
      assert.equal(recovered.state, 'completed'); assert.ok(recovered.result.receipt.operationId);
      assert.equal((await novels.listNovels()).filter((n) => n.dir === target).length, 1);
    });

    await check('AUTH-10', 'A failed authority revision save rolls back the unacknowledged merge choice', async () => {
      const target = await novels.createNovel({ title: '取舍原子边界', dir: path.join(temp, 'choice-failure') });
      const saga = new ImportSagaService({ analyzer }); const run = await ready(saga, { targetNovelId: target.id });
      const session = await saga.createMerge(run.runId, target.id);
      const before = await merge.getMergeSession(session.sessionId), row = await saga.store.get(run.runId), rename = fs.rename;
      let once = true;
      fs.rename = async (a, b, ...args) => { if (once && path.basename(b) === run.runId + '.json') { once = false; throw Object.assign(new Error('authority revision EIO'), { code: 'EIO' }); } return rename(a, b, ...args); };
      try { await assert.rejects(merge.resolveConflict(session.sessionId, session.items[0].id, 'left'), { code: 'EIO' }); }
      finally { fs.rename = rename; }
      assert.deepEqual(await merge.getMergeSession(session.sessionId), before);
      assert.deepEqual(await saga.store.get(run.runId), row);
      await saga.cancel(run.runId);
    });

    await check('AUTH-11', 'A failed authority save rolls back reviewed domain bytes and the review terminal', async () => {
      const saga = new ImportSagaService({ analyzer }); const run = await ready(saga);
      const root = path.join(process.env.MANA_USER_DATA_ROOT, 'import-staging', run.importId);
      const changes = [{ ...await plans.snapshot(root, 'world/meta.json'), after: JSON.stringify({ lore: '候选世界', _analysisCandidates: { lore: [{ value: '候选世界' }] } }) }];
      const review = await reviews.create(root, { kind: 'analysis', fields: reviews.fieldsForChanges(changes), plan: { changes } });
      await reviews.decide(root, review.id, Object.fromEntries(review.fields.map((f) => [f.id, 0])));
      const before = await fs.readFile(path.join(root, 'world/meta.json'), 'utf8').catch((e) => { if (e.code === 'ENOENT') return null; throw e; });
      const row = await saga.store.get(run.runId), rename = fs.rename; let once = true;
      fs.rename = async (a, b, ...args) => { if (once && path.basename(b) === run.runId + '.json') { once = false; throw Object.assign(new Error('review revision EIO'), { code: 'EIO' }); } return rename(a, b, ...args); };
      try { await assert.rejects(reviews.finish(root, review.id, true), { code: 'EIO' }); } finally { fs.rename = rename; }
      assert.equal(await fs.readFile(path.join(root, 'world/meta.json'), 'utf8').catch((e) => { if (e.code === 'ENOENT') return null; throw e; }), before);
      assert.equal((await reviews.get(root, review.id)).state, 'review');
      assert.deepEqual(await saga.store.get(run.runId), row);
      await saga.cancel(run.runId);
      await assert.rejects(reviews.finish(root, review.id, true), { code: 'invalid_import_state' });
    });

    await check('AUTH-12', 'Unregistered promotion recovery cannot adopt files absent from its manifest', async () => {
      const target = path.join(temp, 'unlisted-file'); const saga = new ImportSagaService({ analyzer }); const run = await ready(saga, { target: { dir: target } });
      const child = spawn(process.execPath, [path.join(repo, 'test/import-promotion-crash-child.js'), run.runId, run.importId, target, 'rename'], { stdio: 'ignore' });
      assert.equal(await new Promise((r) => child.on('exit', r)), 73);
      const foreign = path.join(target, 'chapters/unreviewed.md'); await fs.writeFile(foreign, '不属于本次清单的内容');
      const result = await new ImportSagaService({ analyzer }).finalize(run.runId);
      assert.equal(result.state, 'interrupted'); assert.equal(result.error.code, 'recovery_required');
      assert.equal((await novels.listNovels()).some((n) => n.dir === target), false);
      assert.equal(await fs.readFile(foreign, 'utf8'), '不属于本次清单的内容');
    });

    await check('AUTH-13', 'The run decision recovers even when the physical checkpoint was not advanced', async () => {
      const target = path.join(temp, 'authority-decision'); const saga = new ImportSagaService({ analyzer }); const run = await ready(saga, { target: { dir: target } });
      const child = spawn(process.execPath, [path.join(repo, 'test/import-promotion-crash-child.js'), run.runId, run.importId, target, 'authority-decision'], { stdio: 'ignore' });
      assert.equal(await new Promise((r) => child.on('exit', r)), 73);
      const projection = JSON.parse(await fs.readFile(path.join(process.env.MANA_USER_DATA_ROOT, 'import-promotions', run.importId, 'state.json')));
      assert.equal(projection.state, 'preparing');
      const result = await new ImportSagaService({ analyzer }).cancel(run.runId);
      assert.equal(result.state, 'completed'); assert.ok(result.commitDecision);
      assert.equal(result.result.receipt.operationId, result.commitDecision.id);
    });

    await check('AUTH-14', 'A dead source owner resumes its saved preview and metadata before staging exists', async () => {
      const code = `const fs=require('node:fs');const S=require(process.argv[1]).ImportSagaService;const s=new S();const create=s.store.create.bind(s.store);s.store.create=async(i)=>{const r=await create(i);fs.writeSync(1,'SOURCE '+JSON.stringify(r)+'\\n');process.kill(process.pid,'SIGSTOP');return r};s.start({parsed:{chapters:[{title:'预览原文',content:'必须保留的来源预览正文'}]},metadata:{fanwork:{hasFanwork:false,referencedWorks:[]}}}).catch(e=>{console.error(e);process.exitCode=2});`;
      const child = spawn(process.execPath, ['-e', code, path.join(repo, 'src/main/import/importSaga.js')], { stdio: ['ignore', 'pipe', 'pipe'] });
      let text = '', timer; const ended = new Promise((r) => child.on('exit', (code, signal) => r({ code, signal })));
      const original = await new Promise((resolve, reject) => {
        timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('source fixture timeout')); }, 10000);
        child.stdout.on('data', (b) => { text += b; const line = text.split('\n').find((s) => s.startsWith('SOURCE ')); if (line) { clearTimeout(timer); resolve(JSON.parse(line.slice(7))); } });
      });
      child.kill('SIGKILL'); assert.equal((await ended).signal, 'SIGKILL');
      const service = new ImportSagaService({ analyzer }); assert.equal((await service.get(original.runId)).state, 'picked');
      const ownership = load('src/main/import/importWork'), deadline = Date.now() + 15000;
      while (await ownership.alive(service.store, original.work)) { assert.ok(Date.now() < deadline); await new Promise((r) => setTimeout(r, 50)); }
      const recovered = await service.resume(original.runId); assert.equal(recovered.state, 'staged'); assert.ok(recovered.generation > original.generation);
      const source = await staging.getStagingProject(recovered.importId);
      assert.ok(source.chapters[0].content.includes('必须保留的来源预览正文'));
      assert.deepEqual(source.novelMeta.fanwork, { hasFanwork: false, referencedWorks: [] });
      await service.cancel(recovered.runId);
    });

    await check('AUTH-15', 'A legacy committed merge is adopted from its verified file-transaction receipt', async () => {
      const target = await novels.createNovel({ title: '旧合并', dir: path.join(temp, 'legacy-merge') });
      const service = new ImportSagaService({ analyzer }); const run = await ready(service, { targetNovelId: target.id });
      const session = await service.createMerge(run.runId, target.id);
      for (const item of session.items) await merge.resolveConflict(session.sessionId, item.id, 'left');
      const receipt = await service.finalizeSession(session.sessionId);
      await fs.unlink(service.store.file(run.runId));
      const restored = await new ImportSagaService({ analyzer }).cancel(run.importId);
      assert.equal(restored.state, 'completed'); assert.deepEqual(restored.result.receipt, receipt);
      assert.equal(await fs.readFile(path.join(target.dir, 'chapters/chapter-001.md'), 'utf8'), '# 审计章节\n\n本次导入的完整新正文');
    });

    await check('AUTH-16', 'A failed parsed source with no local worker claims a fresh token and stages its saved request', async () => {
      let fail = true;
      const service = new ImportSagaService({ analyzer, staging: { ...staging, createStagingProject: async (...args) => { if (fail) { fail = false; throw Object.assign(new Error('source EIO'), { code: 'EIO' }); } return staging.createStagingProject(...args); } } });
      const run = await service.start({ parsed: { chapters: [{ title: '恢复解析来源', content: '旧快照保持完整' }] }, metadata: { fanwork: { hasFanwork: false } } });
      assert.equal(run.state, 'failed'); assert.equal(run.error.phase, 'parsed'); assert.equal(run.importId, null);
      const recovered = await service.resume(run.runId);
      assert.equal(recovered.state, 'staged'); assert.ok(recovered.generation > run.generation);
      const source = await staging.getStagingProject(recovered.importId); assert.equal(source.chapters[0].content, '旧快照保持完整'); assert.deepEqual(source.novelMeta.fanwork, { hasFanwork: false });
      await service.cancel(run.runId);
    });

    await check('AUTH-17', 'Candidate defaults and omissions are not authorization to erase existing facts', async () => {
      const root = path.join(temp, 'omitted-facts'); ensureNovelLayout(root);
      const world = { lore: '已有设定', timeSetting: '已有年代', rules: '已有规则', isFanwork: true, custom: '自定义元数据', places: [{ name: '城镇', description: '已有地点说明', custom: '地点自定义值' }] };
      const markdown = '# 用户原正文\n\n必须逐字保留。\n';
      await fs.writeFile(path.join(root, 'world/meta.json'), JSON.stringify(world));
      await fs.writeFile(path.join(root, 'world/places.json'), JSON.stringify({ places: world.places }));
      await fs.writeFile(path.join(root, 'world/lore.md'), markdown);
      const candidate = merger.mergeWorld([{ chunkIndex: 0, world: { places: [{ name: '城镇', description: '' }] } }]);
      const changes = [{ ...await plans.snapshot(root, 'world/meta.json'), after: JSON.stringify(candidate) }, { ...await plans.snapshot(root, 'world/places.json'), after: JSON.stringify({ places: candidate.places }) }, { ...await plans.snapshot(root, 'world/lore.md'), after: '' }];
      const review = await reviews.create(root, { kind: 'analysis', fields: reviews.fieldsForChanges(changes), plan: { changes } });
      await reviews.decide(root, review.id, Object.fromEntries(review.fields.map((f) => [f.id, 0]))); await reviews.finish(root, review.id, true);
      const saved = JSON.parse(await fs.readFile(path.join(root, 'world/meta.json')));
      for (const key of ['lore', 'timeSetting', 'rules', 'isFanwork', 'custom']) assert.deepEqual(saved[key], world[key]);
      assert.deepEqual(saved.places, world.places); assert.equal(await fs.readFile(path.join(root, 'world/lore.md'), 'utf8'), markdown);
    });
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
    await fs.writeFile(path.join(__dirname, '../artifacts/data-import-safety-audit/authority-regression-results.json'), JSON.stringify(results, null, 2) + '\n');
  }
  process.exitCode = results.cases.some((r) => r.status === 'correctness-assertion-failed') ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 2; });
