'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');

async function runCharacterContextIndexRegressionTest() {
  const ROOT = path.resolve(__dirname, '..');
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

  const novelData = require(path.join(ROOT, 'src/main/store/novelData'));
  const { novelPaths } = require(path.join(ROOT, 'src/main/store/paths'));
  const { getToolByName } = require(path.join(ROOT, 'src/main/mcp/tools'));
  const novelDir = path.join(ROOT, 'tmp-test-character-context-index');

  try {
    await fs.rm(novelDir, { recursive: true, force: true });
    const np = novelPaths(novelDir);

    const longBackground = `完整背景开头：楚岚曾在旧案里失去线索。${'漫长背景。'.repeat(700)}完整背景结尾：他仍然记得阿宁的暗号。`;
    await novelData.writeCharacter(novelDir, {
      id: 'hero',
      name: '楚岚',
      role: '主角',
      faction: '调查组',
      personality: '克制，先确认事实再行动。',
      appearance: '黑发，深色外套，夜里常压低帽檐。',
      background: longBackground,
      relationships: { ally: '阿宁是他信任但不完全坦白的同伴。' },
      storyArc: '从自保转向主动承担风险。',
      skins: [{ name: '夜行衣', appearance: '黑色短外套，便于翻越天台。', story: '旧案追查时期常穿。' }],
    });
    await novelData.writeCharacter(novelDir, {
      id: 'ally',
      name: '阿宁',
      role: '搭档',
      personality: '敏锐，习惯用反问试探。',
      appearance: '短发，浅色风衣。',
    });

    const indexOnDisk = JSON.parse(await fs.readFile(np.charactersIndex, 'utf8'));
    assert.equal(indexOnDisk.characters.length, 2);
    assert.ok(indexOnDisk.characters.some((character) => character.id === 'hero' && character.summary.includes('克制')));
    pass('CCI1_character_index_is_written_for_character_files', 'writeCharacter keeps .mana/characters-index.json in sync');

    const listTool = getToolByName('list_characters');
    const listResult = await listTool.handler({}, { novelDir });
    const listPayload = JSON.parse(listResult.content[0].text);
    const listedHero = listPayload.characters.find((character) => character.id === 'hero');
    assert.ok(listedHero);
    assert.ok(listedHero.summary);
    assert.equal(Object.prototype.hasOwnProperty.call(listedHero, 'background'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(listedHero, 'relationships'), false);
    pass('CCI2_list_characters_returns_lightweight_index', 'MCP list_characters no longer returns full cards');

    const heroFile = path.join(np.characters, 'hero.json');
    const heroRaw = JSON.parse(await fs.readFile(heroFile, 'utf8'));
    heroRaw.personality = '手工改动后的克制，遇到旧案会更果断。';
    await new Promise((resolve) => setTimeout(resolve, 5));
    await fs.writeFile(heroFile, JSON.stringify(heroRaw, null, 2), 'utf8');
    const rebuiltIndex = await novelData.listCharacterIndex(novelDir);
    const rebuiltHero = rebuiltIndex.find((character) => character.id === 'hero');
    assert.ok(rebuiltHero.summary.includes('手工改动后的克制'));
    pass('CCI2b_character_index_rebuilds_after_manual_file_edit', 'mtime check prevents stale character index summaries');

    await novelData.writeOutlineNodes(novelDir, [
      {
        id: 'scene-hero',
        title: '天台暗号',
        summary: '楚岚按阿宁留下的暗号追到天台。',
        characters: ['hero'],
        outfit: '夜行衣',
        needBackground: true,
        setting: '夜晚',
        location: '天台',
        pov: 'hero',
        chapterIndex: 3,
      },
      {
        id: 'scene-pov-added',
        title: '双线会合',
        characters: ['ally', 'missing-support'],
        pov: 'hero',
        chapterIndex: 4,
      },
      {
        id: 'scene-pov-missing',
        title: '失联视角',
        characters: ['hero'],
        pov: 'missing-pov',
        chapterIndex: 5,
      },
    ]);

    const sceneTool = getToolByName('assemble_scene_context');
    const sceneResult = await sceneTool.handler({ nodeId: 'scene-hero' }, { novelDir });
    const scenePayload = JSON.parse(sceneResult.content[0].text);
    assert.equal(scenePayload.characters.length, 1);
    const heroContext = scenePayload.characters[0];
    assert.equal(heroContext.contextMode, 'full_writing_context');
    assert.equal(heroContext.sourceRef, 'character:hero');
    assert.ok(heroContext.background.includes('[Context trimmed for model]'));
    assert.ok(heroContext.background.includes('完整背景开头'));
    assert.ok(heroContext.background.includes('完整背景结尾'));
    assert.ok(Array.isArray(heroContext.skins));
    assert.equal(heroContext.currentOutfit, '夜行衣');
    assert.ok(Array.isArray(heroContext.omittedFields));
    assert.deepEqual(scenePayload.unresolvedCharacterRefs, []);
    assert.equal(scenePayload.povResolved, true);
    pass('CCI3_scene_context_uses_full_budgeted_involved_character_context', 'scene assembly gives involved character full writing context with traceable trimming');

    const povAddedResult = await sceneTool.handler({ nodeId: 'scene-pov-added' }, { novelDir });
    const povAddedPayload = JSON.parse(povAddedResult.content[0].text);
    assert.deepEqual(povAddedPayload.characters.map((character) => character.id), ['ally', 'hero']);
    assert.deepEqual(povAddedPayload.unresolvedCharacterRefs, ['missing-support']);
    assert.equal(povAddedPayload.pov, 'hero');
    assert.equal(povAddedPayload.povResolved, true);
    pass('CCI3b_scene_context_merges_pov_and_reports_missing_characters', 'POV gets full context even when absent from characters, while unresolved refs remain visible');

    const povMissingResult = await sceneTool.handler({ nodeId: 'scene-pov-missing' }, { novelDir });
    const povMissingPayload = JSON.parse(povMissingResult.content[0].text);
    assert.deepEqual(povMissingPayload.characters.map((character) => character.id), ['hero']);
    assert.deepEqual(povMissingPayload.unresolvedCharacterRefs, ['missing-pov']);
    assert.equal(povMissingPayload.pov, 'missing-pov');
    assert.equal(povMissingPayload.povResolved, false);
    pass('CCI3c_scene_context_exposes_unresolved_pov', 'missing POV is reported instead of being silently dropped');

    const deleted = await novelData.deleteCharacter(novelDir, 'ally');
    assert.equal(deleted.id, 'ally');
    const indexAfterDelete = await novelData.listCharacterIndex(novelDir);
    assert.equal(indexAfterDelete.some((character) => character.id === 'ally'), false);
    pass('CCI4_character_index_removes_deleted_characters', 'deleteCharacter syncs the lightweight index');
  } catch (err) {
    fail('CCI_harness', err?.stack || String(err));
  } finally {
    await fs.rm(novelDir, { recursive: true, force: true });
  }

  console.log('');
  console.log(`TEST_SUMMARY ${results.passed}/${results.total} passed, ${results.failed} failed`);
  console.log('TEST_DONE');
  return results;
}

module.exports = { runCharacterContextIndexRegressionTest };

if (require.main === module) {
  runCharacterContextIndexRegressionTest().then((results) => {
    if (results.failed > 0) process.exitCode = 1;
  }).catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
