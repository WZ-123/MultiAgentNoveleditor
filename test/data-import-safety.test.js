'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const Module = require('node:module');
const root = require('node:fs').mkdtempSync(path.join(os.tmpdir(), 'mana-data-import-safety-'));
process.env.MANA_USER_DATA_ROOT = path.join(root, 'user-data');
const handlers = new Map();
let capturedRequests = [];
let mode = 'complete', active = 0, peak = 0, contextObserved = false, searchCalls = 0;
const outputs = {
  characters: [{ id: 'same', name: '甲', age: '18', evidence: '甲十八岁' }, { id: 'same', name: '乙' }],
  factions: [{ name: '远方同盟', goals: '守护' }], timeline: [{ title: '开门', event: '甲推开门', evidence: '甲推开门' }],
  world: { timeSetting: '纪元十年', location: '河谷', society: '城邦', rules: '不可飞行', isFanwork: true, referencedWorks: ['测试原作'], places: [{ name: '河谷', type: '区域', description: '河岸' }] },
  outline: '## 故事梗概\n\n甲推开门。', style: '## 叙述视角\n\n第三人称。',
};
function taskFor(text) {
  if (text.includes('以下小说文本中出现了哪些角色')) return 'characters';
  if (text.includes('以下小说文本中出现了哪些势力')) return 'factions';
  if (text.includes('以下小说文本中发生了哪些重要事件')) return 'timeline';
  if (text.includes('分析以下小说的世界观')) return 'world';
  if (text.includes('从以下小说文本中提取剧情大纲')) return 'outline';
  if (text.includes('分析以下小说的写作风格')) return 'style';
  return 'web';
}
const provider = { sendMessage: async ({ messages, abortSignal }) => {
  active++; peak = Math.max(peak, active);
  try {
    await new Promise((resolve) => setTimeout(resolve, 2));
    if (abortSignal?.aborted) throw abortSignal.reason;
    const text = messages[0].content[0].text, task = taskFor(text);
    capturedRequests.push(text);
    if (text.includes('前面章节已出现的角色：甲')) contextObserved = true;
    if (mode === 'failed') throw new Error('fixture provider failed');
    let output = outputs[task];
    if (task === 'web') output = { appearance: '蓝发，绿眼，身高160cm', hairColor: '蓝发', eyeColor: '绿眼', height: '160cm', personality: '认真严谨且乐于帮助别人，总是在别人遇到困难时主动伸出援手，坚守自己的信念', evidence: {} };
    if (mode === 'long-web' && task === 'web') output.background = text.includes('末页背景原文') ? '末页背景原文' : '';
    if (mode === 'truncated' && task === 'characters') return { content: [{ type: 'text', text: '[{"id":"x","name":"可恢复"},{"id":"' }] };
    if (mode === 'partial' && task === 'world') throw new Error('world task failed');
    return { content: [{ type: 'text', text: typeof output === 'string' ? output : JSON.stringify(output) }] };
  } finally { active--; }
} };
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'electron') return { ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) }, webContents: { getAllWebContents: () => [] } };
  if (request.endsWith('/nativeProvider')) return { createNativeCodexProvider: async () => ({ provider, tier: 'fixture' }) };
  if (parent?.filename.endsWith('characterEnricher.js') && request === './culturalSphere') return { detectSphere: async () => ({ sphere: 'global', label: 'fixture', source: 'fixture' }), searchLanguage: () => 'zh' };
  if (parent?.filename.endsWith('characterEnricher.js') && request === './searchEngine') return {
    searchCharacter: async ({ charName }) => { searchCalls++; if (charName === '失败者') throw new Error('search failed'); return { results: [{ source: 'fixture', title: charName }], errors: [], sourceDetails: [] }; },
    fetchBestPage: async (results) => ({ title: results[0].title, source: 'fixture', url: 'https://example.invalid/测试原作', text: `${results[0].title} 测试原作 蓝发，绿眼，身高160cm 认真严谨且乐于帮助别人，总是在别人遇到困难时主动伸出援手，坚守自己的信念。`.repeat(8) + (mode === 'long-web' ? '资料段落。'.repeat(6000) + '末页背景原文' : '') }),
    fetchWebPage: async () => ({ ok: false }), sourcePriority: () => [],
  };
  return originalLoad.call(this, request, parent, isMain);
};
const data = require('../src/main/store/novelData');
const novels = require('../src/main/store/novels');
const staging = require('../src/main/import/stagingProject');
const analyzer = require('../src/main/import/analyzer');
const updates = require('../src/main/import/characterUpdates');
const reviews = require('../src/main/import/reviewStore');
async function approveFacts(root, reviewId) {
  const review = await reviews.get(root, reviewId);
  await reviews.decide(root, reviewId, Object.fromEntries(review.fields.map((f) => [f.id, 0])));
  return reviews.finish(root, reviewId, true);
}
const identity = require('../src/main/store/entityIdentity');
const plans = require('../src/main/import/resourcePlan');
const offline = require('../src/main/store/offlineLog');
const merger = require('../src/main/import/resultMerger');
const enricher = require('../src/main/import/characterEnricher');
const { ImportSagaService } = require('../src/main/import/importSaga');
require('../src/main/ipc/novel').registerNovelIpc();
require('../src/main/ipc/import').registerImportIpc();
require('../src/main/ipc/offlineLog').registerOfflineLogIpc();
async function invoke(channel, payload) {
  const result = await handlers.get(`mana:${channel}`)({}, payload);
  if (!result.ok) throw Object.assign(new Error(result.error), { code: result.errorCode });
  return result.value;
}
let total = 0;
async function test(name, fn) { await fn(); total++; console.log(`PASS ${name}`); }
async function write(file, content) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, content); }
async function stage(text = '甲推开门。'.repeat(30)) { const result = await staging.createStagingProject({ chapters: [{ title: '起点', content: text }], metadata: { title: '安全测试' } }); return { ...result, dir: path.join(process.env.MANA_USER_DATA_ROOT, 'import-staging', result.importId) }; }
(async () => {
  const novel = await novels.createNovel({ title: '隔离项目', dir: path.join(root, 'novel') });
  await test('bounded chunks preserve all bytes, including oversized paragraphs and emoji', async () => {
    const source = '文'.repeat(100000) + '😀'.repeat(20) + '\n\n尾';
    const chunks = merger.splitIntoChunks(source, 40000);
    assert.equal(chunks.map((chunk) => chunk.text).join(''), source);
    assert.ok(chunks.every((chunk) => chunk.text.length <= 40000));
    assert.throws(() => merger.splitIntoChunks('x', 0));
  });
  await test('identity rejects traversal/symlinks/collisions and preserves special identities', async () => {
    assert.throws(() => data.normalizeCharacter({ id: '../../probe-target', name: '危险' }));
    await assert.rejects(data.readCharacter(novel.dir, '../../probe-target'));
    for (const id of ['a:b', 'a?b', '中文名', 'index']) await data.writeCharacter(novel.dir, { id, name: id });
    for (const id of ['a:b', 'a?b', '中文名', 'index']) assert.equal((await data.readCharacter(novel.dir, id)).id, id);
    await data.writeCharacter(novel.dir, { id: 'Alice', name: 'Alice' });
    await assert.rejects(data.writeCharacter(novel.dir, { id: 'alice', name: '另一个' }), /collides/);
    const outside = path.join(root, 'outside'); await fs.mkdir(outside);
    const linked = path.join(root, 'linked-novel'); await fs.mkdir(linked);
    await fs.symlink(outside, path.join(linked, 'characters'));
    await assert.rejects(data.writeCharacter(linked, { id: 'x', name: 'x' }), /symlink/);
    assert.notEqual(identity.entityFileName('a:b'), identity.entityFileName('a?b'));
    assert.deepEqual(identity.assignEntityIds([{ id: 'same', name: '一' }, { id: 'same', name: '二' }]).map((c) => c.id), ['same', 'same-2']);
  });
  await test('production offline IPC acknowledges saved content without replay; legacy/unsupported stay pending', async () => {
    await invoke('networkStatus:set', { status: 'offline' });
    const body = '正文'.repeat(1000), style = '文风'.repeat(1000);
    await invoke('novel:saveChapter', { id: novel.id, name: 'chapter-001.md', content: body, options: { createRevision: false } });
    await invoke('novel:writeStyleMemory', { id: novel.id, text: style });
    const entries = await offline.listUnsyncedEntries(novel.id);
    assert.equal(entries[0].payload.content, body); assert.equal(entries[1].payload.text, style);
    await data.writeChapterWithMeta(novel.dir, 'chapter-001.md', '用户后来编辑', {});
    for (const entry of entries) { const receipt = await invoke('offlineLog:syncEntry', { novelId: novel.id, entryId: entry.id }); assert.equal(receipt.status, 'already_saved_locally'); }
    assert.equal(await data.readChapter(novel.dir, 'chapter-001.md'), '用户后来编辑');
    assert.equal(await data.readStyleMemory(novel.dir), style);
    const bad = await offline.appendEntry({ novelId: novel.id, type: 'outline', action: 'replace', payload: {} });
    await assert.rejects(offline.syncEntry(novel.id, bad.id), /unsupported/);
    await assert.rejects(offline.markSynced([bad.id]), /receipt/);
    await assert.rejects(offline.syncEntry('other', bad.id), /another novel/);
    assert.ok((await offline.listUnsyncedEntries(novel.id)).some((e) => e.id === bad.id));
    const { hash } = require('../src/main/codex-runtime/contracts');
    const pending = await offline.appendEntry({ novelId: novel.id, type: 'style', action: 'update', change: { resourceRef: 'style:memory', mode: 'replace', baseHash: hash(style), content: '待提交全文' } });
    const receipt = await offline.syncEntry(novel.id, pending.id);
    assert.equal(receipt.status, 'committed'); assert.equal(await data.readStyleMemory(novel.dir), '待提交全文');
    await data.writeStyleMemory(novel.dir, '再次编辑');
    assert.deepEqual(await offline.syncEntry(novel.id, pending.id), receipt);
    assert.equal(await data.readStyleMemory(novel.dir), '再次编辑');
    await invoke('networkStatus:set', { status: 'online' });
  });
  await test('pending offline writes share the project transaction with normal saves and retain durable receipts', async () => {
    const target = await novels.createNovel({ dir: path.join(root, 'offline-shared') });
    const { hash } = require('../src/main/codex-runtime/contracts');
    await data.writeStyleMemory(target.dir, '旧文风');
    const entry = await offline.appendEntry({ novelId: target.id, type: 'style', change: { resourceRef: 'style:memory', mode: 'replace', baseHash: hash('旧文风'), content: '离线候选' } });
    let ready, release; const entered = new Promise((r) => { ready = r; }), pause = new Promise((r) => { release = r; });
    const originalOpen = fs.open; let once = true, userSaved = false;
    fs.open = async (file, ...args) => { if (once && String(file).includes('/style/.memory.md.tmp-')) { once = false; ready(); await pause; } return originalOpen(file, ...args); };
    const user = (async () => { await entered; await data.writeStyleMemory(target.dir, '用户新编辑'); userSaved = true; })();
    try {
      const committing = offline.syncEntry(target.id, entry.id);
      await entered; await new Promise((r) => setTimeout(r, 30)); assert.equal(userSaved, false);
      release(); const receipt = await committing; await user;
      assert.equal(await data.readStyleMemory(target.dir), '用户新编辑');
      assert.deepEqual(await offline.syncEntry(target.id, entry.id), receipt);
      assert.equal(await data.readStyleMemory(target.dir), '用户新编辑');
    } finally { release(); fs.open = originalOpen; }
    const { readResource } = require('../src/main/mcp/novelResources');
    await data.writeCharacter(target.dir, { id: 'offline-char', name: '离线角色' });
    const current = await readResource(target, 'character:offline-char');
    const deletion = await offline.appendEntry({ novelId: target.id, type: 'character', action: 'delete', change: { resourceRef: 'character:offline-char', mode: 'delete', baseHash: current.sourceHash } });
    await offline.syncEntry(target.id, deletion.id); assert.equal(await data.readCharacter(target.dir, 'offline-char'), null);
  });
  await test('regeneration failure/empty/invalid retains cards, index and memory; approval binds version', async () => {
    const target = await novels.createNovel({ dir: path.join(root, 'regenerate'), title: '重建' });
    await data.writeCharacter(target.dir, { id: 'old', name: '甲', personality: '原值' });
    await data.writeCharacter(target.dir, { id: 'other', name: '旧乙' });
    const memory = path.join(target.dir, 'characters', 'old.memory.json'); await write(memory, '{"characterId":"old","kept":true}');
    const before = await fs.readFile(path.join(target.dir, '.mana', 'characters-index.json'), 'utf8');
    for (const extract of [async () => { throw new Error('model failed'); }, async () => [], async () => [{ id: '../../x', name: '坏' }]]) await assert.rejects(updates.prepareRegeneration(target.dir, extract, '文本'));
    assert.equal((await data.listCharacters(target.dir)).length, 2);
    assert.equal(await fs.readFile(path.join(target.dir, '.mana', 'characters-index.json'), 'utf8'), before);
    const review = await updates.prepareRegeneration(target.dir, async () => [{ id: 'model', name: '甲' }, { id: 'dup', name: '丙' }, { id: 'dup', name: '丁' }], '文本');
    assert.equal((await data.listCharacters(target.dir)).length, 2, 'prepare never writes official cards');
    await data.writeCharacter(target.dir, { id: 'old', name: '甲', personality: '用户新编辑' });
    await assert.rejects(updates.commitRegeneration(target.dir, review.reviewId, true), /审阅后资源已变化/);
    assert.equal((await data.readCharacter(target.dir, 'old')).personality, '用户新编辑');
    const rejected = await updates.prepareRegeneration(target.dir, async () => [{ id: 'model', name: '甲' }], '文本');
    await updates.commitRegeneration(target.dir, rejected.reviewId, false);
    await assert.rejects(updates.commitRegeneration(target.dir, rejected.reviewId, true), /cancelled/);
    const approved = await updates.prepareRegeneration(target.dir, async () => [{ id: 'model', name: '甲' }, { id: 'dup', name: '丙' }, { id: 'dup', name: '丁' }], '文本');
    const result = await updates.commitRegeneration(target.dir, approved.reviewId, true);
    assert.equal(result.characters, 3); assert.ok(result.receipt.resources.length >= 3);
    assert.equal((await data.readCharacter(target.dir, 'old')).name, '甲');
    assert.ok((await fs.readFile(memory, 'utf8')).includes('kept'));
    assert.equal((await data.readCharacterIndex(target.dir)).characters.length, 3);
    assert.deepEqual((await updates.commitRegeneration(target.dir, approved.reviewId, true)).receipt, result.receipt);
  });
  await test('analysis entry bounds total concurrency, uses previous chunks, preserves world and duplicate IDs through promotion', async () => {
    mode = 'complete'; peak = 0;
    const staged = await stage('甲推开门。'.repeat(18000));
    await analyzer.startAnalyses(staged.dir); const result = await analyzer.finalizeAnalyses(staged.dir);
    assert.equal(result.reviewState, 'review');
    assert.equal((await data.listCharacters(staged.dir)).length, 0, 'candidate facts cannot be official before review');
    await assert.rejects(reviews.finish(staged.dir, result.reviewId, true), { code: 'unresolved_facts' });
    await approveFacts(staged.dir, result.reviewId);
    assert.ok(peak <= 3); assert.ok(contextObserved);
    const cards = await data.listCharacters(staged.dir); assert.equal(cards.length, 2); assert.equal(new Set(cards.map((c) => c.id)).size, 2);
    const world = await data.readWorld(staged.dir); for (const word of ['纪元十年', '河谷', '城邦', '不可飞行']) assert.ok(world.lore.includes(word));
    const meta = await data.readWorldMeta(staged.dir); assert.equal(meta.isFanwork, true); assert.deepEqual(meta.referencedWorks, ['测试原作']);
    const promoted = await staging.promoteToNovel(staged.importId, { dir: path.join(root, 'promoted') });
    assert.deepEqual(await data.readWorld(promoted.dir), world); assert.deepEqual(await data.readWorldMeta(promoted.dir), meta);
    const manifest = JSON.parse(await fs.readFile(path.join(promoted.dir, '.mana', 'import-manifest.json'), 'utf8'));
    assert.ok(manifest.resources.some((item) => item.path === 'world/meta.json'));
  });
  await test('long source hints are not truncated; checkpoint identity and reviewed source versions include them', async () => {
    const staged = await stage();
    const hints = path.join(staged.dir, 'sources/analysis-hints.md');
    await write(hints, '原始设定。'.repeat(9000) + '旧线索末尾');
    await analyzer.startAnalyses(staged.dir);
    const progressFile = path.join(staged.dir, '.mana/analysis-progress.json');
    const deadline = Date.now() + 10000;
    while (true) {
      const checkpoint = await fs.readFile(progressFile, 'utf8').then(JSON.parse, () => null);
      if (checkpoint?.chunks?.length >= 2 && checkpoint.chunks.every((c) => c.length === 6)) break;
      if (Date.now() > deadline) throw new Error('initial source checkpoint missing');
      await new Promise((r) => setTimeout(r, 10));
    }
    capturedRequests = [];
    await write(hints, '原始设定。'.repeat(9000) + '新线索末尾');
    await analyzer.startAnalyses(staged.dir);
    const result = await analyzer.finalizeAnalyses(staged.dir);
    assert.ok(capturedRequests.some((text) => text.includes('新线索末尾')), 'changed hints must invalidate complete old chunk results');
    assert.ok(capturedRequests.every((text) => text.length <= 60000));
    assert.ok((await fs.readFile(path.join(staged.dir, '.mana/analysis-source.txt'), 'utf8')).includes('新线索末尾'));
    await write(hints, '审阅期间再次编辑');
    const review = await reviews.get(staged.dir, result.reviewId);
    await reviews.decide(staged.dir, review.id, Object.fromEntries(review.fields.map((f) => [f.id, 0])));
    await assert.rejects(reviews.finish(staged.dir, review.id, true), { code: 'stale_import_review' });
    assert.equal((await data.listCharacters(staged.dir)).length, 0);
  });
  await test('all failure never writes empty success; truncated JSON stays partial and keeps original domain', async () => {
    const staged = await stage('长'.repeat(100000));
    await write(path.join(staged.dir, 'world/lore.md'), '旧世界');
    mode = 'failed'; await analyzer.startAnalyses(staged.dir); await assert.rejects(analyzer.finalizeAnalyses(staged.dir), /全部失败/);
    assert.equal((await data.readWorld(staged.dir)).lore, '旧世界');
    mode = 'truncated'; await analyzer.startAnalyses(staged.dir); const partial = await analyzer.finalizeAnalyses(staged.dir);
    assert.equal(partial.status, 'partial'); assert.equal(partial.domains.find((d) => d.taskId === 'characters').status, 'partial');
    const recovery = JSON.parse(await fs.readFile(path.join(staged.dir, partial.recoveryFile), 'utf8'));
    assert.ok(recovery.results.some((r) => r.taskId === 'characters' && r.value?.[0]?.name === '可恢复'));
    assert.equal((await data.listCharacters(staged.dir)).length, 0);
    mode = 'complete';
  });
  await test('merge complete plan survives restart, rejects stale review, records each actual resource and idempotent receipt', async () => {
    const staged = await stage();
    await write(path.join(staged.dir, 'characters/new.json'), JSON.stringify({ id: 'new', name: '新人' }));
    await write(path.join(staged.dir, 'world/lore.md'), '导入世界');
    await write(path.join(staged.dir, 'world/places.json'), JSON.stringify({ places: [{ name: '河谷', description: '新地点描述', detail: 1 }, { name: '新城', description: '新增' }] }));
    await write(path.join(staged.dir, 'factions/alliance.json'), JSON.stringify({ id: 'alliance', name: '同盟' }));
    await write(path.join(staged.dir, 'timeline/events.jsonl'), '{"id":"one","event":"抵达"}\n');
    await write(path.join(staged.dir, 'outlines/main.md'), '导入总纲');
    await write(path.join(staged.dir, 'outlines/volume-001/section-001/chapter-001.md'), '分层章纲');
    await write(path.join(staged.dir, 'style/memory.md'), '导入文风');
    const target = await novels.createNovel({ dir: path.join(root, 'merge-target'), title: '合并目标' });
    await data.writeWorld(target.dir, { lore: '旧世界', places: [{ name: '河谷', description: '旧描述' }] });
    await data.writeStyleMemory(target.dir, '用户文风');
    let merge = require('../src/main/import/mergeEngine');
    const created = await merge.createMergeSession(staged.dir, target.id, target.dir);
    assert.ok(created.items.some((item) => item.type === 'character')); assert.ok(created.items.some((item) => item.relative === 'world/places.json'));
    assert.ok(created.items.some((item) => item.relative === 'chapters/chapter-001.md'));
    for (const item of created.items) await merge.resolveConflict(created.sessionId, item.id, item.relative === 'style/memory.md' ? 'right' : 'left', { userNote: '取舍保留' });
    delete require.cache[require.resolve('../src/main/import/mergeEngine')]; merge = require('../src/main/import/mergeEngine');
    assert.ok((await merge.getMergeSession(created.sessionId)).items.every((item) => item.userNote === '取舍保留'));
    const restarted = spawnSync(process.execPath, ['-e', `(async()=>{ const merge = require('./src/main/import/mergeEngine'); const session = await merge.getMergeSession(${JSON.stringify(created.sessionId)}); if (!session || session.items.some((item) => item.userNote !== '取舍保留')) process.exit(1); console.log('durable-session-restored'); })().catch(e=>{console.error(e);process.exitCode=2});`], { cwd: path.resolve(__dirname, '..'), env: process.env, encoding: 'utf8' });
    assert.equal(restarted.status, 0, restarted.stderr); assert.ok(restarted.stdout.includes('durable-session-restored'));
    assert.equal((await merge.createMergeSession(staged.dir, target.id, target.dir)).sessionId, created.sessionId);
    await data.writeWorld(target.dir, { lore: '审阅期间用户新编辑' });
    await assert.rejects(merge.finalizeMerge(created.sessionId), (error) => error.code === 'stale_import_review');
    assert.equal(await data.readCharacter(target.dir, 'new'), null);
    assert.equal((await data.readWorld(target.dir)).lore, '审阅期间用户新编辑');
    const fresh = await merge.getMergeSession(created.sessionId); const pending = fresh.items.find((item) => item.status === 'pending');
    assert.equal(pending.rightContent, '审阅期间用户新编辑');
    await merge.resolveConflict(created.sessionId, pending.id, 'right');
    const concurrent = await Promise.all([merge.finalizeMerge(created.sessionId), merge.finalizeMerge(created.sessionId)]);
    const receipt = concurrent[0]; assert.deepEqual(concurrent[1], receipt);
    assert.ok(receipt.written >= 5); assert.equal(receipt.novelId, target.id);
    assert.equal((await data.readCharacter(target.dir, 'new')).name, '新人');
    assert.equal((await data.readWorld(target.dir)).places.find((p) => p.name === '河谷').description, '新地点描述');
    assert.equal(await data.readOutlineMaster(target.dir), '导入总纲');
    assert.equal(await data.readOutlineChapter(target.dir, 1, 1, 1), '分层章纲');
    assert.equal(await data.readStyleMemory(target.dir), '用户文风');
    assert.ok((await data.readChapter(target.dir, 'chapter-001.md')).includes('甲推开门'));
    assert.equal(JSON.parse(await fs.readFile(path.join(target.dir, 'factions/alliance.json'), 'utf8')).name, '同盟');
    assert.equal((await data.listTimeline(target.dir)).length, 1);
    assert.deepEqual(await merge.finalizeMerge(created.sessionId), receipt);
  });
  await test('committed storage receipt survives a failed UI checkpoint and never replays over later edits', async () => {
    const folder = path.join(root, 'partial-plan'); await fs.mkdir(folder);
    await write(path.join(folder, 'a.txt'), 'a'); await write(path.join(folder, 'b.txt'), 'b');
    const plan = { id: 'partial', state: 'prepared', changes: [{ ...await plans.snapshot(folder, 'a.txt'), after: 'new-a' }, { ...await plans.snapshot(folder, 'b.txt'), after: 'new-b' }] };
    await assert.rejects(plans.commitPlan(folder, plan, () => { throw new Error('interrupted checkpoint'); }), /interrupted/);
    assert.equal(await fs.readFile(path.join(folder, 'a.txt'), 'utf8'), 'new-a');
    assert.equal(await fs.readFile(path.join(folder, 'b.txt'), 'utf8'), 'new-b');
    await write(path.join(folder, 'a.txt'), 'external');
    assert.equal((await plans.commitPlan(folder, plan, async () => {})).written, 2);
    assert.equal(await fs.readFile(path.join(folder, 'a.txt'), 'utf8'), 'external');
  });
  await test('fact conflicts preserve values, relationships and chunk provenance instead of choosing longer', async () => {
    const merged = merger.mergeCharacters([{ chunkIndex: 0, characters: [{ name: '甲', age: '18', personality: '谨慎', relationships: [{ with: '乙', type: '朋友' }] }] }, { chunkIndex: 1, characters: [{ name: '甲', age: '两百多岁', personality: '非常冲动', relationships: [{ with: '乙', type: '仇敌' }] }] }])[0];
    assert.equal(merged.age, null); assert.equal(merged._analysisConflicts.age.length, 2); assert.equal(merged.relationships.length, 0); assert.equal(merged._analysisCandidates.age[1].sources[0].chunkIndex, 1);
  });
  await test('real enrichment entry executes helpers, isolates failures, validates identity and supports cancellation', async () => {
    const initialCalls = searchCalls;
    const cards = [{ id: 'good', name: '正确角色', sourceWork: '测试原作', isOriginal: false }, { id: 'bad', name: '失败者', sourceWork: '测试原作', isOriginal: false }];
    const results = await enricher.enrichCharacters(cards, { isFanwork: true, referencedWorks: ['测试原作'] });
    assert.equal(results[0]._enrichmentStatus, 'success'); assert.equal(results[1]._enrichmentStatus, 'failed'); assert.ok(searchCalls > initialCalls);
    const mixedTarget = await novels.createNovel({ dir: path.join(root, 'mixed-enrichment') });
    for (const card of cards) await data.writeCharacter(mixedTarget.dir, card);
    const preparedMixed = await updates.saveEnrichment(mixedTarget.dir, await data.listCharacters(mixedTarget.dir), results);
    assert.equal(preparedMixed.written, 0); assert.equal(preparedMixed.failures.length, 1); assert.equal(preparedMixed.failures[0].characterId, 'bad'); assert.ok(preparedMixed.reviewId);
    const override = await enricher.enrichCharacters([cards[0]], null, 'zh-CN', { fanworkNameOverride: '测试原作' }); assert.equal(override[0]._enrichmentStatus, 'success');
    assert.equal(enricher._validateWebInfo('同名角色', '正确作品', { appearance: '合理但错误的设定' }, { title: '同名角色', text: '其他作品' }), false);
    const grounded = enricher._groundWebInfo({ hairColor: '红发', appearance: '模型虚构', evidence: {} }, '原文只有蓝发'); assert.equal(grounded.hairColor, ''); assert.equal(grounded.appearance, '');
    const controller = new AbortController(); const cancelled = enricher.enrichCharacters(cards, null, 'zh-CN', { fanworkNameOverride: '测试原作', abortSignal: controller.signal }); controller.abort(new DOMException('cancelled', 'AbortError'));
    await assert.rejects(cancelled, /cancelled/);
  });
  await test('web extraction covers the fetched page tail in bounded requests and retains unconfirmed provenance', async () => {
    mode = 'long-web'; capturedRequests = [];
    const result = await enricher.enrichCharacters([{ id: 'tail', name: '正确角色', sourceWork: '测试原作', isOriginal: false }], null, 'zh-CN', { fanworkNameOverride: '测试原作' });
    assert.ok(result[0]._proposedFacts?.background?.some((p) => p.value === '末页背景原文'));
    assert.ok(capturedRequests.some((text) => text.includes('末页背景原文')));
    assert.ok(capturedRequests.every((text) => text.length + 6 <= 60000));
    mode = 'complete';
  });
  await test('enrichment three-way save preserves concurrent user edits, new fields, deletions and task ownership', async () => {
    const target = await novels.createNovel({ dir: path.join(root, 'enrichment-target') });
    await data.writeCharacter(target.dir, { id: 'a', name: '甲', appearance: '原值', background: '' });
    const initial = await data.listCharacters(target.dir);
    await data.writeCharacter(target.dir, { ...initial[0], appearance: '用户期间新编辑', note: '新增用户字段' });
    const receipt = await updates.saveEnrichment(target.dir, initial, [{ ...initial[0], appearance: '网络值', background: '网络背景', _enrichmentStatus: 'success' }], { runId: 'task-a' });
    assert.equal(receipt.written, 0);
    assert.equal((await data.readCharacter(target.dir, 'a')).background, '');
    await approveFacts(target.dir, receipt.reviewId);
    const saved = await data.readCharacter(target.dir, 'a');
    assert.equal(saved.appearance, '用户期间新编辑'); assert.equal(saved.note, '新增用户字段'); assert.equal(saved.background, '网络背景'); assert.equal(saved._enrichmentRunId, 'task-a'); assert.ok(receipt.conflicts.length);
    await data.deleteCharacter(target.dir, 'a');
    const deleted = await updates.saveEnrichment(target.dir, initial, [{ ...initial[0], _enrichmentStatus: 'success' }], { runId: 'task-b' });
    assert.equal(deleted.written, 0); assert.equal(deleted.failures.length, 1); assert.equal(await data.readCharacter(target.dir, 'a'), null);
  });
  await test('Saga records partial analysis, binds compatibility merge and completed retry never re-promotes', async () => {
    const service = new ImportSagaService(); mode = 'partial';
    let run = await service.start({ parsed: { chapters: [{ title: '甲', content: '甲推开门。'.repeat(30) }] } });
    run = await service.resume(run.runId); run = await service.resume(run.runId); assert.equal(run.state, 'review'); assert.equal(run.analysisResult.status, 'partial');
    const target = await novels.createNovel({ dir: path.join(root, 'saga-merge') });
    await assert.rejects(service.createMerge(run.runId, target.id), { code: 'unresolved_facts' });
    for (const review of await reviews.list(path.join(process.env.MANA_USER_DATA_ROOT, 'import-staging', run.importId))) await approveFacts(review.root, review.id);
    const session = await service.createMerge(run.runId, target.id);
    const merge = require('../src/main/import/mergeEngine');
    for (const item of session.items) await merge.resolveConflict(session.sessionId, item.id, 'left');
    const receipt = await service.finalizeSession(session.sessionId); assert.ok(receipt.written > 0);
    run = await service.get(run.runId); assert.equal(run.state, 'completed');
    const retry = await service.finalize(run.runId); assert.equal(retry.state, 'completed');
    assert.deepEqual(await service.finalizeSession(session.sessionId), receipt);
    await assert.rejects(service.createMerge(run.runId, novel.id), /review/);
    mode = 'complete';
  });
  await test('cancelled analysis cannot be resurrected by a late completion or failure', async () => {
    let release;
    const fake = { startAnalyses: async () => ({ runIds: ['held'], taskIds: ['world'] }), finalizeAnalyses: () => new Promise((resolve) => { release = resolve; }) };
    const service = new ImportSagaService({ analyzer: fake });
    let run = await service.start({ parsed: { chapters: [{ title: '待取消', content: '保留' }] } });
    run = await service.resume(run.runId);
    const completing = service.resume(run.runId);
    while (!release) await new Promise((resolve) => setTimeout(resolve, 1));
    await service.cancel(run.runId); release({ status: 'complete', lore: 100 });
    assert.equal((await completing).state, 'cancelled'); assert.equal((await service.get(run.runId)).state, 'cancelled');
    await assert.rejects(service.finalize(run.runId), /reviewed/);
  });
  console.log(`DATA_IMPORT_SAFETY ${total}/${total} passed (production storage/IPC with fake model and web transport)`);
})().catch((error) => { console.error(error); process.exitCode = 1; }).finally(async () => { Module._load = originalLoad; await fs.rm(root, { recursive: true, force: true }); });
