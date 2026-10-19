'use strict';

// Audit counterexamples: assertions describe the current defects, not desired behavior.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const ROOT = path.resolve(__dirname, '../..');

async function main() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'mana-writing-feature-audit-'));
  process.env.MANA_USER_DATA_ROOT = path.join(temp, 'data');
  const data = require(path.join(ROOT, 'src/main/store/novelData'));
  const { readResource, listResources } = require(path.join(ROOT, 'src/main/mcp/novelResources'));
  const { getToolByName } = require(path.join(ROOT, 'src/main/mcp/tools'));
  const { evaluateTaskResult } = require(path.join(ROOT, 'src/main/codex-runtime/taskCompletion'));
  const { recordReview } = require(path.join(ROOT, 'src/main/codex-runtime/reviewLedger'));
  const { taskConstraintsFor } = await import(pathToFileURL(path.join(ROOT, 'src/components/writingTaskConstraints.mjs')));
  const results = { date: '2026-10-18', evidence: 'isolated production functions; no live model or UI', checks: [] };
  const check = async (name, fn) => { const evidence = await fn(); results.checks.push({ name, evidence }); console.log('REPRODUCED ' + name); };
  try {
    const novel = await require(path.join(ROOT, 'src/main/store/novels')).createNovel({ title: '写作功能审计夹具', dir: path.join(temp, 'novel') });
    const ctx = { novel, novelDir: novel.dir };
    await data.writeCharacter(novel.dir, { id: 'lin', name: '林岚', personality: '谨慎', relationships: { su: '互相信任，但尚未告知旧案真相' } });
    await data.writeCharacter(novel.dir, { id: 'su', name: '苏绾', personality: '直率' });
    await data.writeWorld(novel.dir, { lore: '城门每晚九点关闭。', places: [{ name: '北门', description: '只准步行通过' }] });
    await data.writeStyleMemory(novel.dir, '第三人称限知，少用解释。');
    await data.writeCharacterMemory(novel.dir, { characterId: 'lin', factsKnown: [{ id: 'door', summary: '林岚知道城门九点关闭' }], privateMisbeliefs: [{ id: 'su', summary: '误以为苏绾尚未获知旧案' }] });
    for (const [file, body] of [['chapter-001.md', '城门在九点关闭。林岚将钥匙交给苏绾。'], ['chapter-002.md', '十点时城门仍敞开，守门人说今晚从未关门。']]) await data.writeChapterWithMeta(novel.dir, file, body, {}, { baseContent: '' });
    const refs = ['character:lin', 'character-memory:lin', 'world:lore', 'world:places', 'style:memory', 'chapter:chapter-001.md', 'chapter:chapter-002.md'];
    const resources = await Promise.all(refs.map(ref => readResource(novel, ref)));
    const readItem = async ref => ({ id: ref, type: 'mcpToolCall', name: 'read_novel_resource', arguments: { resourceRef: ref }, status: 'completed', result: await getToolByName('read_novel_resource').handler({ resourceRef: ref }, ctx) });
    const report = (covered, issues = []) => '审校报告\n```json\n' + JSON.stringify({ coveredResourceRefs: covered, issues }) + '\n```';

    await check('baseline-canonical-context-readable', async () => {
      const listed = await listResources(novel, { limit: 200 });
      for (const ref of refs) { assert.ok(listed.data.some(item => item.resourceRef === ref)); assert.ok(resources.find(item => item.resourceRef === ref).content); }
      assert.ok(resources[1].content.includes('误以为'));
      return { readable: refs, totalResources: listed.total };
    });
    await check('whole-novel-review-accepts-one-of-two-chapters', async () => {
      const ref = 'chapter:chapter-001.md';
      const text = report([ref]);
      const items = [await readItem(ref)];
      const reviewRecord = await recordReview(novel, { text, items });
      const constraints = taskConstraintsFor('审校全书的人物和世界观一致性', '', {});
      const result = await evaluateTaskResult({ entry: novel, taskConstraints: constraints, items, text, reviewRecord }, true);
      assert.equal(result.goalVerified, true);
      assert.deepEqual(result.evidence.targetResourceRefs, [ref]);
      return { requested: '审校全书的人物和世界观一致性', constraints, actualChapters: 2, acceptedRefs: result.evidence.targetResourceRefs, goalVerified: result.goalVerified };
    });
    await check('review-report-can-omit-a-fully-read-resource', async () => {
      const refs = ['chapter:chapter-001.md', 'chapter:chapter-002.md'];
      const items = await Promise.all(refs.map(readItem));
      const text = report([refs[0]]);
      const reviewRecord = await recordReview(novel, { text, items });
      const result = await evaluateTaskResult({ entry: novel, taskConstraints: { operation: 'review' }, items, text, reviewRecord }, true);
      assert.equal(result.goalVerified, true);
      return { fullyRead: result.evidence.fullyReadResourceRefs, coveredInReport: reviewRecord.coverageClaimed, goalVerified: result.goalVerified };
    });
    await check('invented-quotes-and-locations-marked-verified', async () => {
      const evidence = resources.filter(r => r.kind === 'chapter').map(r => ({ resourceRef: r.resourceRef, hash: r.sourceHash, location: '第99999行', quote: '本书不存在的原文证据' }));
      const text = report(evidence.map(e => e.resourceRef), [{ issueId: 'world:door:state', severity: 'hard', status: 'open', contradiction: '伪造引文声称矛盾', evidence }]);
      const row = await recordReview(novel, { text, items: [] });
      assert.equal(row.issues[0].verified, true);
      return { noReadTools: true, issue: row.issues[0], coverageVerified: row.coverageVerified };
    });
    await check('missing-resource-contract-inconsistent-by-kind', async () => {
      const handler = getToolByName('read_novel_resource').handler;
      const outcomes = [];
      for (const ref of ['chapter:chapter-999.md', 'character:missing', 'character-memory:missing', 'asset:missing', 'outline:chapter:99:99:99']) {
        try { const value = (await handler({ resourceRef: ref }, ctx)).structuredContent; outcomes.push({ ref, exists: value.exists, mode: value.mode, content: value.content }); }
        catch (e) { outcomes.push({ ref, throws: true, code: e.code, message: e.message }); }
      }
      assert.equal(outcomes[0].exists, false);
      assert.equal(outcomes[1].throws, true);
      assert.equal(outcomes[2].mode, 'content');
      return outcomes;
    });
    await check('character-dialog-save-erases-object-relationships', async () => {
      const source = await fs.readFile(path.join(ROOT, 'src/components/CharacterEditDialog.jsx'), 'utf8');
      const component = source.slice(source.indexOf('  const [draft'), source.indexOf('\n  return (', source.indexOf('export function CharacterEditDialog')));
      const splitSource = source.slice(source.indexOf('function splitList'), source.indexOf('\nfunction Field'));
      const before = await data.readCharacter(novel.dir, 'lin');
      const sandbox = { character: before, useState: init => [typeof init === 'function' ? init() : init, () => {}], GENDER_OPTIONS: [], onSave: async value => data.writeCharacter(novel.dir, value) };
      // Execute actual initialization and submit callback; this is not a DOM test.
      await vm.runInNewContext('(async () => { ' + splitSource + '\n' + component + '\nawait submit(); })()', sandbox);
      const after = await data.readCharacter(novel.dir, 'lin');
      assert.deepEqual(after.relationships, []);
      return { before: before.relationships, after: after.relationships, onlyAction: 'open existing character and save unchanged', layer: 'actual component callbacks + formal store readback' };
    });
    await check('character-memory-id-normalization-can-overwrite-other-character', async () => {
      await data.writeCharacter(novel.dir, { id: 'lin+a', name: '林甲' });
      await data.writeCharacter(novel.dir, { id: 'lin_a', name: '林乙' });
      await data.writeCharacterMemory(novel.dir, { characterId: 'lin+a', factsKnown: [{ summary: '甲的记忆' }] });
      await data.writeCharacterMemory(novel.dir, { characterId: 'lin_a', factsKnown: [{ summary: '乙的记忆' }] });
      const one = JSON.parse((await readResource(novel, 'character-memory:lin+a')).content);
      assert.equal(one.characterId, 'lin_a');
      assert.equal(one.factsKnown[0].summary, '乙的记忆');
      return { requested: 'character-memory:lin+a', returnedCharacterId: one.characterId, factsKnown: one.factsKnown };
    });
    await check('natural-language-review-and-roleplay-constraints-unrecognized', async () => {
      return ['帮我检查全文的人物一致性', '对全书进行一致性审查', '进入角色驱动模式，继续写下一章', '写下一章，写完自查人物与世界观冲突'].map(text => ({ text, constraints: taskConstraintsFor(text, '', {}) }));
    });
    await fs.writeFile(path.join(__dirname, 'writing-feature-probe-results.json'), JSON.stringify(results, null, 2) + '\n');
    console.log('writing-feature-probe: ' + results.checks.length + ' checks complete');
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
