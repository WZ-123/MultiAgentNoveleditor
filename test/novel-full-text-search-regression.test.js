'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mana-full-text-search-'));
  const previousRoot = process.env.MANA_USER_DATA_ROOT;
  process.env.MANA_USER_DATA_ROOT = path.join(root, 'user-data');
  try {
    const novels = require('../src/main/store/novels');
    const data = require('../src/main/store/novelData');
    const { searchNovel } = require('../src/main/search/searchEngine');
    const novel = await novels.createNovel({ title: '全文搜索小说', dir: path.join(root, 'novel') });
    const novelDir = novel.dir;
    await data.writeChapterWithMeta(novelDir, 'chapter-001.md', '莉音在月下抬头。秘密代号是ＡＢ１２。', { title: '月下密谈' });
    await data.writeCharacter(novelDir, { id: 'liyin', name: '莉音', personality: '冷静', aliases: ['月下助手'] });
    await data.upsertAsset(novelDir, { id: 'moon-key', name: '月钥匙', description: '开启秘密房间的钥匙' });
    await data.writeWorld(novelDir, { lore: '月港是故事的起点。', places: [{ name: '月港', description: '停泊点', type: 'port' }] });
    await data.appendTimelineEvent(novelDir, { id: 'moon-event', description: '莉音抵达月港', when: '第一夜', participants: ['莉音'] });

    const moon = await searchNovel(novelDir, '月', { maxResultsPerCategory: 20 });
    const types = new Set(moon.map((item) => item.type));
    for (const type of ['chapter_content', 'chapter_name', 'character', 'asset', 'world_lore', 'world_place', 'timeline_event']) {
      assert.equal(types.has(type), true, 'missing search category: ' + type);
    }
    const fullWidth = await searchNovel(novelDir, 'AB12', { categories: ['chapters'] });
    const contentHit = fullWidth.find((item) => item.type === 'chapter_content');
    assert.ok(contentHit);
    assert.equal(contentHit.target.chapterFileName, 'chapter-001.md');
    assert.equal(Number.isInteger(contentHit.target.startOffset), true);
    assert.equal(Number.isInteger(contentHit.target.endOffset), true);
    console.log('EDITOR-T06 passed: full-text search covers all novel resource categories and NFKC full-width chapter matches with offsets.');
  } finally {
    if (previousRoot == null) delete process.env.MANA_USER_DATA_ROOT;
    else process.env.MANA_USER_DATA_ROOT = previousRoot;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

if (require.main === module) run().catch((error) => { console.error(error); process.exitCode = 1; });
module.exports = { run };
