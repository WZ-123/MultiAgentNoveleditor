'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mana-empty-novel-data-'));
  const previousRoot = process.env.MANA_USER_DATA_ROOT;
  process.env.MANA_USER_DATA_ROOT = path.join(root, 'user-data');
  try {
    const novels = require('../src/main/store/novels');
    const data = require('../src/main/store/novelData');
    const novel = await novels.createNovel({ title: '空数据小说', dir: path.join(root, 'novel') });
    const opened = await novels.openNovel(novel.id);
    const novelDir = opened.entry.dir;
    const [characters, assets, timeline, chapters, outline, style, world] = await Promise.all([
      data.listCharacters(novelDir), data.listAssets(novelDir), data.listTimeline(novelDir), data.listChapters(novelDir),
      data.listOutlineHierarchy(novelDir), data.readStyleMemory(novelDir), data.readWorld(novelDir),
    ]);
    assert.deepEqual(characters, []);
    assert.deepEqual(assets, []);
    assert.deepEqual(timeline, []);
    assert.deepEqual(chapters, []);
    assert.equal(Array.isArray(outline.volumes), true);
    assert.equal(style, '');
    assert.equal(typeof world, 'object');
    assert.equal(world == null, false);
    console.log('DATA-B01 passed: a newly created empty novel returns defined empty collections and default domain objects without stale data.');
  } finally {
    if (previousRoot == null) delete process.env.MANA_USER_DATA_ROOT;
    else process.env.MANA_USER_DATA_ROOT = previousRoot;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

if (require.main === module) run().catch((error) => { console.error(error); process.exitCode = 1; });
module.exports = { run };
