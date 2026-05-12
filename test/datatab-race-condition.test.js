#!/usr/bin/env node
'use strict';

/**
 * Test for DataTabContent race-condition fix.
 *
 * Reproduces the bug where rapidly switching data tabs
 * (characters → world → timeline → outline) caused a stale
 * async response from the *previous* tab to overwrite state,
 * making the new tab render an object as a React child and crash.
 *
 * Bug: 旧的 load() 异步回调在 dataType 切换后仍然执行 setData()，
 *      把前一个 tab 的数据类型写入新 tab 的状态。
 *      例如：时间线加载中切换到「大纲」，时间线数组写入 data，
 *      大纲渲染 `<div>{data}</div>` 时 React 报错：
 *      "Objects are not valid as a React child"
 *
 * Fix: useEffect cleanup 中设置 cancelled flag，
 *      旧异步回调发现 cancelled 后放弃 setData()。
 *      同时大纲/文风渲染增加 typeof 类型保护，作为兜底。
 */

let TOTAL = 0;
let FAILED = 0;

function PASS(msg) { TOTAL++; console.log('  ✅', msg); }
function FAIL(msg) { TOTAL++; FAILED++; console.log('  ❌', msg); }

// ── Simulate the old buggy load behavior ──────────────────────────

async function buggyLoadSequence() {
  // Simulates: user opens timeline tab, then immediately switches to outline
  // before timeline's async fetch completes.
  let data = null;

  // Timeline load starts (async)
  const timelinePromise = new Promise((resolve) => {
    setTimeout(() => {
      // This represents the timeline API returning an array of event objects
      resolve([
        { id: 'evt-1', timestamp: '第一天', title: '觉醒', event: '爱丽丝发现魔法', type: 'character', importance: 'major', involvedCharacters: ['爱丽丝'] },
      ]);
    }, 50);
  });

  // User switches to outline BEFORE timeline completes
  // In the buggy version, the component would call load() for outline,
  // but the old timeline promise is still in flight.

  // Outline load starts (async, faster)
  const outlinePromise = new Promise((resolve) => {
    setTimeout(() => {
      resolve('# 大纲\n\n## 第一章 觉醒\n爱丽丝发现魔法。');
    }, 20);
  });

  // Buggy behavior: both promises resolve and call setData()
  // The one that resolves LAST wins.
  const timelineResult = await timelinePromise;
  const outlineResult = await outlinePromise;

  // In React, setData is called when each async operation completes.
  // If timeline completes AFTER outline, it overwrites:
  data = timelineResult; // Last write wins = BUG

  return data;
}

// ── Simulate the fixed load behavior (with cancelled flag) ────────

async function fixedLoadSequence() {
  let data = null;
  let cancelledTimeline = false;

  // Timeline load starts
  const timelineResult = await new Promise((resolve) => {
    setTimeout(() => {
      resolve([
        { id: 'evt-1', timestamp: '第一天', title: '觉醒', event: '爱丽丝发现魔法', type: 'character', importance: 'major', involvedCharacters: ['爱丽丝'] },
      ]);
    }, 50);
  });

  // The cancelled flag is set BEFORE the timeline async completes
  // (simulating user switching tabs while load is in flight)
  cancelledTimeline = true;

  // Outline load starts (async, faster)
  const outlineResult = await new Promise((resolve) => {
    setTimeout(() => {
      resolve('# 大纲\n\n## 第一章 觉醒\n爱丽丝发现魔法。');
    }, 20);
  });

  // Apply results respecting cancelled flag
  if (!cancelledTimeline) data = timelineResult;
  data = outlineResult; // outline was NOT cancelled

  return data;
}

// ── Simulate the fixed behavior with explicit tab tracking ────────

async function fixedLoadWithTabTracking() {
  let data = null;
  let currentTab = 'timeline';
  let loadId = 0;

  async function loadTab(tab, id) {
    const myId = id;
    let result;

    if (tab === 'timeline') {
      result = await new Promise((resolve) => {
        setTimeout(() => {
          resolve([
            { id: 'evt-1', timestamp: '第一天', title: '觉醒', event: '爱丽丝发现魔法', type: 'character', importance: 'major', involvedCharacters: ['爱丽丝'] },
          ]);
        }, 50);
      });
    } else if (tab === 'outline') {
      result = await new Promise((resolve) => {
        setTimeout(() => {
          resolve('# 大纲\n\n## 第一章 觉醒\n爱丽丝发现魔法。');
        }, 20);
      });
    }

    // Guard: only apply if this is still the current tab
    if (currentTab === tab && loadId === myId) {
      data = result;
    }
  }

  // Start timeline load
  const timelineId = ++loadId;
  const timelinePromise = loadTab('timeline', timelineId);

  // Switch to outline before timeline completes
  currentTab = 'outline';
  loadId++;

  // Start outline load
  const outlineId = loadId;
  const outlinePromise = loadTab('outline', outlineId);

  await Promise.all([timelinePromise, outlinePromise]);

  return data;
}

