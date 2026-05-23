'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const searchEngine = require(path.join(ROOT, 'src/main/import/searchEngine.js'));

const originalSources = {};

function pass(name, detail) {
  console.log(`TEST_PASS ${name}${detail ? ': ' + detail : ''}`);
}

function fail(name, reason) {
  console.log(`TEST_FAIL ${name}: ${reason}`);
}

async function run() {
  let failed = 0;

  try {
    for (const [id, source] of Object.entries(searchEngine.SOURCES)) {
      originalSources[id] = source.search;
    }

    searchEngine.SOURCES.moegirl.search = async () => [];
    searchEngine.SOURCES.biligame.search = async () => [
      { title: '爱宕', snippet: 'BWiki角色页', url: 'https://wiki.biligame.com/blhx/%E7%88%B1%E5%AE%95', source: 'biligame' },
    ];
    searchEngine.SOURCES.bing.search = async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return [
        { title: '爱', snippet: '通用词条', url: 'https://bing.test/ai', source: 'bing' },
      ];
    };
    searchEngine.SOURCES.wikipedia.search = async () => [];
    searchEngine.SOURCES.duckduckgo.search = async () => [];

    const result = await searchEngine.searchCharacter({
      charName: '爱宕',
      fanworkName: '碧蓝航线',
      userLang: 'zh-CN',
      fanworkSphere: 'east-asian-cn',
      preferredEngine: 'auto',
    });

    assert.equal(result.results[0]?.source, 'biligame');
    assert.equal(result.results[0]?.title, '爱宕');
    pass('CSBR1_biligame_ranks_ahead_of_generic_search', 'mapped Biligame wiki result outranks generic Bing result');
  } catch (err) {
    failed += 1;
    fail('CSBR_harness', err?.stack || String(err));
  } finally {
    for (const [id, search] of Object.entries(originalSources)) {
      searchEngine.SOURCES[id].search = search;
    }
  }

  console.log('');
  console.log(`TEST_SUMMARY ${failed ? 0 : 1}/1 passed, ${failed} failed`);
  console.log('TEST_DONE');
  if (failed) process.exitCode = 1;
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});