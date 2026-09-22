'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');

function chapter(id, fileName, content = '') {
  return { id, fileName, content, displayName: fileName };
}

function countFile(novel, fileName) {
  return novel.volumes
    .flatMap((volume) => volume.sections)
    .flatMap((section) => section.chapters)
    .filter((item) => item.fileName === fileName).length;
}

async function run() {
  const moduleUrl = pathToFileURL(path.join(ROOT, 'src/components/chapterTreeSync.mjs')).href;
  const { mergeChapterIntoNovelTree } = await import(moduleUrl);

  const initial = {
    volumes: [{
      id: 'volume-1',
      sections: [{
        id: 'section-1',
        chapters: [
          chapter('chapter-1', 'chapter-001.md'),
          chapter('chapter-2', 'chapter-002.md'),
        ],
      }],
    }],
  };
  const firstPush = mergeChapterIntoNovelTree(initial, {
    ...chapter('event-copy-1', 'chapter-003.md', '第三章正文'),
    displayName: '第3章：领人',
    volume: 1,
    section: 1,
  });
  const duplicatePush = mergeChapterIntoNovelTree(firstPush, {
    ...chapter('event-copy-2', 'chapter-003.md', '第三章正文'),
    displayName: '第3章：领人',
    volume: 1,
    section: 1,
  });

  assert.equal(countFile(duplicatePush, 'chapter-003.md'), 1);
  assert.equal(duplicatePush.volumes[0].sections[0].chapters.length, 3);
  assert.equal(duplicatePush.volumes[0].sections[0].chapters[2].id, 'event-copy-1');
  assert.equal(duplicatePush.volumes[0].sections[0].chapters[2].content, '第三章正文');
  console.log('TEST_PASS duplicate-chapter-change-events-are-idempotent');

  const alreadyDuplicated = {
    volumes: [{
      id: 'volume-1',
      sections: [{
        id: 'section-1',
        chapters: [
          chapter('chapter-3-original', 'chapter-003.md', '旧正文'),
          chapter('chapter-3-duplicate', 'chapter-003.md', '旧正文'),
        ],
      }],
    }],
  };
  const repaired = mergeChapterIntoNovelTree(
    alreadyDuplicated,
    chapter('event-copy-3', 'chapter-003.md', '更新正文')
  );
  assert.equal(countFile(repaired, 'chapter-003.md'), 1);
  assert.equal(repaired.volumes[0].sections[0].chapters[0].id, 'chapter-3-original');
  assert.equal(repaired.volumes[0].sections[0].chapters[0].content, '更新正文');
  console.log('TEST_PASS existing-duplicate-tree-entry-is-collapsed-on-sync');

  const multiSection = {
    volumes: [
      { id: 'volume-1', sections: [{ id: 'section-1-1', chapters: [] }] },
      {
        id: 'volume-2',
        sections: [
          { id: 'section-2-1', chapters: [] },
          { id: 'section-2-2', chapters: [] },
        ],
      },
    ],
  };
  const targeted = mergeChapterIntoNovelTree(multiSection, {
    ...chapter('chapter-targeted', 'chapter-010.md'),
    volume: 2,
    section: 2,
  });
  assert.equal(targeted.volumes[0].sections[0].chapters.length, 0);
  assert.equal(targeted.volumes[1].sections[0].chapters.length, 0);
  assert.deepEqual(
    targeted.volumes[1].sections[1].chapters.map((item) => item.fileName),
    ['chapter-010.md']
  );
  console.log('TEST_PASS new-chapter-is-inserted-into-only-one-target-section');

  console.log('TEST_PASS chapter-tree-sync-regression');
}

if (require.main === module) {
  run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { run };
