'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

// Keep the real parser, evaluator, filesystem resource reads, hash/count helpers,
// normalization and continuation. Only unrelated store/service boundaries are fake.
function loadWith(file, dependencies) {
  const filename = path.resolve(__dirname, '..', file);
  const module = new Module(filename, moduleParent);
  module.filename = filename;
  module.paths = Module._nodeModulePaths(path.dirname(filename));
  const original = module.require.bind(module);
  module.require = id => Object.hasOwn(dependencies, id) ? dependencies[id] : original(id);
  module._compile(require('node:fs').readFileSync(filename, 'utf8'), filename);
  return module.exports;
}
const moduleParent = module;
async function main() {
  const { taskConstraintsFor } = await import('../src/components/writingTaskConstraints.mjs');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mana-next-chapter-'));
  const entry = { id: 'novel', dir: root };
  await fs.mkdir(path.join(root, 'chapters'));
  const data = {
    listChapters: async () => (await fs.readdir(path.join(root, 'chapters'))).map(name => ({ name })),
    listCharacters: async () => [], listAssets: async () => [], listTimeline: async () => [],
    listOutlineHierarchy: async () => ({ chapters: [] }),
    readWorld: async () => ({ lore: '界'.repeat(100000) }),
  };
  const resources = loadWith('src/main/mcp/novelResources.js', { '../store/novelData': data });
  const { evaluateTaskResult } = loadWith('src/main/codex-runtime/taskCompletion.js', {
    '../mcp/novelResources': resources,
    './reviewLedger': { observedReadRefs: () => new Set() },
  });
  const oldRef = 'chapter:chapter-001.md';
  const nextRef = 'chapter:chapter-002.md';
  const otherRef = 'chapter:chapter-003.md';
  const save = async (ref, count, mode = 'create') => {
    await fs.writeFile(path.join(root, 'chapters', ref.slice(8)), '# 章节标题\n' + '文'.repeat(count));
    const current = await resources.readResource(entry, ref);
    return { resourceRef: ref, mode, newHash: current.sourceHash };
  };
  const parse = (text, context) => taskConstraintsFor(text, 'mana-fiction-writing', context);
  const evaluate = (constraints, saved = [], extra = {}) => evaluateTaskResult({ entry, taskConstraints: constraints, committedResources: saved, ...extra }, true);
  let checks = 0;
  const test = async (name, fn) => { await fn(); checks++; console.log('PASS next-chapter ' + name); };
  try {
    const old = await save(oldRef, 100000, 'replace');
    let next = await save(nextRef, 100);
    await test('new-chapter intent does not match updating chapters or negated new writes', async () => {
      assert.equal(parse('更新章节，3000字').wordCountScope, 'saved_resources');
      assert.equal(parse('润色本章，不要写新章，3000字', { resourceRef: oldRef }).wordCountScope, 'target_resources');
      assert.equal(parse('参考本章，写下一章，3000字', { resourceRef: oldRef }).wordCountScope, 'new_writing');
    });
    await test('actual parser does not count 100000 old words toward a 3000-word next chapter', async () => {
      const result = await evaluate(parse('写下一章，3000字', { resourceRef: oldRef }), [next]);
      assert.equal(result.constraints.wordCountScope, 'new_writing');
      assert.equal(result.checks.wordCount.actual, 100);
      assert.equal(result.goalVerified, false);
      assert.deepEqual(result.evidence.targetResourceRefs, [nextRef]);
      assert.equal(result.persistence.status, 'saved');
      assert.equal(result.checks.wordCount.blocking, false);
    });
    await test('explicit range honors exact requested boundaries and never rolls back a save', async () => {
      for (const [count, status] of [[2850, 'below_target'], [2999, 'below_target'], [3000, 'met'], [4000, 'met'], [4001, 'over_target'], [4200, 'over_target']]) {
        next = await save(nextRef, count);
        const result = await evaluate(parse('写下一章，3000—4000字'), [next]);
        assert.equal(result.checks.wordCount.status, status);
        assert.equal(result.goalVerified, status === 'met');
        assert.equal(result.savedResources.length, 1);
        assert.equal(resources.bodyChineseCharacterCount((await resources.readResource(entry, nextRef)).content), count);
      }
    });
    await test('unrelated existing chapter edits do not satisfy new writing', async () => {
      next = await save(nextRef, 100);
      const result = await evaluate(parse('写下一章，3000字'), [old, next]);
      assert.equal(result.checks.wordCount.actual, 100);
      assert.equal(result.goalVerified, false);
      const noNew = await evaluate(parse('写下一章，3000字'), [old]);
      assert.equal(noNew.checks.wordCount.actual, 0);
      const world = await resources.readResource(entry, 'world:lore');
      const nonChapter = await evaluate(parse('写下一章，3000字'), [{ resourceRef: 'world:lore', mode: 'create', newHash: world.sourceHash }]);
      assert.equal(nonChapter.checks.wordCount.actual, 0);
      assert.equal(nonChapter.goalVerified, false);
      assert.ok(noNew.objective.unmet.includes('word_count_target_missing'));
    });
    await test('no writes, stale hashes, missing creates and deleted chapters cannot count', async () => {
      for (const saved of [[], [{ ...next, newHash: 'stale' }], [{ resourceRef: otherRef, mode: 'create', newHash: 'missing' }], [{ ...next, mode: 'delete' }]]) {
        const result = await evaluate(parse('写下一章，3000字'), saved);
        assert.equal(result.goalVerified, false);
        assert.equal(result.checks.wordCount.actual, 0);
      }
    });
    await test('current chapter and explicit whole-novel targets remain distinct', async () => {
      next = await save(nextRef, 3000, 'replace');
      const current = await evaluate(parse('将本章补足到3000字', { resourceRef: nextRef }), [next, old]);
      assert.equal(current.constraints.wordCountScope, 'target_resources');
      assert.equal(current.checks.wordCount.actual, 3000);
      assert.equal(current.goalVerified, true);
      const whole = await evaluate(parse('全书达到103000字'), [next]);
      assert.equal(whole.constraints.wordCountScope, 'whole_novel');
      assert.equal(whole.checks.wordCount.actual, 103000);
      assert.equal(whole.goalVerified, true);
      const missing = await evaluate(parse('本章3000字'), [next]);
      assert.equal(missing.goalVerified, false);
      assert.ok(missing.objective.unmet.includes('word_count_target_missing'));
    });
    await test('generic writing and legacy constraints count saved chapters, never every chapter', async () => {
      next = await save(nextRef, 100);
      for (const constraints of [parse('写3000字'), { operation: 'write', minBodyCjk: 3000 }]) {
        const result = await evaluate(constraints, [next]);
        assert.equal(result.checks.wordCount.actual, 100);
        assert.equal(result.goalVerified, false);
      }
    });
    await test('an empty first attempt can bind the chapter saved by a continuation', async () => {
      const first = await evaluate(parse('写下一章，3000字'));
      assert.deepEqual(first.constraints.wordCountResourceRefs, []);
      next = await save(nextRef, 3000);
      const continued = await evaluate(JSON.parse(JSON.stringify(first.constraints)), [next]);
      assert.equal(continued.goalVerified, true);
      assert.deepEqual(continued.constraints.wordCountResourceRefs, [nextRef]);
    });
    await test('create followed by replacement retains new-chapter identity', async () => {
      const created = next;
      next = await save(nextRef, 3000, 'replace');
      const result = await evaluate(parse('写下一章，3000字'), [created, next]);
      assert.equal(result.goalVerified, true);
      assert.equal(result.checks.wordCount.actual, 3000);
    });
    await test('persisted continuation binds original chapter and excludes unrelated later saves', async () => {
      next = await save(nextRef, 100);
      const first = await evaluate(parse('写下一章，3000字'), [next]);
      let source = JSON.parse(JSON.stringify({ runId: 'first', conversationId: 'thread', novelId: 'novel', taskId: 'task', status: 'completed', savedResources: [next], taskResult: first }));
      const { prepareTaskContinuation } = loadWith('src/main/codex-runtime/taskContinuation.js', {
        '../store/chatRuns': { get: async () => source },
        '../store/chatHistory': { getThread: async () => ({ novelId: 'novel' }), getBranch: () => [{ runtimeTaskRunId: source.runId }] },
      });
      const continueTask = () => prepareTaskContinuation({ conversationId: 'thread', novelId: 'novel', continueFromRunId: source.runId, text: '继续补足字数' });
      let payload = await continueTask();
      assert.deepEqual(payload.taskConstraints.wordCountResourceRefs, [nextRef]);
      const other = await save(otherRef, 10000);
      let result = await evaluate(payload.taskConstraints, [other], { reusedSavedResources: payload.continuation.savedResources });
      assert.equal(result.checks.wordCount.actual, 100);
      assert.equal(result.goalVerified, false);
      const expanded = await save(nextRef, 3000, 'replace');
      result = await evaluate(payload.taskConstraints, [expanded], { reusedSavedResources: payload.continuation.savedResources });
      assert.equal(result.goalVerified, true);
      assert.equal(result.checks.wordCount.actual, 3000);
      source = { ...source, runId: 'second', savedResources: [expanded], taskResult: { ...result, goalVerified: false, goalStatus: 'incomplete' } };
      payload = await continueTask();
      result = await evaluate(payload.taskConstraints, [], { reusedSavedResources: payload.continuation.savedResources });
      assert.equal(result.goalVerified, true);
      await save(nextRef, 2900, 'replace');
      result = await evaluate(payload.taskConstraints, [], { reusedSavedResources: payload.continuation.savedResources });
      assert.equal(result.goalVerified, false);
      assert.equal(result.checks.wordCount.actual, 0);
    });
    console.log(`next-chapter-wordcount: ok (${checks} scenarios)`);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
