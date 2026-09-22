'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CodexRuntimeService } = require('../src/main/codex-runtime/codexRuntimeService');

class ProcessManagerStub extends EventEmitter {}

function session(index, lastUsedAt) {
  return {
    chatThreadId: `chat-${index}`,
    codexThreadId: `codex-thread-${index}`,
    grantId: `grant-${index}`,
    lastUsedAt,
  };
}

function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mana-thread-binding-lru-'));
  const previousRoot = process.env.MANA_USER_DATA_ROOT;
  process.env.MANA_USER_DATA_ROOT = root;
  const revoked = [];
  const runtime = new CodexRuntimeService({
    processManager: new ProcessManagerStub(),
    gateway: { on() {} },
    domainBridge: { on() {} },
    grantStore: { revoke(grantId) { revoked.push(grantId); } },
    store: { load: async () => {} },
  });
  const base = Date.now();
  for (let index = 0; index < 33; index += 1) {
    runtime.sessions.set(`session-${index}`, session(index, new Date(base + index * 1000).toISOString()));
  }

  try {
    runtime._pruneSessions();
    assert.equal(runtime.sessions.size, 32, 'the runtime must cap retained chat-thread bindings at 32');
    assert.equal(runtime.sessions.has('session-0'), false, 'the oldest idle binding must be evicted first');
    assert.equal(runtime.sessions.has('session-32'), true, 'the most recently used binding must remain available');
    assert.deepEqual(revoked, ['grant-0'], 'eviction must revoke the corresponding MCP capability grant');
    console.log('BOOT-B05 passed: 33 bindings retain the newest 32 and revoke the evicted grant.');
  } finally {
    if (previousRoot === undefined) delete process.env.MANA_USER_DATA_ROOT;
    else process.env.MANA_USER_DATA_ROOT = previousRoot;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

run();
