'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');

const app = fs.readFileSync(path.join(__dirname, '../src/App.jsx'), 'utf8');
function between(start, end) { return app.slice(app.indexOf(start), app.indexOf(end, app.indexOf(start))); }
const reconcileCode = between('  const applySavedChapterSnapshot =', '  const refreshAllChapterDisplayNames');
const saveCode = between('  const saveChapterContentToDisk =', '  const flushActiveChapterToDisk');
const updateCode = between('  const updateActiveChapterContent =', '  // Save chapter before screen lock');
const flushCode = between('  const flushActiveChapterToDisk =', '  const updateActiveChapterContent =');
const restoreCode = between('  const restoreSelectedRevision =', '  const useDiskConflictVersion =');
const refreshCode = between('  const refreshActiveNovelState =', '  // Detect active novel once');

async function run() {
  const { createChapterSaveQueue } = await import(pathToFileURL(path.join(__dirname, '../src/components/chapterSaveQueue.mjs')));
  function harness() {
    const chapter = { id: 'chapter', fileName: 'chapter-001.md', content: '初稿', lastSavedContent: '磁盘', isDirty: true, isContentLoaded: true };
    const ref = { current: { volumes: [{ sections: [{ chapters: [chapter] }] }] } };
    const disk = new Map([['A', '磁盘'], ['B', '乙项目']]);
    const pending = [], requests = [], timers = new Map(); let nextTimer = 0;
    const context = {
      activeNovelId: 'A', activeChapterId: 'chapter', currentProjectRef: { current: 'A' }, currentNovelRef: ref,
      chapterMap: new Map([['chapter', { chapter }]]), chapterSaveQueueRef: { current: createChapterSaveQueue() },
      chapterSaveTimersRef: { current: new Map() }, inFlightChapterSavesRef: { current: new Map() }, flushProjectSavesRef: { current: null },
      activeRefreshVersionRef: { current: 0 }, structureSaveQueuesRef: { current: new Map() },
      useCallback: fn => fn, getChapterSaveTitle: () => '标题',
      activeChapter: chapter, selectedRevision: { id: 'revision-1' },
      showSaveToast() {}, setHistoryStatus() {}, openChapterHistory: async () => {},
      setNovel: fn => { ref.current = fn(ref.current); },
      setSaveConflict: value => { context.conflict = value; }, setSaveStatus: value => { context.status = value; },
      setSaveToast: value => { context.toast = value; },
      setActiveNovelId: value => { context.nextActiveNovelId = value; },
      resetNovelUiState: () => { context.reset = true; }, syncNovelTreeFromDisk: async () => {},
      setTimeout: fn => { const id = ++nextTimer; timers.set(id, fn); return id; }, clearTimeout: id => timers.delete(id),
      syncStructureToMeta: async () => { context.structureSaveQueuesRef.current.delete('A'); },
      console: { error() {} },
      window: { mana: { novel: {
        restoreChapterRevision: async id => { disk.set(id, '历史稿'); return { content: '历史稿', title: '历史标题' }; },
        active: async () => ({ id: 'B' }), readChapter: async id => disk.get(id),
        saveChapter: (...args) => new Promise((resolve, reject) => {
          requests.push(args);
          pending.push({ args, finish(error) {
            if (error) return reject(error);
            if (args[4].baseContent !== disk.get(args[0])) return reject(new Error('snapshot mismatch'));
            disk.set(args[0], args[2]); resolve({ title: '标题', displayName: '第1章：标题' });
          } });
        }),
      } } },
    };
    vm.createContext(context);
    vm.runInContext(`${reconcileCode}\n${saveCode}\n${updateCode}\n${refreshCode}\n${flushCode}\n${restoreCode}\nthis.save = saveChapterContentToDisk; this.apply = applySavedChapterSnapshot; this.type = updateActiveChapterContent; this.refresh = refreshActiveNovelState; this.flush = flushActiveChapterToDisk; this.restore = restoreSelectedRevision;`, context);
    return { context, pending, requests, timers, disk, chapter: () => ref.current.volumes[0].sections[0].chapters[0] };
  }
  const tick = async () => { for (let n = 0; n < 12; n++) await Promise.resolve(); };
  let count = 0;
  async function test(name, fn) { await fn(); count++; console.log(`TEST_PASS ${name}`); }
  await test('delayed save preserves typing and advances only saved baseline', async () => {
    const h = harness(), p = h.context.save('chapter', '初稿'); await tick();
    h.context.type('初稿＋新输入', { scheduleSave: false }); h.pending.shift().finish(); await p;
    assert.equal(h.chapter().content, '初稿＋新输入'); assert.equal(h.chapter().lastSavedContent, '初稿'); assert.equal(h.chapter().isDirty, true);
    const p2 = h.context.save('chapter', '初稿＋新输入'); await tick();
    assert.equal(h.requests[1][4].baseContent, '初稿'); h.pending.shift().finish(); await p2;
    assert.equal(h.chapter().isDirty, false); assert.equal(h.disk.get('A'), '初稿＋新输入');
  });
  await test('overlapping manual/autosave writes serialize with successful predecessor base', async () => {
    const h = harness(), p1 = h.context.save('chapter', '初稿'); await tick();
    h.context.type('新版', { scheduleSave: false }); const p2 = h.context.save('chapter', '新版'); await tick();
    assert.equal(h.requests.length, 1); h.pending.shift().finish(); await p1; await tick();
    assert.equal(h.requests[1][4].baseContent, '初稿'); h.pending.shift().finish(); await p2;
    assert.equal(h.disk.get('A'), '新版'); assert.equal(h.chapter().content, '新版'); assert.equal(h.chapter().isDirty, false);
  });
  await test('debounced closure uses fresh saved baseline rather than typing-time base', async () => {
    const h = harness(), p = h.context.save('chapter', '初稿'); await tick();
    h.context.type('后续'); h.pending.shift().finish(); await p;
    const timer = [...h.timers.values()][0](); await tick(); assert.equal(h.requests[1][4].baseContent, '初稿');
    h.pending.shift().finish(); await timer; assert.equal(h.disk.get('A'), '后续'); assert.equal(h.chapter().isDirty, false);
  });
  await test('failed writes preserve draft and do not poison queue', async () => {
    const h = harness(), p = h.context.save('chapter', '初稿'); const failed = assert.rejects(p, /disk failed/); await tick();
    h.pending.shift().finish(new Error('disk failed')); await failed; assert.equal(h.chapter().isDirty, true);
    const retry = h.context.save('chapter', '初稿'); await tick(); assert.equal(h.requests[1][4].baseContent, '磁盘');
    h.pending.shift().finish(); await retry; assert.equal(h.chapter().isDirty, false);
  });
  await test('explicit verified base is not silently rebased', async () => {
    const h = harness(), p1 = h.context.save('chapter', '初稿'); await tick();
    const p2 = h.context.save('chapter', 'AI改稿', { source: 'ai', baseContent: '磁盘', verifiedContentHash: 'verified' });
    const failed = assert.rejects(p2, /snapshot mismatch/); h.pending.shift().finish(); await p1; await tick();
    assert.equal(h.requests[1][4].baseContent, '磁盘'); assert.equal(h.requests[1][4].verifiedContentHash, 'verified');
    h.pending.shift().finish(); await failed; assert.equal(h.disk.get('A'), '初稿');
  });
  await test('successful AI replacement applies only if editor has not changed', async () => {
    const h = harness(), p = h.context.save('chapter', 'AI改稿', { source: 'ai', baseContent: '磁盘' }); await tick();
    h.pending.shift().finish(); await p; assert.equal(h.chapter().content, 'AI改稿'); assert.equal(h.chapter().isDirty, false);
  });
  await test('late project response cannot alter other project editor', async () => {
    const h = harness(), p = h.context.save('chapter', '初稿'); await tick();
    h.context.currentProjectRef.current = 'B'; h.pending.shift().finish(); await p;
    assert.equal(h.chapter().lastSavedContent, '磁盘'); assert.equal(h.chapter().isDirty, true);
  });
  await test('switch flush waits for disk and cancels only source-project debounce', async () => {
    const h = harness(); h.context.type('切换前');
    const foreignKey = JSON.stringify(['B', 'chapter-001.md']); h.context.chapterSaveTimersRef.current.set(foreignKey, 999);
    const switched = h.context.refresh({ id: 'B' }); await tick(); assert.equal(h.context.reset, undefined); assert.equal(h.context.currentProjectRef.current, 'A');
    assert.equal(h.context.chapterSaveTimersRef.current.has(foreignKey), true); h.pending.shift().finish(); await switched;
    assert.equal(h.disk.get('A'), '切换前'); assert.equal(h.context.currentProjectRef.current, 'B'); assert.equal(h.context.reset, true);
  });
  await test('typing during switch flush is saved before reset', async () => {
    const h = harness(), switched = h.context.refresh({ id: 'B' }); await tick();
    h.context.type('最后输入'); h.pending.shift().finish(); await tick();
    assert.equal(h.context.reset, undefined); assert.equal(h.requests.length, 2); h.pending.shift().finish(); await switched;
    assert.equal(h.disk.get('A'), '最后输入'); assert.equal(h.context.reset, true);
  });
  await test('typing during structure flush is saved before project reset', async () => {
    const h = harness(); h.chapter().isDirty = false;
    let release; h.context.structureSaveQueuesRef.current.set('A', new Promise(resolve => { release = resolve; }));
    const switched = h.context.refresh({ id: 'B' }); await tick();
    h.context.type('结构保存时输入', { scheduleSave: false });
    h.context.structureSaveQueuesRef.current.delete('A'); release(); await tick();
    assert.equal(h.context.reset, undefined); assert.equal(h.requests.length, 1);
    h.pending.shift().finish(); await switched;
    assert.equal(h.disk.get('A'), '结构保存时输入'); assert.equal(h.context.reset, true);
  });
  await test('failed structure write remains a switch barrier until retry succeeds', async () => {
    const h = harness(); h.chapter().isDirty = false;
    const failed = Promise.reject(new Error('metadata failed')); failed.catch(() => {});
    h.context.structureSaveQueuesRef.current.set('A', failed);
    let attempts = 0;
    h.context.syncStructureToMeta = async () => { attempts++; throw new Error('metadata still unavailable'); };
    await h.context.refresh({ id: 'B' });
    assert.equal(h.context.currentProjectRef.current, 'A'); assert.equal(h.context.reset, undefined);
    h.context.syncStructureToMeta = async () => { attempts++; h.context.structureSaveQueuesRef.current.delete('A'); };
    await h.context.refresh({ id: 'B' });
    assert.equal(attempts, 2); assert.equal(h.context.currentProjectRef.current, 'B');
  });
  await test('failed switch flush leaves source draft visible', async () => {
    const h = harness(), switched = h.context.refresh({ id: 'B' }); await tick();
    h.pending.shift().finish(new Error('disk failed')); await switched;
    assert.equal(h.context.reset, undefined); assert.equal(h.context.currentProjectRef.current, 'A'); assert.equal(h.chapter().isDirty, true); assert.equal(h.context.status, 'save-failed');
  });
  await test('manual flush cancels debounce and preserves typing during save', async () => {
    const h = harness(); const p = h.context.flush(); await tick();
    h.context.type('手动保存时的新输入', { scheduleSave: false }); h.pending.shift().finish(); await p;
    assert.equal(h.chapter().content, '手动保存时的新输入'); assert.equal(h.chapter().isDirty, true);
  });
  await test('restore cancels stale debounce and follows pending save', async () => {
    const h = harness(), p = h.context.save('chapter', '初稿'); await tick();
    h.context.type('恢复前编辑'); const restored = h.context.restore();
    assert.equal(h.context.chapterSaveTimersRef.current.size, 0); assert.equal(h.disk.get('A'), '磁盘');
    h.pending.shift().finish(); await p; await restored;
    assert.equal(h.disk.get('A'), '历史稿'); assert.equal(h.chapter().content, '历史稿'); assert.equal(h.chapter().isDirty, false);
  });
  await test('restore preserves typing made after the restore request', async () => {
    const h = harness(), p = h.context.save('chapter', '初稿'); await tick();
    const restored = h.context.restore(); h.context.type('恢复中的新输入', { scheduleSave: false });
    h.pending.shift().finish(); await p; await restored;
    assert.equal(h.disk.get('A'), '历史稿'); assert.equal(h.chapter().content, '恢复中的新输入'); assert.equal(h.chapter().isDirty, true);
  });
  await test('project keys isolate simultaneous chapter writes', async () => {
    const enqueue = createChapterSaveQueue(); let release; let otherRan = false;
    const first = enqueue(JSON.stringify(['A', 'chapter.md']), () => new Promise(resolve => { release = () => resolve({ content: 'a', snapshot: 'a' }); }));
    const second = enqueue(JSON.stringify(['B', 'chapter.md']), async () => { otherRan = true; return { content: 'b', snapshot: 'b' }; });
    await second; assert.equal(otherRan, true); release(); await first;
  });
  console.log(`TEST_SUMMARY ${count}/${count} passed, 0 failed\nTEST_DONE`);
}
run().catch(err => { console.error(err); process.exitCode = 1; });
