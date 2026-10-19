'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const data = require('../src/main/store/novelData');
const plans = require('../src/main/import/resourcePlan');
const updates = require('../src/main/import/characterUpdates');
const reviews = require('../src/main/import/reviewStore');
const identity = require('../src/main/store/entityIdentity');
const web = require('../src/main/import/characterEnricher');
const { ensureNovelLayout } = require('../src/main/store/paths');
const rootPromise = fs.mkdtemp(path.join(os.tmpdir(), 'mana-transaction-review-'));
let passed = 0;
async function test(name, fn) { await fn(); console.log('PASS ' + name); passed++; }
async function resolveAll(root, reviewId, overrides = {}) {
  const review = await reviews.get(root, reviewId);
  await reviews.decide(root, reviewId, Object.fromEntries(review.fields.map((f) => [f.id, overrides[f.id] ?? 0])));
  return reviews.finish(root, reviewId, true);
}
(async () => {
  const root = await rootPromise; process.env.MANA_USER_DATA_ROOT = path.join(root, 'user-data');
  try {
    await test('legacy identity migration and CAS use one logical character and preserve memory', async () => {
      const dir = path.join(root, 'legacy'); ensureNovelLayout(dir);
      await fs.writeFile(path.join(dir, 'characters/a:b.json'), JSON.stringify({ id: 'a:b', name: '旧角色', background: '旧值' }));
      await fs.writeFile(path.join(dir, 'characters/a:b.memory.json'), 'kept');
      const initial = await data.readCharacter(dir, 'a:b');
      await data.writeCharacter(dir, { ...initial, background: '新值' }, { expectedCharacter: initial });
      assert.equal((await data.listCharacters(dir)).length, 1);
      assert.equal((await data.readCharacter(dir, 'a:b')).background, '新值');
      await assert.rejects(fs.access(path.join(dir, 'characters/a:b.json')));
      assert.equal(await fs.readFile(path.join(dir, 'characters/a:b.memory.json'), 'utf8'), 'kept');
      const current = await data.listCharacters(dir);
      const prepared = await updates.saveEnrichment(dir, current, [{ ...current[0], background: '待核对候选', _enrichmentStatus: 'success' }]);
      assert.equal(prepared.written, 0); assert.equal((await data.readCharacter(dir, 'a:b')).background, '新值');
      await resolveAll(dir, prepared.reviewId);
      assert.equal((await data.readCharacter(dir, 'a:b')).background, '待核对候选');
      assert.equal((await data.readCharacter(dir, 'a:b'))._proposedFacts, undefined);
      assert.equal((await data.listCharacters(dir)).length, 1);
      // Identity rejection also rejects a legacy migration as a unit.
      const other = path.join(root, 'reject-legacy'); ensureNovelLayout(other);
      await fs.writeFile(path.join(other, 'characters/a:b.json'), JSON.stringify(initial));
      const rejected = await updates.saveEnrichment(other, [initial], [{ ...initial, background: '禁止保存', _enrichmentStatus: 'success' }]);
      await resolveAll(other, rejected.reviewId, { 'a:b:identity': 'reject' });
      assert.equal((await data.readCharacter(other, 'a:b')).background, '旧值');
      assert.equal((await data.listCharacters(other)).length, 1);
      const wrongFile = path.join(other, 'characters', identity.entityFileName('claimed'));
      await fs.writeFile(wrongFile, JSON.stringify({ id: 'another', name: 'another' }));
      await assert.rejects(data.writeCharacter(other, { id: 'claimed', name: 'claimed' }), { code: 'resource_name_conflict' });
      assert.equal(JSON.parse(await fs.readFile(wrongFile, 'utf8')).id, 'another');
      const legacyEnrich = path.join(root, 'legacy-enrichment-approve'); ensureNovelLayout(legacyEnrich);
      await fs.writeFile(path.join(legacyEnrich, 'characters/a:b.json'), JSON.stringify(initial));
      const preparedLegacy = await updates.saveEnrichment(legacyEnrich, [initial], [{ ...initial, background: '旧路径审阅后提交', _enrichmentStatus: 'success' }]);
      await resolveAll(legacyEnrich, preparedLegacy.reviewId);
      assert.equal((await data.readCharacter(legacyEnrich, 'a:b')).background, '旧路径审阅后提交');
      assert.equal((await data.listCharacters(legacyEnrich)).length, 1);
      await assert.rejects(fs.access(path.join(legacyEnrich, 'characters/a:b.json')));
    });
    await test('ordinary save queues behind batch commit and the later user edit wins', async () => {
      const dir = path.join(root, 'race'); ensureNovelLayout(dir);
      await data.writeCharacter(dir, { id: 'alice', name: '甲', personality: '旧值' });
      const plan = { id: 'race', changes: [{ ...await plans.snapshot(dir, 'characters/alice.json'), after: JSON.stringify({ id: 'alice', name: '甲', personality: '导入值' }) }] };
      let entered, unblock;
      const ready = new Promise((r) => { entered = r; }); const pause = new Promise((r) => { unblock = r; });
      const originalOpen = fs.open; let once = true;
      fs.open = async (file, ...args) => {
        if (once && String(file).includes('/characters/.alice.json.tmp-')) { once = false; entered(); await pause; }
        return originalOpen(file, ...args);
      };
      let userFinished = false;
      const user = (async () => { await ready; await data.writeCharacter(dir, { id: 'alice', name: '甲', personality: '用户新编辑' }); userFinished = true; })();
      try {
        const committing = plans.commitPlan(dir, plan, async () => {});
        await ready; await new Promise((r) => setTimeout(r, 30)); assert.equal(userFinished, false);
        unblock(); await committing; await user;
        assert.equal((await data.readCharacter(dir, 'alice')).personality, '用户新编辑');
        await plans.commitPlan(dir, plan, async () => {});
        assert.equal((await data.readCharacter(dir, 'alice')).personality, '用户新编辑', 'receipt retry must never replay the old write');
      } finally { unblock(); fs.open = originalOpen; }
    });
    await test('rollback owns attempted writes only, even when an untouched file equals proposed bytes', async () => {
      const dir = path.join(root, 'rollback'); ensureNovelLayout(dir);
      await fs.writeFile(path.join(dir, 'a.txt'), 'old-a'); await fs.writeFile(path.join(dir, 'b.txt'), 'old-b');
      const plan = { id: 'failed-first', changes: [{ ...await plans.snapshot(dir, 'a.txt'), after: 'new-a' }, { ...await plans.snapshot(dir, 'b.txt'), after: 'new-b' }] };
      const originalOpen = fs.open; let once = true;
      fs.open = async (file, ...args) => {
        if (once && String(file).includes('/.a.txt.tmp-')) { once = false; await fs.writeFile(path.join(dir, 'b.txt'), 'new-b'); throw new Error('injected first-file failure'); }
        return originalOpen(file, ...args);
      };
      try { await assert.rejects(plans.commitPlan(dir, plan, async () => {}), /first-file failure/); } finally { fs.open = originalOpen; }
      assert.equal(await fs.readFile(path.join(dir, 'a.txt'), 'utf8'), 'old-a');
      assert.equal(await fs.readFile(path.join(dir, 'b.txt'), 'utf8'), 'new-b');
    });
    await test('quote contradiction and related-page mention cannot become accepted facts', async () => {
      const page = '目标角色来自目标作品。她一直保持蓝色短发，从未担任国王。';
      const candidate = web._groundWebInfo({ appearance: '她留着红色长发。', background: '她是世袭国王。', evidence: { appearance: { quote: '她一直保持蓝色短发' }, background: { quote: '从未担任国王' } } }, page);
      assert.equal(candidate.appearance, ''); assert.equal(candidate.background, '');
      assert.equal(web._validateWebInfo('目标角色', '目标作品', {}, { title: '另一个人物', text: '本页介绍别人。相关条目：目标作品、目标角色。' }), false);
    });
    await test('persisted decisions survive a fresh process; unresolved and stale reviews cannot commit', async () => {
      const dir = path.join(root, 'review'); ensureNovelLayout(dir);
      const relative = 'characters/a.json';
      await data.writeCharacter(dir, { id: 'a', name: '甲', age: '18' });
      const review = await reviews.create(dir, { kind: 'analysis', fields: [{ id: 'age', relative, keys: ['age'], candidates: [{ value: '20', sources: [{ quote: '甲二十岁', chunkIndex: 1 }] }, { value: '200' }] }], plan: { changes: [{ ...await plans.snapshot(dir, relative), after: JSON.stringify({ id: 'a', name: '甲', age: null }) }] } });
      await assert.rejects(reviews.finish(dir, review.id, true), { code: 'unresolved_facts' });
      await reviews.decide(dir, review.id, { age: 0 });
      const child = spawn(process.execPath, ['-e', 'const r=require(process.argv[1]);r.get(process.argv[2],process.argv[3]).then(x=>{if(x.decisions.age!==0)process.exit(2);console.log("restored")})', path.resolve('src/main/import/reviewStore.js'), dir, review.id], { stdio: ['ignore', 'pipe', 'pipe'] });
      let output = ''; child.stdout.on('data', (b) => { output += b; });
      assert.equal(await new Promise((resolve) => child.on('exit', resolve)), 0); assert.match(output, /restored/);
      await data.writeCharacter(dir, { id: 'a', name: '甲', age: '21' });
      await assert.rejects(reviews.finish(dir, review.id, true), { code: 'stale_import_review' });
      assert.equal((await data.readCharacter(dir, 'a')).age, '21');
    });
    await test('real process death after rename recovers before any ordinary save and exact-plan retry is idempotent', async () => {
      const dir = path.join(root, 'crash'); ensureNovelLayout(dir);
      await fs.writeFile(path.join(dir, 'a.txt'), 'old-a'); await fs.writeFile(path.join(dir, 'b.txt'), 'old-b');
      const plan = { id: 'crash-plan', changes: [{ ...await plans.snapshot(dir, 'a.txt'), after: 'new-a' }, { ...await plans.snapshot(dir, 'b.txt'), after: 'new-b' }] };
      const child = spawn(process.execPath, ['-e', 'const fs=require("node:fs/promises");const p=require(process.argv[1]);const rename=fs.rename;fs.rename=async(a,b)=>{await rename(a,b);if(require("node:path").basename(b)==="a.txt")process.exit(73)};p.commitPlan(process.argv[2],JSON.parse(process.argv[3]),async()=>{})', path.resolve('src/main/import/resourcePlan.js'), dir, JSON.stringify(plan)], { stdio: 'inherit' });
      assert.equal(await new Promise((resolve) => child.on('exit', resolve)), 73);
      await data.writeCharacter(dir, { id: 'after-crash', name: '恢复后保存' });
      assert.equal(await fs.readFile(path.join(dir, 'a.txt'), 'utf8'), 'old-a'); assert.equal(await fs.readFile(path.join(dir, 'b.txt'), 'utf8'), 'old-b');
      const receipt = await plans.commitPlan(dir, plan, async () => {});
      assert.equal(receipt.written, 2); assert.deepEqual(await plans.commitPlan(dir, plan, async () => {}), receipt);
    });
    await test('binary resources roll back byte-for-byte and concurrent processes serialize domain updates', async () => {
      const dir = path.join(root, 'binary-process'); ensureNovelLayout(dir);
      const storage = require('../src/main/store/projectTransactions');
      const binary = Buffer.from([0, 255, 254, 123, 0, 128]);
      await storage.writeFile(path.join(dir, 'assets/blob.bin'), binary);
      await assert.rejects(storage.transaction(dir, async () => {
        await storage.writeFile(path.join(dir, 'assets/blob.bin'), Buffer.from([1, 2, 3]));
        throw new Error('rollback binary');
      }), /rollback binary/);
      assert.deepEqual(await fs.readFile(path.join(dir, 'assets/blob.bin')), binary);
      const children = Array.from({ length: 3 }, (_, i) => spawn(process.execPath, ['-e', 'const d=require(process.argv[1]);d.appendTimelineEvent(process.argv[2],{id:process.argv[3],title:process.argv[3],event:"event"}).catch(e=>{console.error(e);process.exitCode=1})', path.resolve('src/main/store/novelData.js'), dir, `event-${i}`], { stdio: 'inherit' }));
      assert.deepEqual(await Promise.all(children.map((child) => new Promise((resolve) => child.on('exit', resolve)))), [0, 0, 0]);
      assert.equal((await data.listTimeline(dir)).length, 3);
    });
    await test('rejecting a new entity does not create an unnamed authoritative card; timeline rejections preserve positions', async () => {
      const dir = path.join(root, 'entity-reject'); ensureNovelLayout(dir);
      const changes = [{ ...await plans.snapshot(dir, 'characters/new.json'), after: JSON.stringify({ id: 'new', name: '新角色', _analysisCandidates: { name: [{ value: '新角色' }], age: [{ value: '18' }] } }) },
        { ...await plans.snapshot(dir, 'timeline/events.jsonl'), after: [{ id: 'a', title: 'a' }, { id: 'b', title: 'b' }, { id: 'c', title: 'c' }].map((v) => JSON.stringify(v)).join('\n') }];
      const r = await reviews.create(dir, { kind: 'analysis', fields: reviews.fieldsForChanges(changes), plan: { changes } });
      await resolveAll(dir, r.id, { 'characters/new.json:name': 'reject', 'timeline/events.jsonl:0': 'reject', 'timeline/events.jsonl:1': 'reject' });
      assert.equal((await data.listCharacters(dir)).length, 0);
      assert.deepEqual((await data.listTimeline(dir)).map((e) => e.id), ['c']);
    });
    await test('recovery stops at third-party bytes and never overwrites them or accepts a later save', async () => {
      const dir = path.join(root, 'external-recovery'); ensureNovelLayout(dir);
      await fs.writeFile(path.join(dir, 'a.txt'), 'before');
      const plan = { id: 'external-crash', changes: [{ ...await plans.snapshot(dir, 'a.txt'), after: 'after' }] };
      const child = spawn(process.execPath, ['-e', 'const fs=require("node:fs/promises");const p=require(process.argv[1]);const rename=fs.rename;fs.rename=async(a,b)=>{await rename(a,b);if(require("node:path").basename(b)==="a.txt")process.exit(73)};p.commitPlan(process.argv[2],JSON.parse(process.argv[3]),async()=>{})', path.resolve('src/main/import/resourcePlan.js'), dir, JSON.stringify(plan)], { stdio: 'inherit' });
      assert.equal(await new Promise((resolve) => child.on('exit', resolve)), 73);
      await fs.writeFile(path.join(dir, 'a.txt'), 'external edit');
      await assert.rejects(data.writeCharacter(dir, { id: 'blocked', name: 'blocked' }), { code: 'recovery_required' });
      assert.equal(await fs.readFile(path.join(dir, 'a.txt'), 'utf8'), 'external edit');
      await assert.rejects(fs.access(path.join(dir, 'characters/blocked.json')));
    });
    console.log(`PROJECT_TRANSACTION_REVIEW ${passed}/${passed} passed`);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
})().catch((e) => { console.error(e); process.exitCode = 1; });
