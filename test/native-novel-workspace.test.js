'use strict';

const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

async function run() {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'mana-native-workspace-'));
  process.env.MANA_USER_DATA_ROOT = path.join(tmp, 'user-data');
  const novels = require('../src/main/store/novels');
  const novelData = require('../src/main/store/novelData');
  const {
    collectNativeNovelChanges,
    resourceRefFromRelativePath,
    resourceRelativePath,
    syncNativeNovelWorkspace,
  } = require('../src/main/codex-runtime/nativeNovelWorkspace');

  const novel = await novels.createNovel({ title: '工作区映射测试', dir: path.join(tmp, 'novel') });
  await novelData.writeChapterWithMeta(novel.dir, 'chapter-001.md', '原文。', {}, { baseContent: '' });
  const workspace = await syncNativeNovelWorkspace({ id: novel.id, dir: novel.dir }, path.join(tmp, 'workspaces'));
  assert.equal(await fsp.readFile(path.join(workspace.root, 'chapters/chapter-001.md'), 'utf8'), '原文。');
  assert.equal(resourceRelativePath('chapter:chapter-001.md'), 'chapters/chapter-001.md');
  assert.equal(resourceRelativePath('outline:chapter:1:2:3'), 'outlines/chapter-v001-s002-c003.md');
  assert.equal(resourceRefFromRelativePath('outlines/chapter-v001-s002-c003.md'), 'outline:chapter:1:2:3');
  assert.equal(resourceRelativePath('timeline:event:black-tide-01'), 'timeline/event-black-tide-01.json');
  assert.equal(resourceRefFromRelativePath('timeline/event-black-tide-01.json'), 'timeline:event:black-tide-01');
  assert.equal(resourceRefFromRelativePath('characters/lin-ji.json'), 'character:lin-ji');

  await fsp.writeFile(path.join(workspace.root, 'chapters/chapter-001.md'), '修改后。\n', 'utf8');
  await fsp.mkdir(path.join(workspace.root, 'characters'), { recursive: true });
  await fsp.writeFile(path.join(workspace.root, 'characters/lin-ji.json'), '{"id":"lin-ji","name":"林霁"}\n', 'utf8');
  const changes = await collectNativeNovelChanges(workspace);
  assert.deepEqual(changes.map((item) => [item.resourceRef, item.mode]), [
    ['chapter:chapter-001.md', 'replace'],
    ['character:lin-ji', 'create'],
  ]);

  await fsp.writeFile(path.join(workspace.root, 'unexpected.txt'), '不得提交', 'utf8');
  await assert.rejects(() => collectNativeNovelChanges(workspace), /未知小说文件/u);
  assert.throws(() => resourceRefFromRelativePath('../novel-secret'), /未知小说文件/u);
  console.log('native-novel-workspace: ok');
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
