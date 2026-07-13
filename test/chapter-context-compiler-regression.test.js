'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs').promises;
const os = require('node:os');
const path = require('node:path');

const {
  clearChapterContextCache,
  compileChapterContext,
  sceneContractsFromOutline,
} = require('../src/main/runtime/chapterContextCompiler');

function result(value) {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] };
}

async function run() {
  const novelDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mana-context-compiler-'));
  const chaptersDir = path.join(novelDir, 'chapters');
  await fs.mkdir(chaptersDir, { recursive: true });
  await fs.writeFile(path.join(chaptersDir, 'chapter-010.md'), '# 第十章\n\n前文的决定性结尾。', 'utf8');

  const calls = [];
  const callTool = async ({ name, arguments: args }) => {
    calls.push({ name, args });
    if (name === 'list_chapter_displays') return result([
      { seq: 10, name: 'chapter-010.md', displayName: '第十章' },
    ]);
    if (name === 'read_outline_nodes') return result({
      nodes: [
        {
          id: 'scene-11-a',
          title: '密信鉴定',
          summary: '主角确认密信伪造。',
          characters: ['hero'],
          location: '书房',
          setting: '夜晚',
          pov: 'hero',
          volumeIndex: 1,
          sectionIndex: 2,
          chapterIndex: 11,
          mustNotHappen: ['不得公开真凶身份。'],
          informationBoundaries: ['主角尚不知道王府参与。'],
        },
        {
          id: 'scene-11-b',
          title: '无人的走廊',
          summary: '走廊上留下新线索。',
          characters: [],
          volumeIndex: 1,
          sectionIndex: 2,
          chapterIndex: 11,
        },
      ],
    });
    if (name === 'query_timeline') return result({ events: [{
      id: 'event-10',
      chapterRef: 'chapter-010.md',
      when: '当夜',
      where: '王城',
      description: '主角收到密信。',
    }] });
    if (name === 'read_style_memory') return result('句式克制，少用解释性旁白。');
    if (name === 'read_chapter_summary') return result('# chapter-010.md Summary\n\n主角收到来历不明的密信。');
    if (name === 'read_chapter') return result('# 第十章\n\n他将密信收进怀里。\n\n窗外的钟声敲了三下。');
    if (name === 'read_outline') return result(`${args.name}\n层级大纲内容。`);
    if (name === 'assemble_scene_context') return result({
      nodeId: args.nodeId,
      title: args.nodeId,
      characters: args.nodeId === 'scene-11-a' ? [{ id: 'hero', name: '林昭', speechStyle: '简短克制'.repeat(3000) }] : [],
    });
    if (name === 'retrieve_context') return result({
      query: args.query,
      resultCount: 1,
      contextText: '检索补充：王府印章的形制。',
      items: [{ sourceRef: 'world:seal' }],
      wasTrimmed: false,
    });
    throw new Error(`unexpected tool ${name}`);
  };

  try {
    clearChapterContextCache();
    const input = {
      targetChapter: {
        name: 'chapter-011.md',
        displayName: '第十一章',
        titleHint: '伪造的密信',
        ordinal: 11,
        source: 'explicit_next',
      },
      userText: '写第十一章',
      mode: 'create',
      settings: { contextDepth: 'auto' },
      callTool,
      novelDir,
    };
    const first = await compileChapterContext(input);
    assert.equal(first.cache.hit, false);
    assert.match(first.continuity.previousChapter.summary, /来历不明/u);
    assert.match(first.continuity.previousChapter.endingExcerpt, /钟声/u);
    assert.match(first.stylePacket.memory, /句式克制/u);
    assert.equal(first.outlineIntent.matchingNodes.length, 2);
    assert.equal(first.sceneContracts.length, 2);
    assert.equal(first.sceneContracts[1].appearingCharacterIds.length, 0);
    assert.deepEqual(first.entryState.worldState.deterministicFacts, [{
      fact: '主角收到密信。',
      sourceRef: 'timeline:event-10',
      when: '当夜',
      where: '王城',
      participants: [],
    }]);
    assert.ok(first.assertions.some((item) => item.type === 'knowledge_boundary' && item.severity === 'blocking'));
    assert.ok(first.sourceRefs.some((item) => item.ref === 'style:memory'));
    assert.ok(first.trimmed.includes('sceneCharacterContexts'));
    assert.equal(first.diagnostics.some((item) => item.severity === 'blocking'), false);

    const callsAfterFirst = calls.length;
    const second = await compileChapterContext(input);
    assert.equal(second.cache.hit, true);
    assert.equal(calls.length, callsAfterFirst);

    await fs.writeFile(path.join(chaptersDir, 'chapter-010.md'), '# 第十章\n\n改动后的结尾，长度也发生变化。', 'utf8');
    const third = await compileChapterContext(input);
    assert.equal(third.cache.hit, false);
    assert.ok(calls.length > callsAfterFirst);

    const freeScenes = sceneContractsFromOutline(input.targetChapter, [], []);
    assert.equal(freeScenes.length, 1);
    assert.equal(freeScenes[0].appearingCharacterIds.length, 0);
    console.log('TEST_PASS chapter-context-compiler-regression');
  } finally {
    await fs.rm(novelDir, { recursive: true, force: true });
    clearChapterContextCache();
  }
}

if (require.main === module) {
  run().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}

module.exports = { run };
