'use strict';

const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { auditCodexSessions } = require('./deepseek-live-novella-ui-e2e');

async function run() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'mana-novella-audit-'));
  process.env.MANA_USER_DATA_ROOT = root;
  const sessionDir = path.join(root, 'codex-home', 'sessions', '2026', '09', '01');
  try {
    await fsp.mkdir(sessionDir, { recursive: true });
    const now = Date.now();
    const rows = [
      { timestamp: new Date(now).toISOString(), type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-1' } },
      { timestamp: new Date(now + 1).toISOString(), type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 200, reasoning_output_tokens: 50, total_tokens: 1200 } } } },
      { timestamp: new Date(now + 2).toISOString(), type: 'event_msg', payload: { type: 'mcp_tool_call_end', invocation: { tool: 'read_novel_resource' }, result: { Ok: {} } } },
      { timestamp: new Date(now + 3).toISOString(), type: 'event_msg', payload: { type: 'patch_apply_end', success: true } },
      { timestamp: new Date(now + 5000).toISOString(), type: 'event_msg', payload: { type: 'task_complete', duration_ms: 5000, time_to_first_token_ms: 800 } },
    ];
    await fsp.writeFile(path.join(sessionDir, 'rollout.jsonl'), `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
    const audit = await auditCodexSessions(now - 10);
    assert.equal(audit.physicalProviderCalls, 1);
    assert.equal(audit.usage.total_tokens, 1200);
    assert.equal(audit.uncachedInputTokens, 200);
    assert.equal(audit.cacheHitRate, 0.8);
    assert.equal(audit.turns[0].durationMs, 5000);
    assert.equal(audit.turns[0].mcpCalls, 1);
    assert.deepEqual(audit.mcpErrors, []);
    assert.deepEqual(audit.patchFailures, []);
    console.log('deepseek-live-novella-audit-regression: ok');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
