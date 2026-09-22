'use strict';

const assert = require('node:assert/strict');
const { mergeCharacters, mergeChunkResults } = require('../src/main/import/resultMerger');

function run() {
  const chunks = [
    {
      chunkIndex: 0,
      characters: [{
        id: 'liyin-a', name: '莉音', aliases: ['Liyin'], role: '助手', personality: '冷静',
        relationships: [{ with: '主人', type: '主从' }],
      }],
    },
    {
      chunkIndex: 1,
      characters: [{
        id: 'liyin-b', name: ' 莉 音 ', aliases: ['Liyin', '莉'], role: '贴身助手', personality: '冷静而有主见',
        relationships: [{ with: '主人', type: '主从' }, { with: '阿宁', type: '同伴' }],
      }],
    },
  ];
  const merged = mergeCharacters(chunks);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].name, '莉音');
  assert.equal(merged[0].role, '贴身助手');
  assert.equal(merged[0].personality, '冷静而有主见');
  assert.deepEqual(merged[0].aliases, ['Liyin', '莉']);
  assert.deepEqual(merged[0].relationships, [{ with: '主人', type: '主从' }, { with: '阿宁', type: '同伴' }]);
  assert.equal(mergeChunkResults(chunks).characters.length, 1);
  console.log('IMPORT-B05 passed: duplicate normalized character names merge to one canonical record with rich fields and deduplicated relationships.');
}

try {
  run();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
