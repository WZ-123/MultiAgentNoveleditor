'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const tests = [
  'test/chat-chain-contract.test.js',
  'test/chat-chain-lan.test.js',
  'test/model-metadata.test.js',
  'test/model-config-v6.test.js',
  'test/model-config-v8-setup.test.js',
  'test/responses-verification-lifecycle.test.js',
  'test/codex-native-cutover.test.js',
  'test/deepseek-no-reasoning-bridge.test.js',
  'test/deepseek-novella-consistency-cache.test.js',
  'test/exact-duplicate-cleanup.test.js',
  'test/narrative-pov-cleanup.test.js',
  'test/native-novel-workspace.test.js',
  'test/native-patch-read-after-write.test.js',
  'test/native-existing-resource-update.test.js',
  'test/task-ledger-resource-contract.test.js',
  'test/writing-authorization-policy.test.js',
  'test/codex-native-apply-patch.test.js',
  'test/codex-continuous-writing.test.js',
  'test/codex-native-mutation-loop.test.js',
  'test/novel-mcp-mutation.test.js',
  'test/de-ai-minimality-regression.test.js',
];

for (const test of tests) {
  const result = spawnSync(process.execPath, [test], { cwd: root, env: process.env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log(`unit suite: ok (${tests.length} files)`);
