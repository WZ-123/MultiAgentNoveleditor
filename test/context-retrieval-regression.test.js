'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');

async function runContextRetrievalRegressionTest() {
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

  const novelDir = path.join(ROOT, 'tmp-test-context-retrieval');
  const novelData = require(path.join(ROOT, 'src/main/store/novelData'));
  const { retrieveNovelContext } = require(path.join(ROOT, 'src/main/search/contextRetrieval'));
  const { getToolByName } = require(path.join(ROOT, 'src/main/mcp/tools'));

  try {
    await fs.rm(novelDir, { recursive: true, force: true });

    await novelData.writeCharacter(novelDir, {
      id: 'hero',
      name: '楚岚',
      aliases: ['Chu Lan'],
      role: '调查员',
      personality: '克制，遇到阿宁时会短暂停顿。',
      appearance: '黑发，深色外套。',
      background: '曾在旧案里失去关键线索，因此对鹏城天台的暗号格外敏感。',
    });
    await novelData.writeCharacter(novelDir, {
      id: 'ally',
      name: '阿宁',
      role: '情报支点',
      personality: '敏锐，习惯用反问试探。',
    });
    await novelData.writeWorld(novelDir, {
      lore: [
        '鹏城的旧案系统会在午夜后切换到影子档案，只有掌握天台暗号的人能调出隐藏记录。',
        '',
        '调查组不允许在公开频道提及影子档案，违规会触发内部审计。',
      ].join('\n'),
      places: [{
        name: '鹏城天台',
        description: '调查组交换暗号的高处据点，夜晚风很大，适合短暂会面。',
        tags: ['暗号', '夜晚'],
      }],
    });
    await novelData.appendTimelineEvent(novelDir, {
      id: 'evt-3',
      chapterRef: 'chapter-003.md',
      when: '当晚',
      where: '鹏城天台',
      participants: ['楚岚', '阿宁'],
      description: '楚岚和阿宁在天台确认旧案暗号。',
    });
    await novelData.writeOutlineNodes(novelDir, [{
      id: 'scene-3',
      title: '天台暗号',
      summary: '楚岚在鹏城天台与阿宁核对影子档案。',
      characters: ['hero', 'ally'],
      location: '鹏城天台',
      setting: '夜晚',
      chapterIndex: 3,
    }]);

    const result = await retrieveNovelContext(novelDir, {
      query: '本章楚岚和阿宁在鹏城天台核对暗号',
      chapterName: 'chapter-003.md',
      maxItems: 8,
      maxChars: 12000,
    });
    assert.ok(result.items.some((item) => item.sourceRef === 'character:hero'));
    assert.ok(result.items.some((item) => item.type === 'world_lore'));
    assert.ok(result.items.some((item) => item.sourceRef === 'world:place:鹏城天台'));
    assert.ok(result.items.some((item) => item.sourceRef === 'timeline:evt-3'));
    assert.ok(result.contextText.includes('Retrieved Novel Context'));
    assert.equal(new Set(result.items.map((item) => item.sourceRef)).size, result.items.length);
    pass('CR1_retrieves_character_world_place_timeline_context', 'mixed retrieval returned traceable bounded context');

    const normalized = await retrieveNovelContext(novelDir, {
      query: 'Ｃｈｕ　Ｌａｎ 天台',
      chapterName: 'chapter-003.md',
      maxItems: 4,
      maxChars: 12000,
    });
    assert.ok(normalized.items.some((item) => item.sourceRef === 'character:hero'));
    pass('CR2_nfkc_query_matches_aliases', 'fullwidth query matched normalized alias text');

    const bounded = await retrieveNovelContext(novelDir, {
      query: '鹏城天台 暗号 影子档案 楚岚 阿宁',
      chapterName: 'chapter-003.md',
      maxItems: 2,
      maxChars: 900,
    });
    assert.equal(bounded.items.length, 2);
    assert.ok(bounded.contextText.length <= 900 || bounded.contextText.includes('[Context trimmed for model]'));
    pass('CR3_respects_item_and_char_budget', 'retrieval respects maxItems and model char budget');

    const tool = getToolByName('retrieve_context');
    const toolResult = await tool.handler({
      query: '鹏城天台暗号',
      chapterName: 'chapter-003.md',
      maxItems: 5,
    }, { novelDir });
    const payload = JSON.parse(toolResult.content[0].text);
    assert.ok(payload.resultCount > 0);
    assert.ok(payload.contextText.includes('鹏城天台'));
    pass('CR4_mcp_retrieve_context_returns_context_text', 'MCP tool exposes retrieval payload');
  } catch (err) {
    fail('CR_harness', err?.stack || String(err));
  } finally {
    await fs.rm(novelDir, { recursive: true, force: true });
  }

  console.log('');
  console.log(`TEST_SUMMARY ${results.passed}/${results.total} passed, ${results.failed} failed`);
  console.log('TEST_DONE');
  return results;
}

module.exports = { runContextRetrievalRegressionTest };

if (require.main === module) {
  runContextRetrievalRegressionTest().then((results) => {
    if (results.failed > 0) process.exitCode = 1;
  }).catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
