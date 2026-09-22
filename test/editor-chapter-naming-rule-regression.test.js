'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mana-editor-naming-rule-'));
  const previousRoot = process.env.MANA_USER_DATA_ROOT;
  process.env.MANA_USER_DATA_ROOT = path.join(root, 'user-data');
  try {
    const novels = require('../src/main/store/novels');
    const data = require('../src/main/store/novelData');
    const novel = await novels.createNovel({ title: '命名规则小说', dir: path.join(root, 'novel') });
    await data.writeChapter(novel.dir, 'chapter-001.md', '# 雨夜\n\n正文');
    await data.writeChapter(novel.dir, 'chapter-002.md', '# 清晨\n\n正文');
    const beforeFiles = (await data.listChapters(novel.dir)).map((chapter) => chapter.name);
    await novels.setChapterNamingRule(novel.id, 'Chapter {n}', ' - ');
    const rule = await novels.getChapterNamingRule(novel.id);
    const displays = await data.listChaptersWithDisplay(novel.dir);
    assert.deepEqual(rule, { rule: 'Chapter {n}', separator: ' - ' });
    assert.deepEqual(displays.map((chapter) => chapter.displayName), ['Chapter 1 - 雨夜', 'Chapter 2 - 清晨']);
    assert.deepEqual((await data.listChapters(novel.dir)).map((chapter) => chapter.name), beforeFiles);
    console.log('EDITOR-T08 passed: changing a naming rule recomputes every display name without renaming chapter files.');
  } finally {
    if (previousRoot == null) delete process.env.MANA_USER_DATA_ROOT;
    else process.env.MANA_USER_DATA_ROOT = previousRoot;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

if (require.main === module) run().catch((error) => { console.error(error); process.exitCode = 1; });
module.exports = { run };
