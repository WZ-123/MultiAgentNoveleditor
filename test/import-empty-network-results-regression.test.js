'use strict';

const assert = require('node:assert/strict');
const engine = require('../src/main/import/searchEngine');

async function run() {
  const originalMoegirl = engine.SOURCES.moegirl.search;
  const originalDuckDuckGo = engine.SOURCES.duckduckgo.search;
  const calls = [];
  try {
    engine.SOURCES.moegirl.search = async (query) => { calls.push(['moegirl', query]); return []; };
    engine.SOURCES.duckduckgo.search = async (query) => { calls.push(['duckduckgo', query]); return []; };
    const result = await engine.searchCharacter({
      charName: '不存在角色',
      fanworkName: '空结果作品',
      fanworkSphere: 'east-asian-cn',
      preferredEngine: 'moegirl',
    });
    assert.deepEqual(result.results, []);
    assert.equal(result.errors.some((message) => message.includes('萌娘百科: 0条')), true);
    assert.equal(calls.length >= 1, true);
    assert.equal(result.sourceDetails.every((detail) => detail.count === 0 && !detail.error), true);
    console.log('IMPORT-B08 passed: an empty network search produces explicit zero-result source state without synthetic matches or data loss.');
  } finally {
    engine.SOURCES.moegirl.search = originalMoegirl;
    engine.SOURCES.duckduckgo.search = originalDuckDuckGo;
  }
}

if (require.main === module) run().catch((error) => { console.error(error); process.exitCode = 1; });
module.exports = { run };
