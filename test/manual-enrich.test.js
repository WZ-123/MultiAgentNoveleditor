#!/usr/bin/env node
'use strict';

/**
 * Manual Character Enrichment Test
 *
 * Tests the IPC handler for manual character enrichment:
 * 1. enrichCharacters handler reads characters from disk
 * 2. Reads world meta for auto-detected fanwork name
 * 3. Calls enrichCharacters with progress callback
 * 4. Writes enriched characters back
 */

const fs = require('node:fs').promises;
const path = require('node:path');

let TOTAL = 0;
let FAILED = 0;

function PASS(msg) { TOTAL++; console.log('  ✅', msg); }
function FAIL(msg) { TOTAL++; FAILED++; console.log('  ❌', msg); }

const TEST_DIR = path.join(__dirname, '..', 'tmp-test-manual-enrich');

async function setup() {
  await fs.mkdir(TEST_DIR, { recursive: true });
  process.env.MANA_USER_DATA_ROOT = TEST_DIR;

  // Setup a novel project with characters and world meta
  const novelDir = path.join(TEST_DIR, 'novels', 'test-novel');
  const charsDir = path.join(novelDir, 'characters');
  const worldDir = path.join(novelDir, 'world');
  await fs.mkdir(charsDir, { recursive: true });
  await fs.mkdir(worldDir, { recursive: true });

  // Write characters
  await fs.writeFile(
    path.join(charsDir, 'alice.json'),
    JSON.stringify({ id: 'alice', name: '爱丽丝', gender: '女', age: '16', role: '主角' }),
    'utf8'
  );
  await fs.writeFile(
    path.join(charsDir, 'bob.json'),
    JSON.stringify({ id: 'bob', name: '鲍勃', gender: '男', age: '18', role: '同伴' }),
    'utf8'
  );

  // Write world meta with fanwork detection
  await fs.writeFile(
    path.join(worldDir, 'meta.json'),
    JSON.stringify({ schemaVersion: 1, possibleFanworkOf: '蔚蓝档案', detectedAt: new Date().toISOString() }),
    'utf8'
  );

  // Write lore and places
  await fs.writeFile(path.join(worldDir, 'lore.md'), '测试世界观', 'utf8');
  await fs.writeFile(path.join(worldDir, 'places.json'), JSON.stringify({ schemaVersion: 1, places: [] }), 'utf8');

  // Register novel in registry
  const registryPath = path.join(TEST_DIR, 'novels.json');
  await fs.writeFile(registryPath, JSON.stringify({
    schemaVersion: 1,
    novels: [{
      id: 'test-novel',
      title: '测试小说',
      dir: novelDir,
      createdAt: new Date().toISOString(),
    }],
  }), 'utf8');

  return { novelDir, charsDir };
}

async function runTests() {
  console.log('═══════════════════════════════════════════');
  console.log(' Manual Character Enrichment Test');
  console.log('═══════════════════════════════════════════');

  const { novelDir } = await setup();

  // Test 1: novelData.listCharacters
  console.log('\n[1] novelData.listCharacters');
  const novelData = require('../src/main/store/novelData');
  const chars = await novelData.listCharacters(novelDir);
  if (chars.length === 2 && chars.some((c) => c.name === '爱丽丝')) {
    PASS(`listCharacters returned ${chars.length} characters`);
  } else {
    FAIL(`listCharacters returned ${chars.length} characters`);
  }

  // Test 2: novelData.readWorldMeta
  console.log('\n[2] novelData.readWorldMeta');
  const meta = await novelData.readWorldMeta(novelDir);
  if (meta.possibleFanworkOf === '蔚蓝档案') {
    PASS(`readWorldMeta detected fanwork: ${meta.possibleFanworkOf}`);
  } else {
    FAIL(`readWorldMeta returned: ${JSON.stringify(meta)}`);
  }

  // Test 3: characterEnricher with onProgress callback
  console.log('\n[3] characterEnricher.onProgress callback');
  const enricher = require('../src/main/import/characterEnricher');
  const progressEvents = [];
  const mockCharacters = [
    { id: 'test1', name: '测试角色A', appearance: '', personality: '', background: '' },
  ];

  // Test that onProgress is called with expected event shapes
  // Note: This will actually try to search the web, so we just verify the callback fires
  try {
    const result = await enricher.enrichCharacters(
      mockCharacters,
      null,
      'zh-CN',
      {
        fanworkNameOverride: '原神', // Use a known work to increase chance of results
        onProgress: (evt) => {
          progressEvents.push(evt);
        },
      }
    );
    // Verify we got progress events
    const startEvent = progressEvents.find((e) => e.status === 'start');
    const completeEvent = progressEvents.find((e) => e.status === 'complete');
    if (startEvent) PASS('onProgress received start event');
    else FAIL('onProgress missing start event');
    if (completeEvent) PASS('onProgress received complete event');
    else FAIL('onProgress missing complete event');

    // Verify result is an array
    if (Array.isArray(result)) {
      PASS(`enrichCharacters returned array of ${result.length} items`);
    } else {
      FAIL(`enrichCharacters returned non-array: ${typeof result}`);
    }
  } catch (err) {
    FAIL(`enrichCharacters threw: ${err.message}`);
  }

  // Test 4: enrichCharacters skips when no fanwork name
  console.log('\n[4] enrichCharacters skips without fanwork name');
  const noFanworkEvents = [];
  const noFanworkResult = await enricher.enrichCharacters(
    mockCharacters,
    null,
    'zh-CN',
    { onProgress: (evt) => noFanworkEvents.push(evt) }
  );
  const skippedEvent = noFanworkEvents.find((e) => e.status === 'skipped');
  if (skippedEvent && skippedEvent.message?.includes('未检测到')) {
    PASS('no-fanwork case emits skipped event');
  } else {
    FAIL('no-fanwork case did not emit expected skipped event');
  }
  if (noFanworkResult.length === mockCharacters.length) {
    PASS('no-fanwork case returns original characters unchanged');
  } else {
    FAIL(`no-fanwork case returned ${noFanworkResult.length} items (expected ${mockCharacters.length})`);
  }

  // Test 5: enrichCharacters with fanworkNameOverride
  console.log('\n[5] fanworkNameOverride bypasses auto-detection');
  const overrideEvents = [];
  try {
    await enricher.enrichCharacters(
      mockCharacters,
      null,
      'zh-CN',
      {
        fanworkNameOverride: '原神',
        onProgress: (evt) => overrideEvents.push(evt),
      }
    );
    const startEvt = overrideEvents.find((e) => e.status === 'start');
    if (startEvt) PASS('fanworkNameOverride triggers enrichment');
    else FAIL('fanworkNameOverride did not trigger enrichment');
  } catch (err) {
    FAIL(`fanworkNameOverride test threw: ${err.message}`);
  }

  // Cleanup
  console.log('\n═══════════════════════════════════════════');
  console.log(` Results: ${TOTAL - FAILED}/${TOTAL} passed, ${FAILED} failed`);
  console.log('═══════════════════════════════════════════');

  await fs.rm(TEST_DIR, { recursive: true, force: true });
  process.exit(FAILED > 0 ? 1 : 0);
}

runTests().catch((err) => {
  console.error('Test runner error:', err);
  process.exit(1);
});
