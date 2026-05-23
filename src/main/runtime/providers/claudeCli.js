'use strict';

/**
 * Claude CLI provider.
 *
 * Minimal Phase 4 implementation: spawn `claude --print --output-format stream-json
 * --input-format stream-json --append-system-prompt <system>` and stream JSONL
 * back-and-forth. Does NOT yet support MCP tool wiring (sa* with tools should
 * use the anthropic or openai-compat providers until --mcp-config is wired).
 *
 * The provider degrades gracefully: if the `claude` CLI is missing on PATH it
 * throws a clear error so the runtime can show it to the user.
 */

const { spawn, spawnSync } = require('node:child_process');

let cliCheckedAvailable = null;

function checkAvailable() {
  if (cliCheckedAvailable !== null) return cliCheckedAvailable;
  try {
    const r = spawnSync('claude', ['--version'], { encoding: 'utf8', timeout: 3000 });
    cliCheckedAvailable = r.status === 0;
  } catch {
    cliCheckedAvailable = false;
  }
  return cliCheckedAvailable;
}

function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m.role === 'user') {
      if (typeof m.content === 'string') return m.content;
      if (Array.isArray(m.content)) {
        return m.content.filter((b) => b?.type === 'text').map((b) => b.text || '').join('\n');
      }
    }
  }
  return '';
}

async function sendMessage(opts) {
  const { system, messages, tier, abortSignal, onEvent, runId, nodeId, subagentId } = opts;

  if (!checkAvailable()) {
    throw new Error('claude CLI not found on PATH; install Claude Code to use this provider.');
  }

  const userText = lastUserText(messages);

  const args = ['--print'];
  if (tier?.model) {
    args.push('--model', tier.model);
  }
  if (system) {
    args.push('--append-system-prompt', system);
  }
  // Output format: plain text for the minimal version. Tool wiring needs
  // stream-json + --mcp-config which is intentionally deferred.
  args.push(userText);

  return await new Promise((resolve, reject) => {
    const proc = spawn('claude', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const onAbort = () => {
      try { proc.kill(process.platform === 'win32' ? undefined : 'SIGTERM'); } catch { /* ignore */ }
    };
    if (abortSignal) {
      if (abortSignal.aborted) onAbort();
      else abortSignal.addEventListener('abort', onAbort, { once: true });
    }
    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => {
      stdout += chunk;
      onEvent && onEvent({ runId, nodeId, subagentId, kind: 'text', data: { delta: chunk } });
    });
    proc.stderr.on('data', (chunk) => { stderr += chunk; });
    proc.on('error', (err) => reject(err));
    proc.on('close', (code) => {
      if (abortSignal?.aborted) {
        reject(new DOMException('aborted', 'AbortError'));
        return;
      }
      if (code !== 0) {
        reject(new Error(`claude CLI exit ${code}: ${stderr.slice(0, 500)}`));
        return;
      }
      resolve({
        stopReason: 'end_turn',
        content: [{ type: 'text', text: stdout.trim() }],
      });
    });
  });
}

module.exports = { sendMessage, checkAvailable };