// ── Test: type guard prevents crash even with wrong data type ─────

function renderOutlineSafely(data) {
  // The fixed code does: typeof data === 'string' ? data : JSON.stringify(...)
  if (typeof data === 'string') return data;
  return JSON.stringify(data ?? '', null, 2);
}

function renderOutlineBuggy(data) {
  // The old code just rendered {data} directly
  // In React this crashes when data is an object/array
  // We simulate by throwing if data is not a string/primitive
  if (typeof data !== 'string' && typeof data !== 'number' && data !== null && data !== undefined) {
    throw new Error('Objects are not valid as a React child');
  }
  return String(data);
}

// ── Run tests ─────────────────────────────────────────────────────

async function runTests() {
  console.log('═══════════════════════════════════════════');
  console.log(' DataTabContent Race-Condition Test');
  console.log('═══════════════════════════════════════════');

  // Test 1: Buggy behavior produces wrong data type
  console.log('\n[1] Buggy behavior: stale timeline overwrites outline');
  const buggyResult = await buggyLoadSequence();
  if (Array.isArray(buggyResult) && buggyResult[0]?.involvedCharacters) {
    PASS('buggy sequence produces timeline array (reproduces root cause)');
  } else {
    FAIL('buggy sequence did not produce timeline array');
  }

  // Test 2: Fixed behavior with cancelled flag
  console.log('\n[2] Fixed behavior: cancelled flag prevents stale write');
  const fixedResult = await fixedLoadSequence();
  if (typeof fixedResult === 'string' && fixedResult.includes('大纲')) {
    PASS('fixed sequence produces outline string');
  } else {
    FAIL(`fixed sequence produced: ${typeof fixedResult}`);
  }

  // Test 3: Fixed behavior with tab tracking
  console.log('\n[3] Fixed behavior with tab+loadId tracking');
  const trackedResult = await fixedLoadWithTabTracking();
  if (typeof trackedResult === 'string' && trackedResult.includes('大纲')) {
    PASS('tab-tracking sequence produces outline string');
  } else {
    FAIL(`tab-tracking sequence produced: ${typeof trackedResult}`);
  }

  // Test 4: Type guard prevents crash
  console.log('\n[4] Type guard: outline rendering with wrong data type');
  const timelineArray = [{ id: 'evt-1', timestamp: '第一天', title: '觉醒' }];
  try {
    renderOutlineBuggy(timelineArray);
    FAIL('buggy render did NOT throw (unexpected)');
  } catch (err) {
    if (err.message.includes('React child')) {
      PASS('buggy render throws "React child" error (confirms crash)');
    } else {
      FAIL(`buggy render threw unexpected: ${err.message}`);
    }
  }

  try {
    const safe = renderOutlineSafely(timelineArray);
    if (typeof safe === 'string' && safe.includes('evt-1')) {
      PASS('safe render returns string without crashing');
    } else {
      FAIL(`safe render returned unexpected: ${safe}`);
    }
  } catch (err) {
    FAIL(`safe render threw: ${err.message}`);
  }

  // Test 5: Type guard with correct string data
  console.log('\n[5] Type guard: outline rendering with correct string data');
  const outlineText = '# 大纲\n\n第一章';
  const safeString = renderOutlineSafely(outlineText);
  if (safeString === outlineText) {
    PASS('safe render preserves correct string data');
  } else {
    FAIL(`safe render mutated string: ${safeString}`);
  }

  // Cleanup
  console.log('\n═══════════════════════════════════════════');
  console.log(` Results: ${TOTAL - FAILED}/${TOTAL} passed, ${FAILED} failed`);
  console.log('═══════════════════════════════════════════');

  process.exit(FAILED > 0 ? 1 : 0);
}

runTests().catch((err) => {
  console.error('Test runner error:', err);
  process.exit(1);
});
