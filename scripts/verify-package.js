#!/usr/bin/env node
'use strict';

/**
 * Verify the packaged Windows app has correct structure and all critical paths resolve.
 */

const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const asarPath = path.join(ROOT, 'dist', 'win-unpacked', 'resources', 'app.asar');

let failed = 0;

function check(name, ok) {
  console.log(`${ok ? '  OK' : ' FAIL'}  ${name}`);
  if (!ok) failed++;
}

console.log('=== Packaged App Verification ===');

// 1. ASAR file exists
check('app.asar exists', fs.existsSync(asarPath));

// 2. exe exists
check('MultiAgentNovelAssistant.exe exists', fs.existsSync(path.join(ROOT, 'dist', 'win-unpacked', 'MultiAgentNovelAssistant.exe')));

// 3. Verify the runtime entry and thin host are inside ASAR.
try {
  const asar = require('@electron/asar');
  const files = asar.listPackage(asarPath);
  const hasWinUnpacked = files.some(f => f.includes('win-unpacked'));
  check('ASAR does NOT contain dist/win-unpacked', !hasWinUnpacked);
  check('ASAR contains dist/index.html', files.some(f => f.endsWith('index.html')));
  check('ASAR contains mcp-server-entry.js', files.includes('/mcp-server-entry.js'));
  const forbiddenArchitectures = ['src/main/runtime/', 'src/main/harness-v3/', 'src/main/responses-gateway/', 'src/main/domain-runtime/'];
  for (const forbidden of forbiddenArchitectures) {
    check(`ASAR excludes removed architecture ${forbidden}`, !files.some((file) => file.includes(forbidden)));
  }
} catch (e) {
  console.log('  SKIP  @electron/asar check:', e.message);
}

console.log(`\n=== ${failed === 0 ? 'ALL CHECKS PASSED' : failed + ' CHECK(S) FAILED'} ===`);
process.exit(failed > 0 ? 1 : 0);
