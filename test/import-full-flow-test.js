#!/usr/bin/env node
'use strict';

/**
 * Full Import Flow Test — end-to-end test of the import + analyze + write pipeline.
 * Mocks the AI provider so no real API calls are made.
 */

const fs = require('node:fs').promises;
const path = require('node:path');

let TOTAL = 0;
let FAILED = 0;

function PASS(msg) { TOTAL++; console.log('  ✅', msg); }
function FAIL(msg) { TOTAL++; FAILED++; console.log('  ❌', msg); }

const TEST_DIR = path.join(__dirname, '..', 'tmp-test-full-import');
const STAGING_DIR = path.join(TEST_DIR, 'import-staging', 'test-import-001');

// ── Mock AI Provider ──────────────────────────────────────────────

const MOCK_OUTPUTS = {
  characters: JSON.stringify([
    { id: 'alice', name: '爱丽丝', gender: '女', age: '16', role: '主角', appearance: '金发碧眼', personality: '勇敢', background: '来自魔法世界', protagonist: true },
    { id: 'bob', name: '鲍勃', gender: '男', age: '18', role: '同伴', appearance: '黑发', personality: '沉稳', background: '骑士团团长' },
  ]),
  factions: JSON.stringify([
    { name: '魔法议会', type: '政府', description: '统治魔法世界的组织', members: ['爱丽丝'], goals: '维护魔法秩序' },
  ]),
  timeline: JSON.stringify([
    { id: 'evt-1', timestamp: '第一天', title: '觉醒', event: '爱丽丝发现自己的魔法力量', type: 'character', importance: 'major', involvedCharacters: ['爱丽丝'] },
  ]),
  world: JSON.stringify({
    possibleFanworkOf: null,
    timeSetting: '中世纪魔法时代',
    lore: '这是一个魔法与剑并存的世界，魔法议会统治着整个大陆，普通人也可以学习魔法但需要消耗魔力。',
    location: '魔法大陆',
    society: '魔法议会统治',
    rules: '魔法需要消耗魔力',
    places: [{ name: '魔法学院', type: '建筑', description: '培养魔法师的地方' }],
  }),
  outline: '# 大纲\n\n## 故事梗概\n爱丽丝在魔法世界冒险。\n\n## 章节概要\n第一章：觉醒',
  style: '# 文风分析\n\n## 叙述视角\n第三人称\n\n## 用词特点\n华丽',
};

const TASK_SIGNATURES = {
  characters: '出现了哪些角色',
  factions: '势力、派系',
  timeline: '发生了哪些重要事件',
  world: '世界观设定',
  outline: '提取剧情大纲',
  style: '写作风格特征',
};

const mockProvider = {
  async sendMessage({ messages }) {
    // Determine which task this is from the prompt using unique signatures
    const prompt = messages?.[0]?.content?.[0]?.text || '';
    let taskId = 'unknown';
    for (const [id, sig] of Object.entries(TASK_SIGNATURES)) {
      if (prompt.includes(sig)) { taskId = id; break; }
    }

    // Simulate network delay
    await new Promise((r) => setTimeout(r, 50));

    return {
      content: [{ type: 'text', text: MOCK_OUTPUTS[taskId] || '{}' }],
    };
  },
};

// ── Setup ─────────────────────────────────────────────────────────

async function setup() {
  await fs.mkdir(TEST_DIR, { recursive: true });
  process.env.MANA_USER_DATA_ROOT = TEST_DIR;

  // Setup staging project with chapters
  const chaptersDir = path.join(STAGING_DIR, 'chapters');
  await fs.mkdir(chaptersDir, { recursive: true });
  await fs.writeFile(
    path.join(chaptersDir, 'chapter-001.md'),
    '# 第一章 觉醒\n\n爱丽丝发现自己拥有魔法力量。鲍勃作为骑士团团长前来接应。',
    'utf8'
  );
  await fs.writeFile(
    path.join(chaptersDir, 'chapter-002.md'),
    '# 第二章 魔法学院\n\n爱丽丝来到魔法学院学习。',
    'utf8'
  );

  // Mock providerManager and modelAliases BEFORE requiring analyzer
  const providerManager = require('../src/main/providerManager');
  const modelAliases = require('../src/main/modelAliases');

  providerManager.getActiveProvider = async () => ({
    type: 'anthropic',
    apiKey: 'mock-key',
    models: [{ id: 'mock-model' }],
  });
  providerManager.getProvider = async () => providerManager.getActiveProvider();

  modelAliases.getAlias = async () => ({ providerId: 'mock', modelId: 'mock-model' });

  // Mock the anthropic provider module
  require.cache[require.resolve('../src/main/runtime/providers/anthropic')] = {
    id: require.resolve('../src/main/runtime/providers/anthropic'),
    exports: mockProvider,
    loaded: true,
  };
}

// ── Tests ─────────────────────────────────────────────────────────

