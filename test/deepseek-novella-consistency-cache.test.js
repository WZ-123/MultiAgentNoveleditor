'use strict';

const assert = require('node:assert/strict');
const { CHAPTERS, buildConsistencyFingerprint } = require('./deepseek-live-novella-ui-e2e');

async function fingerprintWith(overrides = {}) {
  const data = {
    readChapter: async (_dir, fileName) => overrides[`chapter:${fileName}`] || `body:${fileName}`,
    readOutlineChapter: async (_dir, volume, section, chapter) => overrides[`outline:${volume}:${section}:${chapter}`] || `outline:${volume}:${section}:${chapter}`,
    readWorld: async () => overrides['world:lore'] || { lore: 'world:lore' },
  };
  return buildConsistencyFingerprint('/novel', data);
}

(async () => {
  const baseline = await fingerprintWith();
  assert.notEqual(await fingerprintWith({ 'chapter:chapter-001.md': 'changed body' }), baseline);
  assert.notEqual(await fingerprintWith({ 'outline:1:1:9': 'changed early outline' }), baseline);
  assert.notEqual(await fingerprintWith({ 'outline:1:3:27': 'changed late outline' }), baseline);
  assert.notEqual(await fingerprintWith({ 'world:lore': { lore: 'changed lore' } }), baseline);
  assert.equal(CHAPTERS.length, 27);
  console.log('deepseek-novella-consistency-cache: ok');
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
