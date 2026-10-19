'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const tests = [
  'test/runtime-recovery-confirmation.test.js',
  'test/runtime-transport-recovery.test.js',
  'test/model-setup-id.test.js',
  'test/import-authority-regression.test.js',
  'test/import-transaction-p1.test.js',
  'test/project-transactions-review.test.js',
  'test/data-import-safety.test.js',
  'test/import-saga-regression.test.js',
  'test/import-atomic-boundary-regression.test.js',
  'test/import-duplicate-character-merge-regression.test.js',
  'test/character-enricher-validate-regression.test.js',
  'test/editor-save-race-regression.test.js',
  'test/chapter-save-snapshot-regression.test.js',
  'test/novel-structure-persistence.test.js',
  'test/next-chapter-wordcount.test.js',
  'test/chat-feedback-payload.test.js',
  'test/feedback-sync.test.js',
  'test/feedback-path-security.test.js',
  'test/chat-chain-contract.test.js',
  'test/chat-chain-lan.test.js',
  'test/model-metadata.test.js',
  'test/model-config-v6.test.js',
  'test/model-config-v8-setup.test.js',
  'test/model-config-discard-ipc.test.js',
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
  'test/task-completion-state.test.js',
  'test/writing-workflow-safety.test.js',
  'test/writing-preparation.test.js',
  'test/writing-preparation-stage.test.js',
  'test/ordinary-writing-entry.test.js',
  'test/writing-lifecycle-boundaries.test.js',
  'test/writing-provider-completion.test.js',
  'test/writing-native-truncation.test.js',
  'test/review-ledger-contract.test.js',
  'test/narrative-audit.test.js',
  'test/writing-intent-context.test.js',
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
