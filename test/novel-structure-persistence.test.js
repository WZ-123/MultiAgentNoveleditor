'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

(async () => {
  const { serializeNovelStructure, restoreNovelStructure, chapterLocationMetadata } = await import('../src/components/novelStructure.mjs');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mana-structure-'));
  const flatten = volumes => volumes.flatMap(v => v.sections.flatMap(s => s.chapters));
  const novel = { volumes: [
    { id: 'v1', name: '同名卷', sections: [{ id: 's1', name: '同名节', chapters: [] }, { id: 's2', name: '同名节', chapters: [] }] },
    { id: 'v2', name: '同名卷', sections: [{ id: 's3', name: '同名节', chapters: [] }] },
    { id: 'v3', name: '空卷', sections: [] },
  ] };
  const diskChapters = [];
  async function saveAndReopen(tree) {
    await fs.writeFile(path.join(dir, 'novel.json'), JSON.stringify({ structure: serializeNovelStructure(tree) }));
    const { structure } = JSON.parse(await fs.readFile(path.join(dir, 'novel.json'), 'utf8'));
    // Simulate disk API returning chapters rather than retaining renderer objects.
    const chapters = await Promise.all(diskChapters.map(async chapter => ({ ...chapter, content: await fs.readFile(path.join(dir, chapter.fileName), 'utf8') })));
    return { volumes: restoreNovelStructure(structure, chapters) };
  }
  async function create(tree, vi, si, fileName, content) {
    const volume = tree.volumes[vi], section = volume.sections[si];
    const chapter = { id: fileName, fileName, _title: '重复标题', content, ...chapterLocationMetadata(tree, volume.id, section.id) };
    section.chapters.push(chapter);
    diskChapters.push(chapter);
    await fs.writeFile(path.join(dir, fileName), content);
  }
  try {
    let reopened = await saveAndReopen(novel);
    assert.deepEqual(reopened, novel, 'empty sections and volumes survive before any chapters exist');
    await create(reopened, 0, 1, 'chapter-001.md', '第一章正文');
    reopened = await saveAndReopen(reopened);
    assert.equal(reopened.volumes[0].sections[0].chapters.length, 0);
    assert.equal(reopened.volumes[0].sections[1].chapters[0].fileName, 'chapter-001.md');
    await create(reopened, 1, 0, 'chapter-002.md', '第二章正文');
    reopened.volumes[0].name = '重命名卷';
    reopened.volumes[0].sections[1].name = '重命名节';
    reopened.volumes[0].sections[1].chapters[0]._title = '新标题';
    // Structure membership remains authoritative if indices become stale.
    diskChapters[0].volume = 2;
    diskChapters[0].section = 1;
    reopened = await saveAndReopen(reopened);
    assert.equal(reopened.volumes[0].sections[1].chapters[0].fileName, 'chapter-001.md');
    assert.equal(reopened.volumes[1].sections[0].chapters[0].fileName, 'chapter-002.md');
    assert.equal(reopened.volumes[0].name, '重命名卷');
    assert.equal(reopened.volumes[0].sections[1].name, '重命名节');
    assert.equal(reopened.volumes[2].sections.length, 0);
    assert.deepEqual(flatten(reopened.volumes).map(ch => ch.content), ['第一章正文', '第二章正文']);
    const legacy = { volumes: [{ name: '旧卷', sections: [{ name: '空节' }, { name: '目标节' }] }] };
    const migrated = restoreNovelStructure(legacy, [
      { fileName: 'located.md', volume: '1', section: '2', content: 'preserve A' },
      { fileName: 'unknown.md', content: 'preserve B' },
      { fileName: 'invalid.md', volume: 99, section: -1, content: 'preserve C' },
    ]);
    assert.equal(migrated[0].sections[0].chapters.length, 0);
    assert.equal(migrated[0].sections[1].chapters[0].fileName, 'located.md');
    assert.deepEqual(migrated[0].sections[2].chapters.map(ch => ch.fileName), ['unknown.md', 'invalid.md']);
    assert.deepEqual(restoreNovelStructure(serializeNovelStructure({ volumes: migrated }), flatten(migrated)), migrated);
    const malformed = serializeNovelStructure(reopened);
    malformed.volumes[0].sections[0].chapterFiles = ['chapter-001.md', 'missing.md'];
    const restored = restoreNovelStructure(malformed, [...diskChapters, diskChapters[0]]);
    assert.equal(flatten(restored).length, 2, 'duplicate references never duplicate or lose disk files');
    const external = restoreNovelStructure(serializeNovelStructure(reopened), [...diskChapters, { fileName: 'external.md' }]);
    assert.equal(flatten(external).length, 3);
    assert.equal(external[0].sections[0].chapters.length, 0);
    assert.equal(restoreNovelStructure(null, [{ fileName: 'flat.md' }])[0].sections[0].chapters.length, 1);
    assert.deepEqual(restoreNovelStructure({ volumes: [] }, []), []);
    assert.throws(() => chapterLocationMetadata(novel, 'missing', 's1'), /destination/);
    console.log('novel structure persistence: ok (disk round trips, empty groups, duplicate titles, legacy recovery, no loss)');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
