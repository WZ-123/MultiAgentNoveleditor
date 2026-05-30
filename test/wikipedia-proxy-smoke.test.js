'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const { networkFetchJson, hasProxyConfigured } = require(path.join(ROOT, 'src/main/import/networkFetch.js'));

function pass(name, detail) {
  console.log(`TEST_PASS ${name}${detail ? ': ' + detail : ''}`);
}

function fail(name, reason) {
  console.log(`TEST_FAIL ${name}: ${reason}`);
}

async function run() {
  let failed = 0;
  const proxy = hasProxyConfigured();
  if (!proxy) {
    console.log('TEST_SKIP wikipedia_proxy_smoke (no HTTPS_PROXY set)');
    console.log('TEST_SUMMARY 0/0 skipped');
    console.log('TEST_DONE');
    return;
  }

  try {
    const url = 'https://zh.wikipedia.org/w/api.php?action=query&list=search&srsearch=原神&format=json&srlimit=1&origin=*';
    const json = await networkFetchJson(url, { timeout: 20000, retries: 2 });
    assert.ok(json?.query?.search?.length >= 1);
    const title = json.query.search[0].title;
    const extUrl = `https://zh.wikipedia.org/w/api.php?action=query&prop=extracts&exintro&explaintext&titles=${encodeURIComponent(title)}&format=json&origin=*`;
    const extJson = await networkFetchJson(extUrl, { timeout: 20000, retries: 2 });
    const pages = extJson?.query?.pages || {};
    const extract = Object.values(pages)[0]?.extract || '';
    assert.ok(extract.length > 20);
    pass('WPS1_proxy_wikipedia_search_and_extract', `proxy=${process.env.HTTPS_PROXY || process.env.HTTP_PROXY}`);
  } catch (err) {
    failed += 1;
    fail('WPS1_proxy_wikipedia', err?.message || String(err));
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
