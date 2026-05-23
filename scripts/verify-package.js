#!/usr/bin/env node
'use strict';

/**
 * Verify the packaged Windows app has correct structure and all critical paths resolve.
 */

const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const asarPath = path.join(ROOT, 'dist', 'win-unpacked', 'resources', 'app.asar');
const unpackedRoot = path.join(ROOT, 'dist', 'win-unpacked', 'resources', 'app.asar.unpacked');

let failed = 0;

function check(name, ok) {
  console.log(`${ok ? '  OK' : ' FAIL'}  ${name}`);
  if (!ok) failed++;
}

console.log('=== Packaged App Verification ===');

// 1. ASAR file exists
check('app.asar exists', fs.existsSync(asarPath));

// 2. app.asar.unpacked exists
check('app.asar.unpacked exists', fs.existsSync(unpackedRoot));

// 3. mcp-server-entry.js is unpacked
check('mcp-server-entry.js unpacked', fs.existsSync(path.join(unpackedRoot, 'mcp-server-entry.js')));

// 4. ASAR path resolution fix for serverManager.js
const root1 = path.resolve(asarPath + '/src/main/mcp', '..', '..', '..');
let entry1 = path.join(root1, 'mcp-server-entry.js');
const fixed1 = entry1.replace(/\.asar([\\/])/, '.asar.unpacked$1');
check('serverManager path fix resolves to unpacked', fs.existsSync(fixed1));

// 5. ASAR path resolution fix for mcpConfigGen.js
const root2 = path.resolve(asarPath + '/src/main/runtime/drivers/shared', '..', '..', '..', '..', '..');
let entry2 = path.join(root2, 'mcp-server-entry.js');
const fixed2 = entry2.replace(/\.asar([\\/])/, '.asar.unpacked$1');
check('mcpConfigGen path fix resolves to unpacked', fs.existsSync(fixed2));

// 6. exe exists
check('MultiAgentNovelAssistant.exe exists', fs.existsSync(path.join(ROOT, 'dist', 'win-unpacked', 'MultiAgentNovelAssistant.exe')));

// 7. Verify ASAR does NOT contain dist/win-unpacked (recursive inclusion)
try {
  const asar = require('@electron/asar');
  const files = asar.listPackage(asarPath);
  const hasWinUnpacked = files.some(f => f.includes('win-unpacked'));
  check('ASAR does NOT contain dist/win-unpacked', !hasWinUnpacked);
  check('ASAR contains dist/index.html', files.some(f => f.endsWith('index.html')));
} catch (e) {
  console.log('  SKIP  @electron/asar check:', e.message);
}

console.log(`\n=== ${failed === 0 ? 'ALL CHECKS PASSED' : failed + ' CHECK(S) FAILED'} ===`);
process.exit(failed > 0 ? 1 : 0);
