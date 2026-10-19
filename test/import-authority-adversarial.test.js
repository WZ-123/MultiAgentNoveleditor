'use strict';
// A second audit of cross-entry schedules, independent of the four original probes.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { ImportSagaService } = require('../src/main/import/importSaga');
const staging = require('../src/main/import/stagingProject');
const novels = require('../src/main/store/novels');
const merge = require('../src/main/import/mergeEngine');
const data = require('../src/main/store/novelData');
const analyzer = { startAnalyses: async () => ({}), finalizeAnalyses: async () => ({ status: 'complete' }) };
function barrier() { let release; const promise = new Promise((r) => { release = r; }); return { promise, release }; }
async function ready(service, input = {}) {
  const run = await service.start({ parsed: { chapters: [{ title: '跨入口', content: '原文事实不能被旧任务覆盖' }] }, ...input });
  await service.resume(run.runId); assert.equal((await service.resume(run.runId)).state, 'review'); return run;
}
(async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'mana-authority-audit-')), oldRoot = process.env.MANA_USER_DATA_ROOT;
  process.env.MANA_USER_DATA_ROOT = path.join(temp, 'data'); const results = [];
  const check = async (name, fn) => { try { await fn(); results.push({ name, passed: true }); console.log('PASS ' + name); } catch (error) { results.push({ name, passed: false, error: error.stack }); console.error('FAIL ' + name + '\n' + error.stack); } };
  try {
    await check('snapshot compatibility cannot change error, retry policy, schema, source or state authority', async () => {
      const service = new ImportSagaService({ analyzer }); const run = await ready(service); const before = await service.store.get(run.runId);
      for (const change of [{ error: { phase: 'picked' } }, { retryable: true }, { schemaVersion: 1 }, { request: { parsed: { chapters: [] } } }, { work: { token: 'foreign' } }, { commitDecision: { id: 'foreign' } }]) {
        await assert.rejects(service.store.save({ ...before, ...change }), { code: 'stale_import_operation' });
        assert.deepEqual(await service.store.get(run.runId), before);
      }
      await service.cancel(run.runId);
    });
    await check('source creation finishing after cancellation retains its canonical cancelled owner', async () => {
      const reached = barrier(), release = barrier(); let created;
      const service = new ImportSagaService({ analyzer, staging: { ...staging, createStagingProject: async (...args) => { created = await staging.createStagingProject(...args); reached.release(); await release.promise; return created; } } });
      const pending = service.start({ parsed: { chapters: [{ title: '迟到来源', content: '原始正文' }] } }); await reached.promise;
      const run = (await service.store.listActive()).find((r) => r.state === 'parsed');
      try { assert.equal((await service.cancel(run.runId)).state, 'cancelled'); } finally { release.release(); }
      assert.equal((await pending).state, 'cancelled');
      const owner = await service.get(created.importId); assert.equal(owner.runId, run.runId); assert.equal(owner.state, 'cancelled');
      await assert.rejects(staging.promoteToNovel(created.importId, { dir: path.join(temp, 'forbidden') }));
      assert.equal((await novels.listNovels()).length, 0);
    });
    await check('late createMerge cannot bind a session or submit after cancellation', async () => {
      const target = await novels.createNovel({ dir: path.join(temp, 'late-target'), title: '既有项目' }); const reached = barrier(), release = barrier();
      const service = new ImportSagaService({ analyzer, novels: { ...novels, pathsFor: async (...args) => { const result = await novels.pathsFor(...args); reached.release(); await release.promise; return result; } } });
      const run = await ready(service, { targetNovelId: target.id }); const preparing = service.createMerge(run.runId, target.id); await reached.promise;
      try { assert.equal((await service.cancel(run.runId)).state, 'cancelled'); } finally { release.release(); }
      await assert.rejects(preparing, { code: 'stale_import_operation' });
      const current = await service.get(run.runId); assert.equal(current.state, 'cancelled'); assert.equal(current.mergeSessionId, undefined);
      assert.equal(await fs.access(path.join(target.dir, 'chapters/chapter-001.md')).then(() => true, () => false), false);
    });
    await check('completed merge retries and cancellations preserve later formal edits and the original receipt', async () => {
      const target = await novels.createNovel({ dir: path.join(temp, 'published-target'), title: '已发布项目' }); const service = new ImportSagaService({ analyzer });
      const run = await ready(service, { targetNovelId: target.id }); const session = await service.createMerge(run.runId, target.id);
      for (const item of session.items) await merge.resolveConflict(session.sessionId, item.id, 'left');
      const receipt = await service.finalizeSession(session.sessionId);
      await data.writeChapter(target.dir, 'chapter-001.md', '用户在提交后独立编辑的正文');
      assert.deepEqual(await merge.finalizeMerge(session.sessionId), receipt);
      const cancelled = await service.cancel(run.runId); assert.equal(cancelled.state, 'completed'); assert.deepEqual(cancelled.result.receipt, receipt);
      assert.equal(await data.readChapter(target.dir, 'chapter-001.md'), '用户在提交后独立编辑的正文');
      const durable = await service.store.get(run.runId);
      await assert.rejects(service.store.command(run.runId, 'decideCommit', { id: durable.commitDecision.id, kind: 'promotion', operation: {} }), { code: 'recovery_required' });
      assert.deepEqual(await service.store.get(run.runId), durable);
    });
    await check('overlapping source targets are rejected before copying and can be retargeted safely', async () => {
      const service = new ImportSagaService({ analyzer }); const run = await ready(service); const source = path.join(process.env.MANA_USER_DATA_ROOT, 'import-staging', run.importId);
      const copy = fs.copyFile; let copies = 0;
      fs.copyFile = async (...args) => { if (++copies > 3) throw new Error('audit recursion guard'); return copy(...args); };
      try { await assert.rejects(staging.promoteToNovel(run.importId, { dir: path.join(source, 'nested-target') }), { code: 'invalid_import_target' }); } finally { fs.copyFile = copy; }
      assert.equal(copies, 0); assert.equal((await novels.listNovels()).some((n) => n.dir.startsWith(source + path.sep)), false);
      const saved = await staging.promoteToNovel(run.importId, { dir: path.join(temp, 'safe-retarget') });
      assert.ok(saved.receipt.operationId); assert.ok((await fs.readFile(path.join(saved.dir, 'chapters/chapter-001.md'), 'utf8')).includes('原文事实不能被旧任务覆盖'));
    });
    await check('a direct host AbortSignal is arbitrated as cancellation during preparation', async () => {
      const service = new ImportSagaService({ analyzer }); const run = await ready(service); const target = path.join(temp, 'signal-target');
      const controller = new AbortController(), reached = barrier(), release = barrier(), copy = fs.copyFile;
      fs.copyFile = async (...args) => { const result = await copy(...args); if (String(args[0]).endsWith('chapter-001.md')) { reached.release(); await release.promise; } return result; };
      try {
        const pending = staging.promoteToNovel(run.importId, { dir: target, abortSignal: controller.signal });
        const rejected = assert.rejects(pending, { code: 'cancelled' }); await reached.promise;
        controller.abort();
        const deadline = Date.now() + 3000; while ((await service.get(run.runId)).state !== 'cancelled') { assert.ok(Date.now() < deadline); await new Promise((r) => setTimeout(r, 10)); }
        release.release(); await rejected;
        assert.equal(await fs.access(target).then(() => true, () => false), false);
        assert.equal((await novels.listNovels()).some((n) => n.dir === target), false);
      } finally { release.release(); fs.copyFile = copy; }
    });
    await check('formal execution cannot read an unacknowledged choice that will roll back', async () => {
      const target = await novels.createNovel({ dir: path.join(temp, 'pending-choice'), title: '取舍隔离' });
      const service = new ImportSagaService({ analyzer }); const run = await ready(service, { targetNovelId: target.id }); const session = await service.createMerge(run.runId, target.id);
      const sync = require('node:fs'), read = sync.readFileSync, rename = fs.rename, execute = merge.executeMerge;
      const reached = barrier(), release = barrier(), entered = barrier(); let pending = false, reads = 0, once = true, failed = false;
      fs.rename = async (a, b, ...args) => {
        if (!failed && path.basename(b) === run.runId + '.json') { failed = true; throw Object.assign(new Error('choice authority EIO'), { code: 'EIO' }); }
        const result = await rename(a, b, ...args);
        if (once && path.basename(b) === session.sessionId + '.json') { once = false; pending = true; reached.release(); await release.promise; }
        return result;
      };
      sync.readFileSync = (file, ...args) => { if (pending && path.basename(String(file)) === session.sessionId + '.json') reads++; return read(file, ...args); };
      merge.executeMerge = (...args) => { entered.release(); return execute(...args); };
      let selecting, submitting;
      try {
        selecting = assert.rejects(merge.resolveConflict(session.sessionId, session.items[0].id, 'left'), { code: 'EIO' }); await reached.promise;
        submitting = service.finalize(run.runId); await entered.promise;
        await new Promise((r) => setTimeout(r, 30)); const unacknowledgedReads = reads; pending = false; release.release();
        await selecting; await submitting;
        assert.equal(unacknowledgedReads, 0, 'the executor must recover/serialize choice material before reading it');
        assert.equal(await fs.access(path.join(target.dir, 'chapters/chapter-001.md')).then(() => true, () => false), false);
        assert.equal((await service.get(run.runId)).commitDecision, null);
      } finally { pending = false; release.release(); fs.rename = rename; sync.readFileSync = read; merge.executeMerge = execute; await Promise.allSettled([selecting, submitting].filter(Boolean)); }
    });
    await check('recovery executes the full authoritative merge plan instead of changed checkpoint choices', async () => {
      const target = await novels.createNovel({ dir: path.join(temp, 'plan-authority'), title: '计划权威' }); const service = new ImportSagaService({ analyzer });
      const run = await ready(service, { targetNovelId: target.id }); const session = await service.createMerge(run.runId, target.id);
      for (const item of session.items) await merge.resolveConflict(session.sessionId, item.id, 'left');
      const code = `const fs=require('node:fs/promises');const rename=fs.rename;fs.rename=async(a,b,...x)=>{await rename(a,b,...x);let j;try{j=JSON.parse(await fs.readFile(b,'utf8'))}catch{return}if(j.state==='committed'&&j.entries?.some(e=>{try{const r=JSON.parse(Buffer.from(e.after,'base64'));return r.runId===process.argv[2]&&r.commitDecision?.kind==='merge'}catch{return false}}))process.exit(73)};new(require(process.argv[1]).ImportSagaService)().finalize(process.argv[2]).catch(e=>{console.error(e);process.exitCode=2});`;
      const child = spawn(process.execPath, ['-e', code, path.resolve(__dirname, '../src/main/import/importSaga.js'), run.runId], { stdio: 'ignore' });
      assert.equal(await new Promise((r) => child.on('exit', r)), 73);
      const file = path.join(process.env.MANA_USER_DATA_ROOT, 'import-merge-sessions', session.sessionId + '.json');
      const material = JSON.parse(await fs.readFile(file)); material.items[0].resolvedContent = '不属于已确认计划的内容'; material.items[0].status = 'pending'; material.receipt = { written: 999, planId: 'forged' };
      await fs.writeFile(file, JSON.stringify(material));
      const result = await new ImportSagaService({ analyzer }).resume(run.runId);
      assert.equal(result.state, 'completed'); assert.ok(result.commitDecision.plan.changes.length);
      assert.equal(result.result.receipt.planId, session.sessionId);
      assert.ok((await fs.readFile(path.join(target.dir, 'chapters/chapter-001.md'), 'utf8')).includes('原文事实不能被旧任务覆盖'));
    });
    await check('a registry relocation after review stops the old target instead of redirecting it', async () => {
      const target = await novels.createNovel({ dir: path.join(temp, 'reviewed-target'), title: '原目标' }); const service = new ImportSagaService({ analyzer });
      const run = await ready(service, { targetNovelId: target.id }); const session = await service.createMerge(run.runId, target.id);
      for (const item of session.items) await merge.resolveConflict(session.sessionId, item.id, 'left');
      const elsewhere = path.join(temp, 'relocated-target'); await fs.mkdir(elsewhere); await fs.copyFile(path.join(target.dir, 'novel.json'), path.join(elsewhere, 'novel.json')); await novels.importExistingNovel(elsewhere);
      const result = await service.finalize(run.runId);
      assert.equal(result.error.code, 'recovery_required'); assert.equal(result.commitDecision, null);
      assert.equal((await novels.getNovelById(target.id)).dir, elsewhere);
      for (const root of [target.dir, elsewhere]) assert.equal(await fs.access(path.join(root, 'chapters/chapter-001.md')).then(() => true, () => false), false);
      await service.cancel(run.runId);
    });
    await check('project identity relocation and ordinary metadata saving serialize without inverting commit locks', async () => {
      const target = await novels.createNovel({ dir: path.join(temp, 'identity-target'), title: '原标题' }); const service = new ImportSagaService({ analyzer });
      const run = await ready(service, { targetNovelId: target.id }); const session = await service.createMerge(run.runId, target.id);
      for (const item of session.items) await merge.resolveConflict(session.sessionId, item.id, 'left');
      const elsewhere = path.join(temp, 'identity-destination'); await fs.mkdir(elsewhere); await fs.copyFile(path.join(target.dir, 'novel.json'), path.join(elsewhere, 'novel.json'));
      const reached = barrier(), release = barrier(), rename = fs.rename; let once = true, moved = false;
      fs.rename = async (a, b, ...args) => { const result = await rename(a, b, ...args); if (once && b === path.join(require('node:fs').realpathSync(target.dir), 'chapters/chapter-001.md')) { once = false; reached.release(); await release.promise; } return result; };
      let saving, editing, moving;
      try {
        saving = service.finalize(run.runId); await reached.promise;
        editing = novels.saveNovelMeta(target.id, { title: '并发新标题' }); moving = novels.importExistingNovel(elsewhere).then(() => { moved = true; });
        await new Promise((r) => setTimeout(r, 30)); assert.equal(moved, false, 'the target identity cannot move during its commit');
        release.release(); const [saved] = await Promise.all([saving, editing, moving]);
        assert.equal(saved.state, 'completed'); assert.equal(saved.result.receipt.targetDir, require('node:fs').realpathSync(target.dir));
        assert.equal(JSON.parse(await fs.readFile(path.join(target.dir, 'novel.json'))).title, '并发新标题');
        assert.equal((await novels.getNovelById(target.id)).dir, elsewhere);
      } finally { release.release(); fs.rename = rename; await Promise.allSettled([saving, editing, moving].filter(Boolean)); }
    });
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
    if (oldRoot === undefined) delete process.env.MANA_USER_DATA_ROOT; else process.env.MANA_USER_DATA_ROOT = oldRoot;
    await fs.writeFile(path.resolve(__dirname, '../artifacts/data-import-safety-audit/authority-adversarial-results.json'), JSON.stringify({ timestamp: new Date().toISOString(), cases: results }, null, 2) + '\n');
  }
  process.exitCode = results.some((r) => !r.passed) ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 2; });
