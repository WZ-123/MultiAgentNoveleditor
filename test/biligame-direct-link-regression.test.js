'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const biligameWiki = require(path.join(ROOT, 'src/main/import/biligameWiki.js'));

const FIXTURE_HTML = `
<html><body>
<h1>胡桃</h1>
<p>发色：深棕色 瞳色：梅花瞳 身高：约1.5米</p>
<h2>皮肤</h2>
<p>雪霁梅香|冬日礼服妆造|节日剧情|「咳咳…」</p>
<p>宿雪桃红|旗袍妆造|海灯节|「吃饱喝足，一路顺风！」</p>
</body></html>
`;

function pass(name, detail) {
  console.log(`TEST_PASS ${name}${detail ? ': ' + detail : ''}`);
}

function fail(name, reason) {
  console.log(`TEST_FAIL ${name}: ${reason}`);
}

async function run() {
  let failed = 0;

  try {
    const url = biligameWiki.buildBiligamePageUrl('ys', '胡桃');
    assert.match(url, /wiki\.biligame\.com\/ys\/%E8%83%A1%E6%A1%83/);
    pass('BDLR1_build_url', url);
  } catch (err) {
    failed += 1;
    fail('BDLR1_build_url', err?.message || String(err));
  }

  try {
    const resolved = await biligameWiki.resolveBiligamePageTitle('肇和', '碧蓝航线');
    assert.ok(resolved?.url?.includes('wiki.biligame.com/blhx'));
    pass('BDLR2_resolve_blhx', resolved.title);
  } catch (err) {
    failed += 1;
    fail('BDLR2_resolve_blhx', err?.message || String(err));
  }

  try {
    const { parseSkinBlocks } = require(path.join(ROOT, 'src/main/import/wikiContentParser.js'));
    const skins = parseSkinBlocks(FIXTURE_HTML);
    assert.ok(skins.length >= 2);
    assert.ok(skins[0].name && skins[0].outfit);
    pass('BDLR3_parse_skins_fixture', `count=${skins.length}`);
  } catch (err) {
    failed += 1;
    fail('BDLR3_parse_skins', err?.message || String(err));
  }

  console.log('');
  console.log(`TEST_SUMMARY ${failed ? 0 : 3}/3 passed, ${failed} failed`);
  console.log('TEST_DONE');
  if (failed) process.exitCode = 1;
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