async function runTests() {
  console.log('═══════════════════════════════════════════');
  console.log(' Full Import Flow Test');
  console.log('═══════════════════════════════════════════');

  await setup();

  const analyzer = require('../src/main/import/analyzer');

  // Test 1: startAnalyses
  console.log('');
  console.log('[1] startAnalyses');
  let startResult;
  try {
    startResult = await analyzer.startAnalyses(STAGING_DIR);
    if (startResult.runIds && startResult.runIds.length > 0) {
      PASS(`startAnalyses returned ${startResult.runIds.length} runIds`);
    } else {
      FAIL('startAnalyses returned empty runIds');
    }
    if (startResult.taskIds && startResult.taskIds.length === 6) {
      PASS(`taskIds has all 6 tasks: ${startResult.taskIds.join(',')}`);
    } else {
      FAIL(`taskIds missing tasks: ${(startResult.taskIds || []).join(',')}`);
    }
  } catch (err) {
    FAIL('startAnalyses threw: ' + err.message);
  }

  // Test 2: finalizeAnalyses
  console.log('');
  console.log('[2] finalizeAnalyses');
  let finalizeResult;
  try {
    finalizeResult = await analyzer.finalizeAnalyses(STAGING_DIR);
    PASS('finalizeAnalyses completed without error');
  } catch (err) {
    FAIL('finalizeAnalyses threw: ' + err.message);
    console.error(err);
  }

  // Test 3: Verify files written
  console.log('');
  console.log('[3] Verify written files');

  const checks = [
    { dir: 'characters', files: ['alice.json', 'bob.json'], label: 'character files' },
    { dir: 'world', files: ['lore.md', 'places.json'], label: 'world files' },
    { dir: 'outlines', files: ['main.md'], label: 'outline files' },
    { dir: 'style', files: ['memory.md'], label: 'style files' },
    { dir: 'factions', files: ['魔法议会.json'], label: 'faction files' },
    { dir: 'timeline', files: ['events.jsonl'], label: 'timeline files' },
  ];

  for (const check of checks) {
    const dirPath = path.join(STAGING_DIR, check.dir);
    try {
      const entries = await fs.readdir(dirPath);
      for (const expectedFile of check.files) {
        if (entries.includes(expectedFile)) {
          PASS(`${check.dir}/${expectedFile} exists`);
        } else {
          FAIL(`${check.dir}/${expectedFile} MISSING (have: ${entries.join(',')})`);
        }
      }
    } catch (err) {
      FAIL(`${check.dir} directory missing or unreadable: ${err.message}`);
    }
  }

  // Test 4: Verify content
  console.log('');
  console.log('[4] Verify file contents');

  try {
    const alice = JSON.parse(await fs.readFile(path.join(STAGING_DIR, 'characters', 'alice.json'), 'utf8'));
    if (alice.name === '爱丽丝') PASS('alice.json has correct name');
    else FAIL(`alice.json name mismatch: ${alice.name}`);
    if (alice.protagonist === true) PASS('alice.json has protagonist=true');
    else if (alice.protagonist === undefined) PASS('alice.json missing protagonist (backward compat)');
    else FAIL(`alice.json protagonist=${alice.protagonist}`);
  } catch (err) {
    FAIL('alice.json read/parse failed: ' + err.message);
  }

  try {
    const lore = await fs.readFile(path.join(STAGING_DIR, 'world', 'lore.md'), 'utf8');
    if (lore.includes('魔法')) PASS('world/lore.md has expected content');
    else FAIL(`world/lore.md unexpected: ${lore.slice(0, 100)}`);
  } catch (err) {
    FAIL('world/lore.md read failed: ' + err.message);
  }

  try {
    const outline = await fs.readFile(path.join(STAGING_DIR, 'outlines', 'main.md'), 'utf8');
    if (outline.includes('觉醒')) PASS('outlines/main.md has expected content');
    else FAIL(`outlines/main.md unexpected: ${outline.slice(0, 100)}`);
  } catch (err) {
    FAIL('outlines/main.md read failed: ' + err.message);
  }

  try {
    const places = JSON.parse(await fs.readFile(path.join(STAGING_DIR, 'world', 'places.json'), 'utf8'));
    if (places.places?.length >= 1) PASS(`world/places.json has ${places.places.length} place(s)`);
    else FAIL(`world/places.json missing places: ${JSON.stringify(places)}`);
  } catch (err) {
    FAIL('world/places.json read/parse failed: ' + err.message);
  }

  try {
    const events = (await fs.readFile(path.join(STAGING_DIR, 'timeline', 'events.jsonl'), 'utf8')).trim().split('\n');
    if (events.length >= 1 && events[0].includes('觉醒')) PASS('timeline/events.jsonl has expected events');
    else FAIL(`timeline/events.jsonl unexpected: ${events[0]?.slice(0, 100)}`);
  } catch (err) {
    FAIL('timeline/events.jsonl read failed: ' + err.message);
  }

  // Test 5: Verify finalize result stats
  console.log('');
  console.log('[5] Verify finalize stats');
  if (finalizeResult) {
    if (finalizeResult.characters === 2) PASS(`characters count = 2`);
    else FAIL(`characters count = ${finalizeResult.characters} (expected 2)`);
    if (finalizeResult.factions === 1) PASS(`factions count = 1`);
    else FAIL(`factions count = ${finalizeResult.factions} (expected 1)`);
    if (finalizeResult.timeline === 1) PASS(`timeline count = 1`);
    else FAIL(`timeline count = ${finalizeResult.timeline} (expected 1)`);
    if (finalizeResult.outline > 10) PASS(`outline length = ${finalizeResult.outline}`);
    else FAIL(`outline length = ${finalizeResult.outline}`);
    if (finalizeResult.lore > 10) PASS(`lore length = ${finalizeResult.lore}`);
    else FAIL(`lore length = ${finalizeResult.lore}`);
    if (finalizeResult.style > 10) PASS(`style length = ${finalizeResult.style}`);
    else FAIL(`style length = ${finalizeResult.style}`);
  } else {
    FAIL('finalizeResult is null');
  }

  // Cleanup
  console.log('');
  console.log('═══════════════════════════════════════════');
  console.log(` Results: ${TOTAL - FAILED}/${TOTAL} passed, ${FAILED} failed`);
  console.log('═══════════════════════════════════════════');

  await fs.rm(TEST_DIR, { recursive: true, force: true });
  process.exit(FAILED > 0 ? 1 : 0);
}

runTests().catch((err) => {
  console.error('Test runner error:', err);
  process.exit(1);
});
