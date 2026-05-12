'use strict';

/**
 * claudeProcess — small lifecycle helper for spawning Claude Code (`claude`)
 * as a subprocess, streaming its NDJSON stdout, and shutting it down
 * gracefully on cancel.
 *
 * Why a dedicated helper (instead of inlining child_process.spawn): the
 * VSCode and CLI drivers share the exact same spawn shape — only the
 * binPath differs. Centralizing the spawn logic ensures the cancel
 * escalation, line-buffering, and stderr capture stay consistent.
 *
 * Usage:
 *
 *   const proc = spawnClaude({ binPath, cwd, args, env });
 *   proc.onLine((line) => parser.parseLine(line).forEach(emit));
 *   proc.onStderr((chunk) => console.error(chunk));
 *   proc.writeStdin(JSON.stringify({type:'user', ...}) + '\n');
 *   proc.endStdin();
 *   const { exitCode, signal } = await proc.waitClose();
 *
 * Cancel:
 *   proc.cancel();             // SIGTERM, escalate to SIGKILL after 5s
 */

const { spawn } = require('node:child_process');
const { splitNdjson } = require('./streamJsonParser');

const DEFAULT_KILL_GRACE_MS = 5000;

/**
 * @typedef {object} SpawnClaudeOptions
 * @property {string} binPath               Absolute path to `claude` binary.
 * @property {string[]=} args               Extra argv beyond what the helper
 *                                          builds. The full args list is
 *                                          (args || []) + buildClaudeArgs(opts).
 * @property {string=} cwd                  Working directory.
 * @property {object=} env                  Env vars (merged onto process.env).
 * @property {number=} killGraceMs          ms before SIGTERM escalates to SIGKILL.
 * @property {object=} _spawn               Inject child_process.spawn for tests.
 */

/**
 * Build the canonical Claude Code argv for our use case.
 *
 * @param {object} o
 * @param {string=} o.appendSystemPrompt
 * @param {string=} o.mcpConfigPath
 * @param {string[]=} o.allowedTools        Default whitelist; flat list joined with ','.
 * @param {string=} o.permissionMode        Default 'default'.
 * @param {boolean=} o.includePartialMessages  Default true.
 * @returns {string[]}
 */
function buildClaudeArgs(o = {}) {
  const args = [
    '--print',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
  ];
  if (o.includePartialMessages !== false) args.push('--include-partial-messages');
  if (o.appendSystemPrompt) {
    args.push('--append-system-prompt', o.appendSystemPrompt);
  }
  if (o.mcpConfigPath) {
    args.push('--mcp-config', o.mcpConfigPath);
  }
  if (Array.isArray(o.allowedTools) && o.allowedTools.length) {
    args.push('--allowedTools', o.allowedTools.join(','));
  }
  args.push('--permission-mode', o.permissionMode || 'default');
  return args;
}

/**
 * Build the user-message NDJSON line that goes onto stdin.
 *
 * Claude Code's --input-format stream-json reads {type:'user', message:{...}}
 * envelopes the same way `messages` API entries look.
 */
function buildUserMessage(text) {
  return JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'text', text: String(text || '') }],
    },
  }) + '\n';
}

/**
 * Spawn Claude Code as a child process and return a control handle.
 *
 * @param {SpawnClaudeOptions} opts
 */
function spawnClaude(opts = {}) {
  if (!opts.binPath) throw new Error('spawnClaude: binPath required');

  const spawnFn = opts._spawn || spawn;
  const env = { ...process.env, ...(opts.env || {}) };
  const args = Array.isArray(opts.args) ? opts.args : [];
  const killGraceMs = typeof opts.killGraceMs === 'number' ? opts.killGraceMs : DEFAULT_KILL_GRACE_MS;

  const proc = spawnFn(opts.binPath, args, {
    cwd: opts.cwd || undefined,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  // ----- line buffering for stdout NDJSON -----
  let stdoutBuf = '';
  const lineHandlers = new Set();

  proc.stdout?.setEncoding?.('utf8');
  proc.stdout?.on?.('data', (chunk) => {
    stdoutBuf += chunk;
    const { lines, rest } = splitNdjson(stdoutBuf);
    stdoutBuf = rest;
    for (const line of lines) {
      if (!line) continue;
      for (const fn of lineHandlers) {
        try { fn(line); } catch (err) { /* swallow */ }
      }
    }
  });

  // ----- stderr capture -----
  let stderrBuf = '';
  const stderrHandlers = new Set();
  proc.stderr?.setEncoding?.('utf8');
  proc.stderr?.on?.('data', (chunk) => {
    stderrBuf += chunk;
    for (const fn of stderrHandlers) {
      try { fn(chunk); } catch (err) { /* swallow */ }
    }
  });

  // ----- close promise -----
  let resolved = false;
  let exitInfo = null;
  const closeWaiters = [];
  function resolveClose(info) {
    if (resolved) return;
    resolved = true;
    exitInfo = info;
    // Flush any trailing partial buffer through line handlers (though by
    // contract Claude Code always ends each event with \n, we don't trust
    // it 100%).
    if (stdoutBuf.trim()) {
      for (const fn of lineHandlers) {
        try { fn(stdoutBuf); } catch { /* ignore */ }
      }
      stdoutBuf = '';
    }
    for (const w of closeWaiters) w(info);
  }

  proc.on('error', (err) => {
    resolveClose({ exitCode: -1, signal: null, error: err });
  });
  proc.on('exit', (exitCode, signal) => {
    resolveClose({ exitCode, signal, error: null });
  });

  function waitClose() {
    if (resolved) return Promise.resolve(exitInfo);
    return new Promise((resolve) => closeWaiters.push(resolve));
  }

  // ----- cancellation -----
  let killScheduled = false;
  function cancel(reason) {
    if (resolved || killScheduled) return;
    killScheduled = true;
    try { proc.kill('SIGTERM'); } catch { /* ignore */ }
    setTimeout(() => {
      if (resolved) return;
      try { proc.kill('SIGKILL'); } catch { /* ignore */ }
    }, killGraceMs).unref?.();
  }

  // ----- stdin helpers -----
  function writeStdin(data) {
    if (!proc.stdin || proc.stdin.destroyed) return false;
    try {
      proc.stdin.write(data);
      return true;
    } catch {
      return false;
    }
  }
  function endStdin() {
    if (!proc.stdin || proc.stdin.destroyed) return;
    try { proc.stdin.end(); } catch { /* ignore */ }
  }

  // ----- subscribe helpers -----
  function onLine(fn) {
    lineHandlers.add(fn);
    return () => lineHandlers.delete(fn);
  }
  function onStderr(fn) {
    stderrHandlers.add(fn);
    return () => stderrHandlers.delete(fn);
  }
  function getStderrSnapshot() { return stderrBuf; }

  return {
    proc,
    pid: proc.pid,
    onLine,
    onStderr,
    writeStdin,
    endStdin,
    cancel,
    waitClose,
    getStderrSnapshot,
    isRunning: () => !resolved,
  };
}

module.exports = {
  spawnClaude,
  buildClaudeArgs,
  buildUserMessage,
  DEFAULT_KILL_GRACE_MS,
};
