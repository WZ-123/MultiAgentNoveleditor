'use strict';

const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

async function run() {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'mana-mcp-mutation-'));
  process.env.MANA_USER_DATA_ROOT = path.join(tmp, 'user-data');
  const novels = require('../src/main/store/novels');
  const novelData = require('../src/main/store/novelData');
  const { readJson, writeJson } = require('../src/main/store/jsonStore');
  const { hash } = require('../src/main/codex-runtime/contracts');
  const { readResource } = require('../src/main/mcp/novelResources');
  const { prepareChanges, applyPrepared, recoverIncompleteTransactions } = require('../src/main/mcp/mutationService');

  const novel = await novels.createNovel({ title: '事务测试', dir: path.join(tmp, 'novel') });
  const entry = { id: novel.id, dir: novel.dir };
  await novelData.writeChapterWithMeta(entry.dir, 'chapter-001.md', '她停在门外。', {}, { baseContent: '' });
  await novelData.writeStyleMemory(entry.dir, '短句，克制。');

  const chapter = await readResource(entry, 'chapter:chapter-001.md');
  const style = await readResource(entry, 'style:memory');
  const committed = await applyPrepared(entry, await prepareChanges(entry, {
    reason: '同步修订正文与文风记忆',
    changes: [
      { resourceRef: 'chapter:chapter-001.md', baseHash: chapter.sourceHash, mode: 'replace', content: '她在门外等了一会。' },
      { resourceRef: 'style:memory', baseHash: style.sourceHash, mode: 'replace', content: '短句，克制，少用解释。' },
    ],
  }));
  assert.equal(committed.status, 'committed');
  assert.equal((await readResource(entry, 'chapter:chapter-001.md')).content, '她在门外等了一会。');

  const created = await applyPrepared(entry, await prepareChanges(entry, {
    reason: '创建不存在的角色资源',
    changes: [{ resourceRef: 'character:new-character', baseHash: hash('model-cannot-read-absent-hash'), mode: 'create', content: { id: 'new-character', name: '新角色' } }],
  }));
  assert.equal(created.status, 'committed', 'create must use atomic absence checks instead of requiring an unknowable missing-resource hash');
  assert.equal(JSON.parse((await readResource(entry, 'character:new-character')).content).name, '新角色');
  await assert.rejects(() => prepareChanges(entry, {
    reason: '重复创建必须被阻止',
    changes: [{ resourceRef: 'character:new-character', mode: 'create', content: { id: 'new-character', name: '覆盖' } }],
  }), /cannot create|create/u);

  await novelData.writeChapterWithMeta(entry.dir, 'chapter-empty.md', '', {}, { baseContent: '' });
  const adoptedPlaceholder = await applyPrepared(entry, await prepareChanges(entry, {
    reason: '首次填充编辑器创建的空章节占位',
    changes: [{ resourceRef: 'chapter:chapter-empty.md', mode: 'create', content: '第一章正文。' }],
  }));
  assert.equal(adoptedPlaceholder.status, 'committed');
  assert.equal((await readResource(entry, 'chapter:chapter-empty.md')).content, '第一章正文。');
  await assert.rejects(() => prepareChanges(entry, {
    reason: '非空章节不能再次 create',
    changes: [{ resourceRef: 'chapter:chapter-empty.md', mode: 'create', content: '覆盖正文。' }],
  }), /cannot create|create/u);

  const outlineChapter = await applyPrepared(entry, await prepareChanges(entry, {
    reason: '创建可独立寻址的层级章大纲',
    changes: [{ resourceRef: 'outline:chapter:1:2:3', mode: 'create', content: '# 第3章：回声\n\n- 目标：确认独立资源写入。\n' }],
  }));
  assert.equal(outlineChapter.status, 'committed');
  assert.match((await readResource(entry, 'outline:chapter:1:2:3')).content, /独立资源写入/u);
  assert.equal(await novelData.readOutlineChapter(entry.dir, 1, 2, 3), '# 第3章：回声\n\n- 目标：确认独立资源写入。\n');

  const timelineEvent = await applyPrepared(entry, await prepareChanges(entry, {
    reason: '创建可独立寻址的时间线事件',
    changes: [{ resourceRef: 'timeline:event:black-tide-01', mode: 'create', content: { id: 'black-tide-01', when: '第1章', description: '黑潮抵达外港', chapterRef: 'chapter-001.md' } }],
  }));
  assert.equal(timelineEvent.status, 'committed');
  assert.match((await readResource(entry, 'timeline:event:black-tide-01')).content, /黑潮抵达外港/u);

  const beforeStale = await readResource(entry, 'chapter:chapter-001.md');
  const stalePrepared = await prepareChanges(entry, { reason: '陈旧版本测试', changes: [{ resourceRef: 'chapter:chapter-001.md', baseHash: beforeStale.sourceHash, mode: 'replace', content: '不应写入。' }] });
  await novelData.writeChapterWithMeta(entry.dir, 'chapter-001.md', '用户刚刚修改。', {}, { baseContent: beforeStale.content });
  await assert.rejects(() => applyPrepared(entry, stalePrepared), (error) => error.code === 'stale_hash');
  assert.equal((await readResource(entry, 'chapter:chapter-001.md')).content, '用户刚刚修改。');

  const rollbackChapter = await readResource(entry, 'chapter:chapter-001.md');
  const places = await readResource(entry, 'world:places');
  const rollbackPrepared = await prepareChanges(entry, {
    reason: '强制触发第二资源失败',
    changes: [
      { resourceRef: 'chapter:chapter-001.md', baseHash: rollbackChapter.sourceHash, mode: 'replace', content: '事务中间态。' },
      { resourceRef: 'world:places', baseHash: places.sourceHash, mode: 'replace', content: '这不是 JSON' },
    ],
  });
  await assert.rejects(() => applyPrepared(entry, rollbackPrepared));
  assert.equal((await readResource(entry, 'chapter:chapter-001.md')).content, '用户刚刚修改。', 'first resource must roll back');
  const wal = await readJson(path.join(process.env.MANA_USER_DATA_ROOT, 'mutation-service', 'wal.json'), null);
  assert.equal(wal.blocked, false);
  assert.equal(wal.transactions.at(-1).status, 'rolled_back');

  const crashBefore = (await readResource(entry, 'chapter:chapter-001.md')).content;
  const crashAfter = '崩溃时留下的中间态。';
  await novelData.writeChapterWithMeta(entry.dir, 'chapter-001.md', crashAfter, {}, { baseContent: crashBefore });
  wal.transactions.push({
    transactionId: 'simulated-crash', novelId: entry.id, novelDir: entry.dir, status: 'prepared',
    resources: [{ resourceRef: 'chapter:chapter-001.md', before: crashBefore, beforeHash: hash(crashBefore), afterHash: hash(crashAfter), existed: true }],
  });
  await writeJson(path.join(process.env.MANA_USER_DATA_ROOT, 'mutation-service', 'wal.json'), wal, { mode: 0o600 });
  await recoverIncompleteTransactions();
  assert.equal((await readResource(entry, 'chapter:chapter-001.md')).content, crashBefore, 'prepared crash transaction must recover before later writes');
  const recoveredWal = await readJson(path.join(process.env.MANA_USER_DATA_ROOT, 'mutation-service', 'wal.json'), null);
  assert.equal(recoveredWal.transactions.find((item) => item.transactionId === 'simulated-crash').status, 'rolled_back');
  console.log('novel-mcp-mutation: ok');
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
