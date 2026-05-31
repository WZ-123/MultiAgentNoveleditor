'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');
const assert = require('node:assert/strict');

async function runToolHardeningRegressionTest() {
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

  const ROOT = path.resolve(__dirname, '..');
  const novelData = require(path.join(ROOT, 'src/main/store/novelData'));
  const { getToolByName } = require(path.join(ROOT, 'src/main/mcp/tools'));
  const tmpRoot = path.join(ROOT, 'tmp-test-tool-hardening');
  const novelDir = path.join(tmpRoot, 'novel-' + Date.now());

  try {
    await fs.rm(tmpRoot, { recursive: true, force: true });
    await fs.mkdir(novelDir, { recursive: true });

    const updateCharacterTool = getToolByName('update_character');
    assert.ok(updateCharacterTool);
    await novelData.writeCharacter(novelDir, {
      id: 'shinano',
      name: '信浓',
      attributes: {
        瞳色: '蓝紫色',
        发色: '银白色',
        口癖: '妾身',
      },
      relationships: {
        commander: { type: '依赖', description: '常在梦里呼唤指挥官。' },
        kaga: { type: '同伴', description: '同属重樱阵营。' },
      },
      arc: {
        status: '沉睡',
        beats: { start: '沉睡', end: '苏醒' },
      },
    });

    const updateCharacterResult = await updateCharacterTool.handler(
      {
        id: 'shinano',
        patch: {
          attributes: { 瞳色: '紫金色', __delete: ['口癖'] },
          relationships: {
            commander: { description: '仍会依赖指挥官，但语气更克制。' },
            __delete: ['kaga'],
          },
          arc: { beats: { end: '主动醒来' } },
        },
      },
      { novelDir, novel: { id: 'novel-hardening' } }
    );
    const updateCharacterPayload = JSON.parse(updateCharacterResult.content[0].text);
    const updatedCharacter = await novelData.readCharacter(novelDir, 'shinano');

    assert.equal(updateCharacterTool.requiresConfirmation, true);
    assert.equal(updateCharacterPayload.ok, true);
    assert.equal(updatedCharacter.attributes?.瞳色, '紫金色');
    assert.equal(updatedCharacter.attributes?.发色, '银白色');
    assert.equal(Object.prototype.hasOwnProperty.call(updatedCharacter.attributes || {}, '口癖'), false);
    assert.equal(updatedCharacter.relationships?.commander?.type, '依赖');
    assert.equal(updatedCharacter.relationships?.commander?.description, '仍会依赖指挥官，但语气更克制。');
    assert.equal(Object.prototype.hasOwnProperty.call(updatedCharacter.relationships || {}, 'kaga'), false);
    assert.equal(updatedCharacter.arc?.status, '沉睡');
    assert.equal(updatedCharacter.arc?.beats?.start, '沉睡');
    assert.equal(updatedCharacter.arc?.beats?.end, '主动醒来');
    pass('TH1_update_character_deep_merges_nested_patch', 'nested objects keep untouched keys while patch updates and __delete removals both apply');

    const deleteCharacterTool = getToolByName('delete_character');
    assert.ok(deleteCharacterTool);
    assert.equal(deleteCharacterTool.requiresConfirmation, true);
    await novelData.writeCharacter(novelDir, {
      id: 'trash-role',
      name: '误识别片段',
      role: '应删除',
    });
    const deleteCharacterResult = await deleteCharacterTool.handler(
      { characterId: 'trash-role' },
      { novelDir, novel: { id: 'novel-hardening' } }
    );
    const deleteCharacterPayload = JSON.parse(deleteCharacterResult.content[0].text);
    const deletedCharacter = await novelData.readCharacter(novelDir, 'trash-role');

    assert.equal(deleteCharacterPayload.ok, true);
    assert.equal(deleteCharacterPayload.deleted.id, 'trash-role');
    assert.equal(deletedCharacter, null);
    let missingCharacterError = null;
    try {
      await deleteCharacterTool.handler(
        { id: 'trash-role' },
        { novelDir, novel: { id: 'novel-hardening' } }
      );
    } catch (err) {
      missingCharacterError = err;
    }
    assert.match(String(missingCharacterError?.message || ''), /character not found: trash-role/);
    pass('TH1b_delete_character_removes_existing_card_only', 'delete_character removes one card, requires confirmation, and rejects missing ids');

    const np = require(path.join(ROOT, 'src/main/store/paths')).novelPaths(novelDir);
    await fs.mkdir(np.characters, { recursive: true });
    const legacyFile = path.join(np.characters, 'char-legacy-import.json');
    await fs.writeFile(legacyFile, JSON.stringify({
      schemaVersion: 1,
      id: '和少妇',
      name: '和少妇',
      role: '',
    }, null, 2), 'utf8');
    const listedLegacy = await novelData.listCharacters(novelDir);
    assert.equal(listedLegacy.some((ch) => ch.id === '和少妇'), true);
    const deleteLegacyResult = await deleteCharacterTool.handler(
      { id: '和少妇' },
      { novelDir, novel: { id: 'novel-hardening' } }
    );
    const deleteLegacyPayload = JSON.parse(deleteLegacyResult.content[0].text);
    let legacyStillExists = true;
    try {
      await fs.access(legacyFile);
    } catch {
      legacyStillExists = false;
    }
    assert.equal(deleteLegacyPayload.ok, true);
    assert.equal(deleteLegacyPayload.deleted.id, '和少妇');
    assert.equal(legacyStillExists, false);
    pass('TH1c_delete_character_resolves_listed_id_when_filename_differs', 'delete_character can delete legacy/imported cards whose JSON id differs from the filename');

    const applyWorldPatchTool = getToolByName('apply_world_patch');
    assert.ok(applyWorldPatchTool);
    const seedWorld = {
      lore: '海雾港终年被海雾包围。\n\n旧钟楼立在港口尽头。',
      places: [
        { name: '海雾港', type: '港口', description: '常年被雾包围。' },
        { name: '旧钟楼', type: '地标', description: '塔身斑驳。' },
        { name: '旧码头', type: '港区', description: '如今已经废弃。' },
      ],
    };
    await novelData.writeWorld(novelDir, seedWorld);
    const worldPatchResult = await applyWorldPatchTool.handler(
      {
        baseLore: seedWorld.lore,
        basePlaces: seedWorld.places,
        loreEdits: [
          {
            targetText: '旧钟楼立在港口尽头。',
            replacement: '旧钟楼立在港口北侧的断崖边。',
            beforeContext: '海雾港终年被海雾包围。',
          },
        ],
        placeUpserts: [
          { matchName: '旧钟楼', description: '塔身斑驳，顶层钟面停在四点十七分。' },
          { name: '潮汐档案馆', type: '建筑', description: '收藏着历年航海日志。' },
        ],
        placeDeletes: ['旧码头'],
      },
      { novelDir, novel: { id: 'novel-hardening' } }
    );
    const worldPatchPayload = JSON.parse(worldPatchResult.content[0].text);
    const patchedWorld = await novelData.readWorld(novelDir);
    const clocktower = patchedWorld.places.find((place) => place.name === '旧钟楼');

    assert.equal(worldPatchPayload.ok, true);
    assert.equal(worldPatchPayload.loreChanged, true);
    assert.equal(worldPatchPayload.loreEditCount, 1);
    assert.ok(worldPatchPayload.upsertedPlaceNames.includes('旧钟楼'));
    assert.ok(worldPatchPayload.upsertedPlaceNames.includes('潮汐档案馆'));
    assert.ok(worldPatchPayload.deletedPlaceNames.includes('旧码头'));
    assert.ok(patchedWorld.lore.includes('旧钟楼立在港口北侧的断崖边。'));
    assert.equal(patchedWorld.lore.includes('旧钟楼立在港口尽头。'), false);
    assert.equal(clocktower?.type, '地标');
    assert.equal(clocktower?.description, '塔身斑驳，顶层钟面停在四点十七分。');
    assert.ok(patchedWorld.places.some((place) => place.name === '潮汐档案馆'));
    assert.equal(patchedWorld.places.some((place) => place.name === '旧码头'), false);
    pass('TH2_apply_world_patch_updates_lore_and_places_incrementally', 'world lore edits and place upserts/deletes were applied against one shared snapshot');

    const staleWorldBase = await novelData.readWorld(novelDir);
    await novelData.writeWorld(novelDir, {
      lore: `${patchedWorld.lore}\n\n潮汐会在午夜倒灌进石阶。`,
      places: patchedWorld.places,
    });
    let staleWorldError = null;
    try {
      await applyWorldPatchTool.handler(
        {
          baseLore: staleWorldBase.lore,
          basePlaces: staleWorldBase.places,
          loreEdits: [{ targetText: '海雾港', replacement: '海雾城' }],
        },
        { novelDir, novel: { id: 'novel-hardening' } }
      );
    } catch (err) {
      staleWorldError = err;
    }
    const worldAfterStaleReject = await novelData.readWorld(novelDir);

    assert.match(String(staleWorldError?.message || ''), /snapshot mismatch/i);
    assert.ok(worldAfterStaleReject.lore.includes('午夜倒灌进石阶'));
    pass('TH3_apply_world_patch_rejects_stale_world_snapshot', 'world patches from an outdated base snapshot are refused before writing');

    const updateWorldTool = getToolByName('update_world');
    assert.ok(updateWorldTool);
    let staleUpdateWorldError = null;
    try {
      await updateWorldTool.handler(
        {
          lore: '# 全量覆盖后的世界观',
          baseLore: staleWorldBase.lore,
          basePlaces: staleWorldBase.places,
        },
        { novelDir, novel: { id: 'novel-hardening' } }
      );
    } catch (err) {
      staleUpdateWorldError = err;
    }
    assert.match(String(staleUpdateWorldError?.message || ''), /snapshot mismatch/i);
    pass('TH4_update_world_bulk_replace_can_guard_against_stale_snapshot', 'bulk world replacement now rejects stale snapshots instead of overwriting newer world data');

    const writeChapterTool = getToolByName('write_chapter');
    assert.ok(writeChapterTool);
    assert.equal(writeChapterTool.requiresConfirmation, true);
    await novelData.writeChapterWithMeta(novelDir, 'chapter-001.md', '第一版正文', { title: '第一章' });

    const writeChapterOkResult = await writeChapterTool.handler(
      {
        name: 'chapter-001.md',
        content: '第二版正文',
        title: '第一章',
        baseContent: '第一版正文',
      },
      { novelDir, novel: { id: 'novel-hardening' } }
    );
    const writeChapterOkPayload = JSON.parse(writeChapterOkResult.content[0].text);
    assert.equal(writeChapterOkPayload.ok, true);
    assert.equal(await novelData.readChapter(novelDir, 'chapter-001.md'), '第二版正文');

    await novelData.writeChapterWithMeta(novelDir, 'chapter-001.md', '第三版正文', { title: '第一章' });
    let staleChapterError = null;
    try {
      await writeChapterTool.handler(
        {
          name: 'chapter-001.md',
          content: '第四版正文',
          title: '第一章',
          baseContent: '第二版正文',
        },
        { novelDir, novel: { id: 'novel-hardening' } }
      );
    } catch (err) {
      staleChapterError = err;
    }
    assert.match(String(staleChapterError?.message || ''), /snapshot mismatch/i);
    assert.equal(await novelData.readChapter(novelDir, 'chapter-001.md'), '第三版正文');
    pass('TH5_write_chapter_rejects_stale_base_content', 'write_chapter now refuses to overwrite a chapter when baseContent no longer matches');

    const applyAssetPatchTool = getToolByName('apply_asset_patch');
    const grantAssetTool = getToolByName('grant_asset');
    assert.ok(applyAssetPatchTool);
    assert.ok(grantAssetTool);
    assert.equal(applyAssetPatchTool.requiresConfirmation, false);

    const sealGrantedTo = [
      { charId: 'akagi', chapterRef: '第1章', at: '2026-01-01T00:00:00.000Z', note: '初始持有' },
    ];
    const compassGrantedTo = [];
    await novelData.upsertAsset(novelDir, {
      id: 'naval-seal',
      name: '重樱军印',
      grantedTo: sealGrantedTo,
    });
    await novelData.upsertAsset(novelDir, {
      id: 'star-compass',
      name: '星盘罗盘',
      grantedTo: compassGrantedTo,
    });

    const assetPatchResult = await applyAssetPatchTool.handler(
      {
        edits: [
          {
            assetId: 'naval-seal',
            baseGrantedTo: sealGrantedTo,
            operations: [
              { action: 'grant', charId: 'kaga', chapterRef: '第3章', note: '军印临时交接', at: '2026-01-03T00:00:00.000Z' },
              { action: 'revoke', charId: 'akagi', chapterRef: '第4章', note: '收回军印', at: '2026-01-04T00:00:00.000Z' },
            ],
          },
          {
            assetId: 'star-compass',
            baseGrantedTo: compassGrantedTo,
            operations: [
              { action: 'grant', charId: 'shinano', chapterRef: '第4章', note: '借出星盘', at: '2026-01-04T00:00:00.000Z' },
            ],
          },
        ],
      },
      { novelDir, novel: { id: 'novel-hardening' } }
    );
    const assetPatchPayload = JSON.parse(assetPatchResult.content[0].text);
    const patchedSeal = await novelData.readAsset(novelDir, 'naval-seal');
    const patchedCompass = await novelData.readAsset(novelDir, 'star-compass');

    assert.equal(assetPatchPayload.ok, true);
    assert.equal(assetPatchPayload.assetCount, 2);
    assert.equal(assetPatchPayload.operationCount, 3);
    assert.ok(assetPatchPayload.assetIds.includes('naval-seal'));
    assert.ok(assetPatchPayload.assetIds.includes('star-compass'));
    assert.equal(patchedSeal.grantedTo.some((entry) => entry.charId === 'kaga' && entry.revoked !== true), true);
    assert.equal(patchedSeal.grantedTo.some((entry) => entry.charId === 'akagi' && entry.revoked !== true), false);
    assert.equal(patchedSeal.grantedTo.some((entry) => entry.charId === 'akagi' && entry.revoked === true), true);
    assert.equal(patchedCompass.grantedTo.some((entry) => entry.charId === 'shinano' && entry.revoked !== true), true);
    pass('TH6_apply_asset_patch_batches_authorization_changes', 'batch asset authorization edits apply against per-asset snapshots and write once');

    const staleSealSnapshot = patchedSeal.grantedTo;
    await novelData.grantAsset(novelDir, {
      assetId: 'naval-seal',
      charId: 'amagi',
      chapterRef: '第5章',
      note: '追加借出',
      at: '2026-01-05T00:00:00.000Z',
    });
    let staleGrantError = null;
    try {
      await grantAssetTool.handler(
        {
          assetId: 'naval-seal',
          charId: 'zuikaku',
          chapterRef: '第6章',
          note: '旧快照下的借出',
          baseGrantedTo: staleSealSnapshot,
        },
        { novelDir, novel: { id: 'novel-hardening' } }
      );
    } catch (err) {
      staleGrantError = err;
    }
    const sealAfterStaleReject = await novelData.readAsset(novelDir, 'naval-seal');

    assert.match(String(staleGrantError?.message || ''), /snapshot mismatch/i);
    assert.equal(sealAfterStaleReject.grantedTo.some((entry) => entry.charId === 'zuikaku'), false);
    assert.equal(sealAfterStaleReject.grantedTo.some((entry) => entry.charId === 'amagi' && entry.revoked !== true), true);
    pass('TH7_grant_asset_rejects_stale_base_granted_to', 'single-asset grant writes can now refuse stale authorization snapshots instead of appending onto newer state');

    const queryWorldTool = getToolByName('query_world');
    const readWorldTool = getToolByName('read_world');
    const getSystemTimeTool = getToolByName('get_system_time');
    assert.ok(queryWorldTool);
    assert.ok(readWorldTool);
    assert.ok(getSystemTimeTool);

    const readWorldResult = await readWorldTool.handler({}, { novelDir, novel: { id: 'novel-hardening' } });
    const queryWorldResult = await queryWorldTool.handler({}, { novelDir, novel: { id: 'novel-hardening' } });
    assert.equal(readWorldResult.content[0].text, queryWorldResult.content[0].text);
    pass('TH8_read_world_alias_matches_query_world', 'legacy read_world alias resolves to the same world payload as query_world');

    const systemTimeResult = await getSystemTimeTool.handler({}, { novelDir, novel: { id: 'novel-hardening' } });
    const systemTimePayload = JSON.parse(systemTimeResult.content[0].text);
    assert.equal(typeof systemTimePayload.epochMs, 'number');
    assert.match(String(systemTimePayload.isoLocal || ''), /[+-]\d\d:\d\d$/);
    assert.ok(String(systemTimePayload.timezone || '').length > 0);
    pass('TH9_get_system_time_returns_local_timezone_context', 'time tool returns local system time with timezone offset instead of a GMT-only hint');

    const chatAgentText = await fs.readFile(path.join(ROOT, 'src/main/runtime/chatAgent.js'), 'utf8');
    assert.ok(chatAgentText.includes('apply_world_patch'));
    assert.ok(chatAgentText.includes('baseContent'));
    assert.ok(chatAgentText.includes('apply_asset_patch'));
    assert.ok(chatAgentText.includes('baseGrantedTo'));
    assert.ok(chatAgentText.includes('get_system_time'));
    assert.ok(chatAgentText.includes('read_world (legacy alias)'));
    pass('TH10_chat_rules_expose_hardened_write_tools', 'chat rules mention hardened write flows, world alias, and system-time guidance');
  } catch (err) {
    fail('TH_harness', err && err.stack ? err.stack : String(err));
  } finally {
    try {
      await fs.rm(tmpRoot, { recursive: true, force: true });
    } catch {
      // ignore cleanup failure
    }
  }

  console.log('');
  console.log(`TEST_SUMMARY ${results.passed}/${results.total} passed, ${results.failed} failed`);
  console.log('TEST_DONE');
  return results;
}

module.exports = { runToolHardeningRegressionTest };

if (require.main === module) {
  runToolHardeningRegressionTest().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
