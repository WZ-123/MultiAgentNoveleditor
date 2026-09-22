'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mana-data-long-field-'));
  const previousRoot = process.env.MANA_USER_DATA_ROOT;
  process.env.MANA_USER_DATA_ROOT = path.join(root, 'user-data');
  try {
    const novels = require('../src/main/store/novels');
    const data = require('../src/main/store/novelData');
    const { searchNovel } = require('../src/main/search/searchEngine');
    const novel = await novels.createNovel({ title: '长字段小说', dir: path.join(root, 'novel') });
    const marker = 'LONG_CHARACTER_FIELD_END_MARKER';
    const background = '前史。'.repeat(50000) + marker;
    await data.writeCharacter(novel.dir, { id: 'long-character', name: '长字段角色', background, personality: '沉稳' });
    const restored = await data.readCharacter(novel.dir, 'long-character');
    assert.equal(restored.background.length, background.length);
    assert.equal(restored.background.endsWith(marker), true);
    const hits = await searchNovel(novel.dir, marker, { categories: ['characters'] });
    assert.equal(hits.length, 1);
    assert.equal(hits[0].target.characterId, 'long-character');
    assert.equal(hits[0].snippet.includes(marker), true);
    console.log('DATA-B03 passed: a long character field round-trips and remains searchable through its final marker.');
  } finally {
    if (previousRoot == null) delete process.env.MANA_USER_DATA_ROOT;
    else process.env.MANA_USER_DATA_ROOT = previousRoot;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

if (require.main === module) run().catch((error) => { console.error(error); process.exitCode = 1; });
module.exports = { run };
