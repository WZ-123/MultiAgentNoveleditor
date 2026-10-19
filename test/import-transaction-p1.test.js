'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const reviews = require('../src/main/import/reviewStore');
const plans = require('../src/main/import/resourcePlan');
const data = require('../src/main/store/novelData');
const staging = require('../src/main/import/stagingProject');
const novels = require('../src/main/store/novels');
const { ensureNovelLayout } = require('../src/main/store/paths');
const { ImportSagaService } = require('../src/main/import/importSaga');
const analyzer = { startAnalyses: async () => ({ chunkCount: 1 }), finalizeAnalyses: async () => ({ status: 'complete' }) };
async function ready(target) {
  const saga = new ImportSagaService({ analyzer });
  const run = await saga.start({ parsed: { chapters: [{ title: '事务', content: '完整用户原文' }], metadata: { title: '事务测试' } }, target: { dir: target, title: '事务测试' } });
  await saga.resume(run.runId);
  assert.equal((await saga.resume(run.runId)).state, 'review');
  return { saga, run };
}
async function approve(root, review, rejected) {
  await reviews.decide(root, review.id, Object.fromEntries(review.fields.map((f) => [f.id, rejected(f) ? 'reject' : 0])));
  return reviews.finish(root, review.id, true);
}
async function crash(run, target, boundary) {
  const child = spawn(process.execPath, [path.join(__dirname, 'import-promotion-crash-child.js'), run.runId, run.importId, target, boundary], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = ''; child.stderr.on('data', (b) => { stderr += b; });
  const exit = await new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  if (boundary === 'sigkill-rename') assert.equal(exit.signal, 'SIGKILL', stderr);
  else assert.equal(exit.code, 73, stderr || `fault boundary not reached: ${boundary}`);
}
async function pauseOperation(method, predicate, work) {
  const original = fs[method]; let reached, release;
  const atBoundary = new Promise((resolve) => { reached = resolve; });
  const barrier = new Promise((resolve) => { release = resolve; });
  let once = true;
  fs[method] = async (...args) => { const result = await original(...args); if (once && predicate(...args)) { once = false; reached(); await barrier; } return result; };
  try { return await work(atBoundary, release); } finally { release(); fs[method] = original; }
}
async function run() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'mana-p1-positive-'));
  const previousRoot = process.env.MANA_USER_DATA_ROOT;
  process.env.MANA_USER_DATA_ROOT = path.join(temp, 'user-data');
  const failures = [];
  async function check(name, fn) { try { await fn(); console.log('PASS ' + name); } catch (error) { failures.push({ name, error }); console.error('FAIL ' + name + '\n' + error.stack); } }
  try {
    await check('nested storage scopes keep their own journal when addressed through a parent path alias', async () => {
      const storage = require('../src/main/store/projectTransactions');
      const real = path.join(temp, 'real-parent'), alias = path.join(temp, 'alias-parent');
      await fs.mkdir(real); await fs.symlink(real, alias, 'dir');
      const appRoot = path.join(alias, 'app'), childRoot = path.join(appRoot, 'child');
      await storage.exclusive(appRoot, () => storage.writeFile(path.join(appRoot, 'parent.txt'), 'parent'));
      await storage.transaction(childRoot, async () => {
        await storage.writeFile(path.join(childRoot, 'value.txt'), 'child');
        assert.ok((await fs.readdir(path.join(childRoot, '.mana', 'transactions')).catch((e) => { if (e.code === 'ENOENT') return []; throw e; })).some((name) => name.endsWith('.json')), 'child writes must belong to the active child journal');
      });
    });
    await check('existing timeline rejects retain originals by identity, including reordered and unmentioned events', async () => {
      const root = path.join(temp, 'events'); ensureNovelLayout(root);
      await data.replaceTimeline(root, [{ id: 'a', title: '原有甲', description: '原值甲' }, { id: 'b', title: '原有乙', description: '原值乙' }, { id: 'untouched', title: '未提到的旧事件' }]);
      const before = await data.listTimeline(root);
      const candidates = [{ id: 'b', title: '候选乙' }, { id: 'a', title: '候选甲' }, { id: 'new', title: '确认的新事件' }];
      const changes = [{ ...await plans.snapshot(root, 'timeline/events.jsonl'), after: candidates.map((v) => JSON.stringify(v)).join('\n') + '\n' }];
      const review = await reviews.create(root, { kind: 'analysis', fields: reviews.fieldsForChanges(changes), plan: { changes } });
      await approve(root, review, (f) => f.candidates[0].value.id !== 'new');
      const after = await data.listTimeline(root);
      for (const original of before) assert.deepEqual(after.find((e) => e.id === original.id), original, 'rejection must preserve the full existing event');
      assert.equal(after.find((e) => e.id === 'new').title, '确认的新事件');
      assert.equal((await reviews.get(root, review.id)).state, 'committed');
    });
    await check('existing nested entities reject to original identity and fields; rejected new entities are absent', async () => {
      const root = path.join(temp, 'places'); ensureNovelLayout(root);
      const oldPlaces = [{ id: 'a', name: '旧甲', description: '甲原值', custom: '保留甲' }, { id: 'b', name: '旧乙', description: '乙原值' }, { id: 'untouched', name: '未提到的旧地点' }];
      const world = { schemaVersion: 1, lore: '原有世界', places: oldPlaces };
      await fs.writeFile(path.join(root, 'world/meta.json'), JSON.stringify(world));
      await fs.writeFile(path.join(root, 'world/places.json'), JSON.stringify({ schemaVersion: 1, places: oldPlaces }));
      const candidates = [{ id: 'b', name: '候选乙', description: '乙候选' }, { id: 'new', name: '新地点' }, { id: 'a', name: '旧甲', description: '甲候选' }].map((p) => ({ ...p, _analysisCandidates: { name: [{ value: p.name }], ...(p.description ? { description: [{ value: p.description }] } : {}) } }));
      const changes = [{ ...await plans.snapshot(root, 'world/meta.json'), after: JSON.stringify({ ...world, places: candidates }) }, { ...await plans.snapshot(root, 'world/places.json'), after: JSON.stringify({ places: candidates }) }];
      const review = await reviews.create(root, { kind: 'analysis', fields: reviews.fieldsForChanges(changes), plan: { changes } });
      await approve(root, review, (f) => f.id === 'world/meta.json:places.0.name' || f.id === 'world/meta.json:places.1.name' || f.id === 'world/meta.json:places.2.description');
      const after = JSON.parse(await fs.readFile(path.join(root, 'world/meta.json'))).places;
      for (const original of oldPlaces) assert.deepEqual(after.find((p) => p.id === original.id), original);
      assert.equal(after.some((p) => p.id === 'new'), false);
      assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, 'world/places.json'))).places, after);
    });
    await check('promotion interrupted after target rename resumes the same operation and receipt', async () => {
      const target = path.join(temp, 'crash-target');
      const { run } = await ready(target);
      const code = `const fs=require('node:fs/promises'),rename=fs.rename;fs.rename=async(a,b)=>{await rename(a,b);if(b===process.argv[3])process.exit(73)};new(require(process.argv[1]).ImportSagaService)().finalize(process.argv[2]).catch(e=>{console.error(e);process.exitCode=2});`;
      const child = spawn(process.execPath, ['-e', code, path.resolve(__dirname, '../src/main/import/importSaga.js'), run.runId, target], { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = ''; child.stderr.on('data', (b) => { stderr += b; });
      assert.equal(await new Promise((resolve) => child.on('exit', resolve)), 73, stderr);
      const sourceId = JSON.parse(await fs.readFile(path.join(target, 'novel.json'))).id;
      const fresh = new ImportSagaService();
      const result = await fresh.finalize(run.runId);
      assert.equal(result.state, 'completed', JSON.stringify(result.error));
      assert.equal(result.result.id, sourceId);
      assert.ok(result.result.receipt?.operationId, 'completion must contain a durable promotion receipt');
      assert.equal((await novels.listNovels()).filter((n) => n.dir === target).length, 1);
      assert.equal((await staging.getStagingProject(run.importId)).novelMeta.importMeta.status, 'promoted');
      assert.deepEqual((await fresh.finalize(run.runId)).result, result.result);
      assert.match(await fs.readFile(path.join(target, 'chapters/chapter-001.md'), 'utf8'), /完整用户原文/);
    });
    await check('cancel after commit decision reports the completed project and its receipt', async () => {
      const target = path.join(temp, 'cancel-after'); const { saga, run } = await ready(target);
      await pauseOperation('rename', (_a, b) => b === target, async (atBoundary, release) => {
        const saving = saga.finalize(run.runId); await atBoundary;
        const cancelling = saga.cancel(run.runId); release();
        const [saved, cancelled] = await Promise.all([saving, cancelling]);
        assert.equal(saved.state, 'completed'); assert.equal(cancelled.state, 'completed');
        const durable = await new ImportSagaService().get(run.runId);
        assert.equal(durable.state, 'completed'); assert.ok(durable.result.receipt?.operationId);
        assert.equal(cancelled.result.id, durable.result.id);
        assert.equal((await novels.listNovels()).filter((n) => n.dir === target).length, 1);
      });
    });
    await check('cancel before commit decision creates no formal project and cannot resume', async () => {
      const target = path.join(temp, 'cancel-before'); const { saga, run } = await ready(target);
      await pauseOperation('copyFile', (a) => String(a).endsWith('chapter-001.md'), async (atBoundary, release) => {
        const saving = saga.finalize(run.runId); await atBoundary;
        const cancelling = saga.cancel(run.runId); release();
        const [saved, cancelled] = await Promise.all([saving, cancelling]);
        assert.equal(saved.state, 'cancelled'); assert.equal(cancelled.state, 'cancelled');
        assert.equal(await fs.access(target).then(() => true, () => false), false);
        assert.equal((await novels.listNovels()).some((n) => n.dir === target), false);
        assert.equal((await new ImportSagaService().resume(run.runId)).state, 'cancelled');
      });
    });
    await check('each persisted completion boundary recovers before reads and keeps one project/receipt', async () => {
      for (const boundary of ['registry', 'staging', 'ledger', 'run']) {
        const target = path.join(temp, `boundary-${boundary}`); const { run } = await ready(target);
        await crash(run, target, boundary);
        const projectId = JSON.parse(await fs.readFile(path.join(target, 'novel.json'))).id;
        const fresh = new ImportSagaService();
        const result = await fresh.finalize(run.runId);
        assert.equal(result.state, 'completed', `${boundary}: ${JSON.stringify(result.error)}`);
        assert.equal(result.result.id, projectId);
        assert.ok(result.result.receipt?.operationId);
        // A later storage access must not recover an older uncommitted run over
        // an already reported completion.
        await fresh.store.create({ state: 'staged', importId: `unrelated-${boundary}` });
        assert.equal((await fresh.get(run.runId)).state, 'completed');
        assert.deepEqual((await fresh.finalize(run.runId)).result, result.result);
        assert.equal((await novels.listNovels()).filter((n) => n.dir === target).length, 1);
      }
    });
    await check('interrupted promotion rejects external changes without adopting or overwriting them', async () => {
      const target = path.join(temp, 'external-change'); const { run } = await ready(target);
      await crash(run, target, 'rename');
      const chapter = path.join(target, 'chapters/chapter-001.md'); await fs.writeFile(chapter, '外部用户的新编辑');
      const result = await new ImportSagaService().finalize(run.runId);
      assert.equal(result.error?.code, 'recovery_required');
      assert.equal(await fs.readFile(chapter, 'utf8'), '外部用户的新编辑');
      assert.equal((await novels.listNovels()).some((n) => n.dir === target), false);
    });
    await check('separate service instances serialize finalization and return the same receipt', async () => {
      const target = path.join(temp, 'concurrent'); const { run } = await ready(target);
      const results = await Promise.all([new ImportSagaService().finalize(run.runId), new ImportSagaService().finalize(run.runId)]);
      assert.equal(results[0].state, 'completed'); assert.deepEqual(results[0].result, results[1].result);
      assert.equal((await novels.listNovels()).filter((n) => n.dir === target).length, 1);
    });
    await check('rejecting world facts preserves the original Markdown bytes as well as structured data', async () => {
      const root = path.join(temp, 'world-reject'); ensureNovelLayout(root);
      const world = { lore: '结构化旧摘要', places: [] };
      const markdown = '# 用户手工排版\n\n原有全文，含额外细节。\n';
      await fs.writeFile(path.join(root, 'world/meta.json'), JSON.stringify(world));
      await fs.writeFile(path.join(root, 'world/lore.md'), markdown);
      const changes = [{ ...await plans.snapshot(root, 'world/meta.json'), after: JSON.stringify({ ...world, lore: '候选事实', _analysisCandidates: { lore: [{ value: '候选事实' }] } }) }, { ...await plans.snapshot(root, 'world/lore.md'), after: '候选事实' }];
      const review = await reviews.create(root, { kind: 'analysis', fields: reviews.fieldsForChanges(changes), plan: { changes } });
      await approve(root, review, () => true);
      assert.equal(await fs.readFile(path.join(root, 'world/lore.md'), 'utf8'), markdown);
    });
    await check('cross-process cancellation before decision is durable and repeatable', async () => {
      const target = path.join(temp, 'cross-process-cancel'); const { saga, run } = await ready(target);
      await pauseOperation('copyFile', (a) => String(a).endsWith('chapter-001.md'), async (boundary, release) => {
        const saving = saga.finalize(run.runId); await boundary;
        const child = spawn(process.execPath, ['-e', 'new(require(process.argv[1]).ImportSagaService)().cancel(process.argv[2]).then(r=>{if(r.state!=="cancelled")throw new Error(r.state)}).catch(e=>{console.error(e);process.exitCode=1})', path.resolve(__dirname, '../src/main/import/importSaga.js'), run.runId], { stdio: ['ignore', 'ignore', 'pipe'] });
        const request = path.join(process.env.MANA_USER_DATA_ROOT, 'import-promotion-requests', run.importId, 'cancel.json');
        const deadline = Date.now() + 5000;
        while (!await fs.access(request).then(() => true, () => false)) { if (Date.now() > deadline) throw new Error('cross-process cancel request missing'); await new Promise((r) => setTimeout(r, 20)); }
        release(); assert.equal((await saving).state, 'cancelled');
        assert.equal(await new Promise((resolve) => child.on('exit', resolve)), 0);
        assert.equal((await new ImportSagaService().cancel(run.runId)).state, 'cancelled');
        assert.equal(await fs.access(target).then(() => true, () => false), false);
      });
    });
    await check('interruption during ownership bootstrap recovers its journal before preparing again', async () => {
      const target = path.join(temp, 'owner-bootstrap'); const { run } = await ready(target);
      await crash(run, target, 'owner-intent');
      const result = await new ImportSagaService().finalize(run.runId);
      assert.equal(result.state, 'completed', JSON.stringify(result.error));
      assert.equal((await novels.listNovels()).filter((n) => n.dir === target).length, 1);
    });
    await check('callbacks outliving a lease or transaction cannot inherit expired lock ownership', async () => {
      const storage = require('../src/main/store/projectTransactions');
      for (const method of ['exclusive', 'transaction']) {
        const root = path.join(temp, `expired-${method}`); ensureNovelLayout(root);
        let startLate, late, entered, release, admitted = false;
        const trigger = new Promise((r) => { startLate = r; });
        const ready = new Promise((r) => { entered = r; }); const barrier = new Promise((r) => { release = r; });
        await storage[method](root, async () => { late = (async () => { await trigger; await storage.transaction(root, async () => { admitted = true; }); })(); });
        const owner = storage.transaction(root, async () => { entered(); await barrier; });
        await ready; startLate();
        try { await new Promise((r) => setTimeout(r, 30)); assert.equal(admitted, false, `${method} ownership must expire`); }
        finally { release(); await Promise.all([owner, late]); }
        assert.equal(admitted, true);
      }
    });
    await check('recovery never redirects a registry identity that now belongs to a different directory', async () => {
      const target = path.join(temp, 'moved-registry-target'); const { run } = await ready(target);
      await crash(run, target, 'rename');
      const metadata = JSON.parse(await fs.readFile(path.join(target, 'novel.json')));
      const other = path.join(temp, 'user-moved-project'); ensureNovelLayout(other);
      await fs.writeFile(path.join(other, 'novel.json'), JSON.stringify(metadata));
      await novels.importExistingNovel(other);
      const result = await new ImportSagaService().finalize(run.runId);
      assert.equal(result.error?.code, 'recovery_required');
      assert.equal((await novels.listNovels()).find((n) => n.id === metadata.id).dir, other);
    });
    await check('a durable promotion decision reserves its target across process death', async () => {
      const target = path.join(temp, 'reserved-target'); const first = await ready(target);
      await crash(first.run, target, 'decision');
      const second = await ready(target);
      const competing = await second.saga.finalize(second.run.runId);
      assert.equal(competing.error?.code, 'resource_name_conflict', 'another import cannot take the committed target');
      const resumed = await new ImportSagaService().finalize(first.run.runId);
      assert.equal(resumed.state, 'completed', JSON.stringify(resumed.error));
      assert.equal((await novels.listNovels()).find((n) => n.dir === target).id, resumed.result.id);
    });
    await check('corrupt promotion records stop recovery without replacing the record or creating a project', async () => {
      const target = path.join(temp, 'corrupt-ledger'); const { run } = await ready(target);
      await crash(run, target, 'decision');
      const ledger = path.join(process.env.MANA_USER_DATA_ROOT, 'import-promotions', run.importId, 'state.json');
      await fs.writeFile(ledger, '损坏的事务记录');
      await assert.rejects(new ImportSagaService().finalize(run.runId), { code: 'recovery_required' });
      assert.equal(await fs.readFile(ledger, 'utf8'), '损坏的事务记录');
      assert.equal(await fs.access(target).then(() => true, () => false), false);
    });
    await check('different promotions preserve both registry entries; committed replay preserves later edits', async () => {
      const first = await ready(path.join(temp, 'parallel-a')), second = await ready(path.join(temp, 'parallel-b'));
      const [a, b] = await Promise.all([first.saga.finalize(first.run.runId), second.saga.finalize(second.run.runId)]);
      assert.equal(a.state, 'completed'); assert.equal(b.state, 'completed');
      const entries = await novels.listNovels();
      assert.ok(entries.some((n) => n.id === a.result.id)); assert.ok(entries.some((n) => n.id === b.result.id));
      const chapter = path.join(a.result.dir, 'chapters/chapter-001.md');
      await data.writeChapter(a.result.dir, 'chapter-001.md', '提交后的用户新编辑');
      assert.deepEqual(await staging.promoteToNovel(first.run.importId, { dir: a.result.dir }), a.result);
      assert.equal(await fs.readFile(chapter, 'utf8'), '提交后的用户新编辑');
    });
    await check('SIGKILL after rename recovers durable ownership after stale process locks expire', async () => {
      const target = path.join(temp, 'sigkill-target'); const { run } = await ready(target);
      await crash(run, target, 'sigkill-rename');
      const result = await new ImportSagaService().finalize(run.runId);
      assert.equal(result.state, 'completed', JSON.stringify(result.error));
      assert.ok(result.result.receipt?.operationId);
      assert.equal((await novels.listNovels()).filter((n) => n.dir === target).length, 1);
    });
    await check('recovery after formal registration keeps later user edits and completes the original receipt', async () => {
      const target = path.join(temp, 'registered-and-edited'); const { run } = await ready(target);
      await crash(run, target, 'registered');
      assert.ok((await novels.listNovels()).some((n) => n.dir === target));
      await data.writeChapter(target, 'chapter-001.md', '正式登记后用户编辑的新正文');
      const result = await new ImportSagaService().finalize(run.runId);
      assert.equal(result.state, 'completed', JSON.stringify(result.error));
      assert.equal(await fs.readFile(path.join(target, 'chapters/chapter-001.md'), 'utf8'), '正式登记后用户编辑的新正文');
      assert.ok(result.result.receipt?.operationId);
    });
    await check('schema 1 pending decisions bind to saved originals after a fresh process restart', async () => {
      const root = path.join(temp, 'legacy-review'); ensureNovelLayout(root);
      await data.replaceTimeline(root, [{ id: 'legacy-event', description: '旧版原事件' }]);
      const before = await data.listTimeline(root);
      const changes = [{ ...await plans.snapshot(root, 'timeline/events.jsonl'), after: JSON.stringify({ id: 'legacy-event', description: '未确认候选' }) + '\n' }];
      const review = await reviews.create(root, { kind: 'analysis', fields: reviews.fieldsForChanges(changes), plan: { changes } });
      await reviews.decide(root, review.id, { [review.fields[0].id]: 'reject' });
      const stored = await reviews.get(root, review.id); stored.schemaVersion = 1;
      for (const field of stored.fields) { delete field.binding; delete field.originalValue; delete field.hasOriginalValue; }
      await require('../src/main/store/jsonStore').writeJson(path.join(root, '.mana/reviews', review.id + '.json'), stored);
      const child = spawn(process.execPath, ['-e', 'require(process.argv[1]).finish(process.argv[2],process.argv[3],true).catch(e=>{console.error(e);process.exitCode=1})', path.resolve(__dirname, '../src/main/import/reviewStore.js'), root, review.id], { stdio: 'inherit' });
      assert.equal(await new Promise((r) => child.on('exit', r)), 0);
      assert.deepEqual(await data.listTimeline(root), before);
    });
    await check('cancellation between target reservation and commit decision wins before publication', async () => {
      const target = path.join(temp, 'cancel-at-reservation'); const { saga, run } = await ready(target);
      await pauseOperation('rename', (_a, b) => String(b).endsWith('/reservation.json'), async (boundary, release) => {
        const saving = saga.finalize(run.runId); await boundary;
        const cancelling = saga.cancel(run.runId);
        try {
        const request = path.join(process.env.MANA_USER_DATA_ROOT, 'import-promotion-requests', run.importId, 'cancel.json');
        const deadline = Date.now() + 5000;
        while (!await fs.access(request).then(() => true, () => false)) { if (Date.now() > deadline) throw new Error('cancel request did not persist'); await new Promise((r) => setTimeout(r, 20)); }
        release(); const [saved, cancelled] = await Promise.all([saving, cancelling]);
        assert.equal(saved.state, 'cancelled'); assert.equal(cancelled.state, 'cancelled');
        assert.equal(await fs.access(target).then(() => true, () => false), false);
        } finally { release(); await Promise.allSettled([saving, cancelling]); }
      });
    });
  } finally {
    if (previousRoot === undefined) delete process.env.MANA_USER_DATA_ROOT; else process.env.MANA_USER_DATA_ROOT = previousRoot;
    await fs.rm(temp, { recursive: true, force: true });
  }
  if (failures.length) throw new AggregateError(failures.map((f) => f.error), failures.map((f) => f.name).join('; '));
}
if (require.main === module) run().catch((error) => { console.error(error); process.exitCode = 1; });
module.exports = { run };
