#!/usr/bin/env node
'use strict';

const fs = require('node:fs').promises;
const path = require('node:path');

const novelData = require('../src/main/store/novelData');
const { ensureNovelLayout } = require('../src/main/store/paths');

let total = 0;
let failed = 0;

function pass(name, detail) {
  total++;
  console.log(`TEST_PASS ${name}${detail ? ': ' + detail : ''}`);
}

function fail(name, reason) {
  total++;
  failed++;
  console.log(`TEST_FAIL ${name}: ${reason}`);
}

async function main() {
  const root = path.join(__dirname, '..', 'tmp-test-datatab-save');
  const novelDir = path.join(root, 'novel');
  const novelId = 'novel-datatab-save';

  await fs.rm(root, { recursive: true, force: true });
  ensureNovelLayout(novelDir);

  const { saveDataTabEdit } = await import(path.join('file://', __dirname, '..', 'src/components/dataTabSave.mjs'));

  const mana = {
    novel: {
      listCharacters: async () => novelData.listCharacters(novelDir),
      writeCharacter: async (_id, character) => novelData.writeCharacter(novelDir, character),
      deleteCharacter: async (_id, charId) => novelData.deleteCharacter(novelDir, charId),
      writeWorld: async (_id, world) => novelData.writeWorld(novelDir, world),
      replaceTimeline: async (_id, events) => novelData.replaceTimeline(novelDir, events),
      writeStyleMemory: async (_id, text) => novelData.writeStyleMemory(novelDir, text),
      active: async () => ({ dir: novelDir }),
    },
    fs: {
      writeFile: async (filePath, content) => fs.writeFile(filePath, content, 'utf8'),
    },
  };

  try {
    await novelData.writeCharacter(novelDir, { id: 'hero', name: '主角', role: '主角', age: '20' });
    await novelData.writeCharacter(novelDir, { id: 'old-char', name: '旧角色', role: '配角' });
    await novelData.writeWorld(novelDir, { lore: '# 旧世界观', places: [{ name: '旧城' }] });
    await novelData.appendTimelineEvent(novelDir, { id: 'old-event', description: '旧事件' });
    await novelData.writeStyleMemory(novelDir, '旧文风');
    const outlinePath = path.join(novelDir, 'outlines', 'outline.md');
    await fs.writeFile(outlinePath, '# 旧大纲\n', 'utf8');

    await saveDataTabEdit({
      mana,
      novelId,
      dataType: 'characters',
      editText: JSON.stringify([
        { id: 'hero', name: '主角', role: '主角', age: '21', personality: '更冷静' },
        { name: '新角色', role: '配角' },
      ], null, 2),
    });

    const characters = await novelData.listCharacters(novelDir);
    const hero = characters.find((item) => item.id === 'hero');
    const newChar = characters.find((item) => item.id === '新角色');
    const oldChar = characters.find((item) => item.id === 'old-char');
    if (hero?.age === '21' && hero?.personality === '更冷静' && newChar?.name === '新角色' && !oldChar) {
      pass('save_characters_roundtrip', 'characters replaced and reloaded');
    } else {
      fail('save_characters_roundtrip', JSON.stringify(characters));
    }

    await saveDataTabEdit({
      mana,
      novelId,
      dataType: 'world',
      editText: JSON.stringify({ lore: '# 新世界观', places: [{ name: '新城', type: '城市' }] }, null, 2),
    });
    const world = await novelData.readWorld(novelDir);
    if (world?.lore?.includes('新世界观') && Array.isArray(world?.places) && world.places[0]?.name === '新城') {
      pass('save_world_roundtrip', 'world updated and reloaded');
    } else {
      fail('save_world_roundtrip', JSON.stringify(world));
    }

    await saveDataTabEdit({
      mana,
      novelId,
      dataType: 'timeline',
      editText: JSON.stringify([
        { id: 'evt-1', when: '第一天', description: '新事件1', participants: ['hero'] },
        { id: 'evt-2', when: '第二天', description: '新事件2', participants: ['new-char'] },
      ], null, 2),
    });
    const timeline = await novelData.listTimeline(novelDir);
    if (timeline.length === 2 && timeline[0]?.description === '新事件1' && !timeline.find((item) => item.id === 'old-event')) {
      pass('save_timeline_roundtrip', 'timeline replaced and reloaded');
    } else {
      fail('save_timeline_roundtrip', JSON.stringify(timeline));
    }

    await saveDataTabEdit({
      mana,
      novelId,
      dataType: 'style',
      editText: '新的文风记录',
    });
    const style = await novelData.readStyleMemory(novelDir);
    if (style === '新的文风记录') {
      pass('save_style_roundtrip', 'style updated and reloaded');
    } else {
      fail('save_style_roundtrip', JSON.stringify(style));
    }

    await saveDataTabEdit({
      mana,
      novelId,
      dataType: 'outline',
      editText: '# 新大纲\n\n第一章',
      outlineCurrentFile: { path: outlinePath },
    });
    const outline = await fs.readFile(outlinePath, 'utf8');
    if (outline.includes('新大纲')) {
      pass('save_outline_roundtrip', 'outline updated and reloaded');
    } else {
      fail('save_outline_roundtrip', JSON.stringify(outline));
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }

  console.log(`TEST_SUMMARY ${total - failed}/${total} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});