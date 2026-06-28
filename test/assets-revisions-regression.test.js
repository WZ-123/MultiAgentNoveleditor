'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');
const assert = require('node:assert');

async function run() {
  const ROOT = path.resolve(__dirname, '..');
  process.env.MANA_USER_DATA_ROOT = process.env.MANA_USER_DATA_ROOT || path.join(ROOT, 'tmp-test-assets-revisions-userdata');
  const novelData = require(path.join(ROOT, 'src/main/store/novelData'));
  const { novelPaths, ensureNovelLayout } = require(path.join(ROOT, 'src/main/store/paths'));
  const searchEngine = require(path.join(ROOT, 'src/main/search/searchEngine'));

  const results = { total: 0, passed: 0, failed: 0 };
  function pass(name, detail) {
    results.total += 1;
    results.passed += 1;
    console.log(`TEST_PASS ${name}${detail ? ': ' + detail : ''}`);
  }
  function fail(name, reason) {
    results.total += 1;
    results.failed += 1;
    console.log(`TEST_FAIL ${name}: ${reason}`);
  }

  const tmpRoot = path.join(ROOT, 'tmp-test-assets-revisions');
  await fs.rm(tmpRoot, { recursive: true, force: true });
  await fs.mkdir(tmpRoot, { recursive: true });
  const novelDir = path.join(tmpRoot, 'novel');
  const np = ensureNovelLayout(novelDir);

  try {
    await fs.writeFile(np.assetsMain, JSON.stringify({
      schemaVersion: 1,
      assets: [{
        id: 'moon-key',
        name: '月钥',
        type: '钥匙',
        description: '能打开月门的关键物品',
        exclusive: true,
        grantedTo: [{ charId: 'hero', at: '2026-01-01T00:00:00.000Z', note: '初始持有' }],
      }],
    }, null, 2), 'utf8');

    const migrated = await novelData.listAssets(novelDir);
    const itemPath = path.join(novelPaths(novelDir).assetItems, 'moon-key.json');
    const itemExists = !!(await fs.stat(itemPath).catch(() => null));
    assert.equal(migrated.length, 1);
    assert.equal(migrated[0].schemaVersion, 2);
    assert.equal(itemExists, true);
    pass('AR1_asset_legacy_index_migrates_to_item_files', 'legacy assets.json migrated to assets/items');

    const baseGrantedTo = migrated[0].grantedTo;
    await novelData.grantAsset(novelDir, {
      assetId: 'moon-key',
      charId: 'sidekick',
      baseGrantedTo,
      at: '2026-01-02T00:00:00.000Z',
      note: '临时交接',
    });
    let staleError = null;
    try {
      await novelData.revokeAsset(novelDir, {
        assetId: 'moon-key',
        charId: 'hero',
        baseGrantedTo,
      });
    } catch (err) {
      staleError = err;
    }
    assert.match(String(staleError?.message || ''), /snapshot mismatch/i);
    pass('AR2_asset_grant_rejects_stale_snapshot', 'baseGrantedTo protects asset grants');

    await novelData.writeChapterWithMeta(novelDir, 'chapter-001.md', '# 第一章\n\n旧正文', { title: '第一章' });
    await novelData.createChapterRevision(novelDir, 'chapter-001.md', '# 第一章\n\n旧正文', { title: '第一章' }, {
      source: 'manual',
      revisionLabel: '初始版本',
    });
    await novelData.writeChapterWithMeta(novelDir, 'chapter-001.md', '# 第一章\n\n新正文', { title: '第一章' }, { baseContent: '# 第一章\n\n旧正文' });
    await novelData.createChapterRevision(novelDir, 'chapter-001.md', '# 第一章\n\n新正文', { title: '第一章' }, {
      source: 'manual',
      revisionLabel: '新版本',
    });
    const revisions = await novelData.listChapterRevisions(novelDir, 'chapter-001.md');
    assert.ok(revisions.length >= 2);
    const older = revisions.find((revision) => revision.label === '初始版本');
    const readOlder = await novelData.readChapterRevision(novelDir, 'chapter-001.md', older.id);
    assert.match(readOlder.content, /旧正文/);
    const restored = await novelData.restoreChapterRevision(novelDir, 'chapter-001.md', older.id);
    assert.match(restored.content, /旧正文/);
    assert.match(await novelData.readChapter(novelDir, 'chapter-001.md'), /旧正文/);
    pass('AR3_chapter_revisions_roundtrip_and_restore', 'revision list/read/restore works');

    const searchResults = await searchEngine.searchNovel(novelDir, '月钥', { categories: ['assets'] });
    assert.equal(searchResults.some((result) => result.type === 'asset' && result.target.assetId === 'moon-key'), true);
    pass('AR4_asset_search_returns_asset_targets', 'asset search finds migrated assets');
  } catch (err) {
    fail('AR_harness', err?.stack || String(err));
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  }

  console.log('');
  console.log(`TEST_SUMMARY ${results.passed}/${results.total} passed, ${results.failed} failed`);
  console.log('TEST_DONE');
  return results;
}

if (require.main === module) {
  run().then((results) => {
    process.exit(results.failed > 0 ? 1 : 0);
  }).catch((err) => {
    console.error('TEST_FAIL harness_error:', err?.stack || String(err));
    process.exit(1);
  });
}

module.exports = { runAssetsRevisionsRegression: run };
