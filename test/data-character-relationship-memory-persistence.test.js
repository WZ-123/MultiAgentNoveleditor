'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function run() {
  const root = path.resolve(__dirname, '..');
  const novelDir = path.join(root, 'tmp-test-data-character-relationship-memory');
  const novelData = require(path.join(root, 'src/main/store/novelData'));
  const { getToolByName } = require(path.join(root, 'src/main/mcp/tools'));
  const ctx = { novelDir };
  let passed = 0;
  const check = (condition, label) => {
    assert.ok(condition, label);
    passed += 1;
    console.log(`TEST_PASS ${label}`);
  };

  try {
    await fs.rm(novelDir, { recursive: true, force: true });
    await novelData.writeCharacter(novelDir, {
      id: 'lin', name: '林岚', role: '主角', personality: '谨慎', relationships: {},
    });
    await novelData.writeCharacter(novelDir, {
      id: 'su', name: '苏绾', role: '同伴', personality: '直率', relationships: {},
    });

    const update = getToolByName('update_character');
    await update.handler({ id: 'lin', patch: { relationships: { su: '互相信任，但林岚尚未说出旧案真相。' } } }, ctx);
    const patchMemory = getToolByName('patch_character_memory');
    await patchMemory.handler({ id: 'lin', patch: {
      lastUpdatedChapterRef: 'chapter-001.md',
      factsKnown: [{ id: 'fact-old-case', summary: '苏绾知道旧案的部分线索。', confidence: 'certain' }],
      relationshipDeltas: [{ id: 'rel-su', targetCharacterId: 'su', delta: '从试探转为合作', evidence: '共同脱险' }],
    } }, ctx);

    const character = await novelData.readCharacter(novelDir, 'lin');
    const memory = await novelData.readCharacterMemory(novelDir, 'lin');
    check(character.relationships.su.includes('旧案真相'), 'character relationship patch persists');
    check(memory.lastUpdatedChapterRef === 'chapter-001.md', 'character memory chapter reference persists');
    check(memory.factsKnown.some((item) => item.id === 'fact-old-case'), 'character memory facts persist');
    check(memory.relationshipDeltas.some((item) => item.id === 'rel-su'), 'character memory relationship delta persists');

    // Load a new module instance after all writes, mirroring a cold store read.
    delete require.cache[require.resolve(path.join(root, 'src/main/store/novelData'))];
    const restartedStore = require(path.join(root, 'src/main/store/novelData'));
    const restartedCharacter = await restartedStore.readCharacter(novelDir, 'lin');
    const restartedMemory = await restartedStore.readCharacterMemory(novelDir, 'lin');
    check(restartedCharacter.relationships.su.includes('互相信任'), 'relationship survives fresh store load');
    check(restartedMemory.factsKnown.some((item) => item.id === 'fact-old-case') && restartedMemory.relationshipDeltas.some((item) => item.id === 'rel-su'), 'memory survives fresh store load');
  } finally {
    await fs.rm(novelDir, { recursive: true, force: true });
  }
  console.log(`TEST_SUMMARY ${passed}/6 passed, 0 failed`);
}

run().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
