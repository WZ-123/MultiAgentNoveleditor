'use strict';
// Counterexamples against the frozen repair. These are NOT passing acceptance tests.
const fs = require('node:fs/promises');
const syncFs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const project = path.resolve(__dirname, '../..');
const data = require(path.join(project, 'src/main/store/novelData'));
const planApi = require(path.join(project, 'src/main/import/resourcePlan'));
const updates = require(path.join(project, 'src/main/import/characterUpdates'));
const web = require(path.join(project, 'src/main/import/characterEnricher'));
const identity = require(path.join(project, 'src/main/store/entityIdentity'));
const { ensureNovelLayout } = require(path.join(project, 'src/main/store/paths'));

(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mana-import-design-recheck-'));
  process.env.MANA_USER_DATA_ROOT = path.join(root, 'user-data');
  const evidence = {};
  try {
    // Existing old filename + new hash filename creates two cards for one logical identity.
    const legacyRoot = path.join(root, 'legacy'); ensureNovelLayout(legacyRoot);
    await fs.writeFile(path.join(legacyRoot, 'characters', 'a:b.json'), JSON.stringify({ id: 'a:b', name: '旧角色', personality: '旧值' }));
    await data.writeCharacter(legacyRoot, { id: 'a:b', name: '旧角色', personality: '新值' });
    const cards = await data.listCharacters(legacyRoot);
    evidence.legacyIdentityMigration = { id: 'a:b', idsAfterOneUpdate: cards.map((card) => card.id), files: await fs.readdir(path.join(legacyRoot, 'characters')) };
    assert.equal(cards.filter((card) => card.id === 'a:b').length, 2);
    // A user's normal store write occurs after commitPlan's version read but
    // before its atomic rename. Different mutex instances allow lost update.
    const raceRoot = path.join(root, 'race'); ensureNovelLayout(raceRoot);
    await data.writeCharacter(raceRoot, { id: 'alice', name: '甲', personality: '旧值' });
    const relative = 'characters/alice.json';
    const plan = { id: 'race', state: 'prepared', changes: [{ ...await planApi.snapshot(raceRoot, relative), after: JSON.stringify({ id: 'alice', name: '甲', personality: '导入值' }) }] };
    const originalOpen = fs.open;
    let injected = false;
    fs.open = async (file, ...args) => {
      if (!injected && String(file).includes('/characters/.alice.json.tmp-')) {
        injected = true;
        await data.writeCharacter(raceRoot, { id: 'alice', name: '甲', personality: '用户期间新编辑' });
      }
      return originalOpen(file, ...args);
    };
    try {
      const receipt = await planApi.commitPlan(raceRoot, plan, async () => {});
      evidence.unsharedWriteLocks = { userWriteExecuted: injected, finalPersonality: (await data.readCharacter(raceRoot, 'alice')).personality, receiptWritten: receipt.written };
      assert.equal(evidence.unsharedWriteLocks.finalPersonality, '导入值');
    } finally { fs.open = originalOpen; }
    // A quote can exist while asserting exactly the opposite of the proposed field.
    const page = '目标角色来自目标作品。她一直保持蓝色短发，从未担任国王。';
    const grounded = web._groundWebInfo({ appearance: '她留着红色长发。', background: '她是世袭国王。', evidence: { appearance: { quote: '她一直保持蓝色短发' }, background: { quote: '从未担任国王' } } }, page);
    evidence.quoteExistenceIsNotSupport = { page, acceptedAppearance: grounded.appearance, acceptedBackground: grounded.background };
    assert.equal(grounded.appearance, '她留着红色长发。');
    assert.equal(grounded.background, '她是世袭国王。');
    evidence.pageMentionIsNotIdentity = { accepted: web._validateWebInfo('目标角色', '目标作品', { appearance: '另一个人的外貌' }, { title: '另一个人物', text: '本页介绍其他作品的另一个人物。相关条目：目标作品、目标角色。' }) };
    assert.equal(evidence.pageMentionIsNotIdentity.accepted, true);
    // Legacy CAS reads an alias file, but writeCharacter checks only new hash path.
    await fs.unlink(path.join(legacyRoot, 'characters', identity.entityFileName('a:b')));
    const initial = await data.listCharacters(legacyRoot);
    const saved = await updates.saveEnrichment(legacyRoot, initial, [{ ...initial[0], background: '有依据的新背景', _enrichmentStatus: 'success' }], { runId: 'legacy-enrichment' });
    evidence.legacyEnrichmentCas = { written: saved.written, failures: saved.failures };
    assert.equal(saved.written, 0);
    assert.equal(saved.failures.length, 1);
    // On failure the new transaction rolls back items it has never written.
    const rollbackRoot = path.join(root, 'rollback'); await fs.mkdir(rollbackRoot);
    await fs.writeFile(path.join(rollbackRoot, 'a.txt'), 'old-a'); await fs.writeFile(path.join(rollbackRoot, 'b.txt'), 'old-b');
    const rollbackPlan = { id: 'rollback', state: 'prepared', changes: [{ ...await planApi.snapshot(rollbackRoot, 'a.txt'), after: 'new-a' }, { ...await planApi.snapshot(rollbackRoot, 'b.txt'), after: 'new-b' }] };
    let failOnce = true;
    fs.open = async (file, ...args) => {
      if (failOnce && String(file).includes('/.a.txt.tmp-')) {
        failOnce = false;
        await fs.writeFile(path.join(rollbackRoot, 'b.txt'), 'new-b');
        throw Object.assign(new Error('injected first-file failure'), { code: 'EACCES' });
      }
      return originalOpen(file, ...args);
    };
    try { await assert.rejects(planApi.commitPlan(rollbackRoot, rollbackPlan, async () => {}), /first-file failure/); }
    finally { fs.open = originalOpen; }
    evidence.rollbackUnwrittenUserSave = { planWroteB: false, userSavedB: 'new-b', actualB: await fs.readFile(path.join(rollbackRoot, 'b.txt'), 'utf8') };
    assert.equal(evidence.rollbackUnwrittenUserSave.actualB, 'old-b');
    await fs.writeFile(path.join(__dirname, 'design-counterexamples.json'), JSON.stringify({ evidenceType: 'production functions + isolated storage, controlled I/O scheduling', evidence }, null, 2) + '\n');
    console.log(JSON.stringify(evidence, null, 2));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
