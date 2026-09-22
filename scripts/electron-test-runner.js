#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

function safeLabel(value) {
  return String(value || 'electron-case').toLowerCase().replace(/[^a-z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '') || 'electron-case';
}

function terminateProcessTree(child, signal = 'SIGTERM') {
  if (!child?.pid || child.exitCode !== null) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', signal === 'SIGKILL' ? '/F' : ''], { stdio: 'ignore' });
    } else {
      process.kill(-child.pid, signal);
    }
  } catch {
    try { child.kill(signal); } catch { /* already gone */ }
  }
}

function parseMarkers(output) {
  const lines = String(output || '').split(/\r?\n/u);
  return {
    passed: lines.filter((line) => line.startsWith('TEST_PASS')).map((line) => line.slice('TEST_PASS'.length).trim()),
    failed: lines.filter((line) => line.startsWith('TEST_FAIL')).map((line) => line.slice('TEST_FAIL'.length).trim()),
    summaries: lines.filter((line) => line.startsWith('TEST_SUMMARY')).map((line) => line.slice('TEST_SUMMARY'.length).trim()),
    done: lines.some((line) => line.trim() === 'TEST_DONE'),
    screenshots: lines.filter((line) => line.startsWith('TEST_SCREENSHOT')).map((line) => line.slice('TEST_SCREENSHOT'.length).trim()),
  };
}

async function runManagedCase(options = {}) {
  const label = safeLabel(options.label);
  const diagnosticId = options.diagnosticId || `diag-${randomUUID()}`;
  const tempRoot = options.tempRoot || fs.mkdtempSync(path.join(os.tmpdir(), `mana-${label}-`));
  const userDataRoot = options.userDataRoot || path.join(tempRoot, 'user-data');
  const artifactRoot = options.artifactRoot || path.join(ROOT, 'artifacts', 'test-runs');
  fs.mkdirSync(userDataRoot, { recursive: true });
  fs.mkdirSync(artifactRoot, { recursive: true });
  const logPath = path.join(artifactRoot, `${label}-${diagnosticId}.log`);
  const log = fs.createWriteStream(logPath, { flags: 'w', mode: 0o600 });
  const startedAt = Date.now();
  const env = {
    ...process.env,
    ...options.env,
    MANA_USER_DATA_ROOT: userDataRoot,
    MANA_AUTOMATED_TEST: '1',
    MANA_TEST_DIAGNOSTIC_ID: diagnosticId,
    NODE_ENV: 'test',
  };
  delete env.ELECTRON_RUN_AS_NODE;

  const executable = options.executable;
  if (!executable) throw new Error('runManagedCase requires executable');
  const args = Array.isArray(options.args) ? options.args.map(String) : [];
  const child = spawn(executable, args, {
    cwd: options.cwd || ROOT,
    env,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  let phase = 'startup';
  let timedOut = false;
  let settled = false;
  let teardownTimer = null;
  const startupTimeoutMs = Math.max(100, Number(options.startupTimeoutMs) || 45_000);
  const testTimeoutMs = Math.max(100, Number(options.testTimeoutMs) || 180_000);
  const teardownTimeoutMs = Math.max(100, Number(options.teardownTimeoutMs) || 10_000);

  const append = (chunk) => {
    const text = chunk.toString('utf8');
    output += text;
    log.write(text);
    if (phase === 'startup' && /TEST_(?:PASS|FAIL|SUMMARY|DONE|SCREENSHOT)/u.test(output)) {
      phase = 'test';
      clearTimeout(activeTimer);
      activeTimer = setTimeout(() => timeout('test'), testTimeoutMs);
    }
    if (phase === 'test' && (/^TEST_DONE\s*$/mu.test(output) || /^TEST_SUMMARY\s+/mu.test(output))) {
      phase = 'teardown';
      clearTimeout(activeTimer);
      if (!teardownTimer) teardownTimer = setTimeout(() => timeout('teardown'), teardownTimeoutMs);
    }
  };
  child.stdout.on('data', append);
  child.stderr.on('data', append);

  const timeout = (timeoutPhase) => {
    if (settled) return;
    timedOut = true;
    phase = timeoutPhase;
    log.write(`\nTEST_RUNNER_TIMEOUT phase=${timeoutPhase} diagnosticId=${diagnosticId}\n`);
    terminateProcessTree(child, 'SIGTERM');
    setTimeout(() => terminateProcessTree(child, 'SIGKILL'), 2_000).unref();
  };
  let activeTimer = setTimeout(() => timeout('startup'), startupTimeoutMs);

  const result = await new Promise((resolve) => {
    child.once('error', (error) => resolve({ exitCode: null, signal: null, spawnError: error }));
    child.once('exit', (exitCode, signal) => resolve({ exitCode, signal, spawnError: null }));
  });
  settled = true;
  clearTimeout(activeTimer);
  if (teardownTimer) clearTimeout(teardownTimer);
  await new Promise((resolve) => log.end(resolve));

  const markers = parseMarkers(output);
  const terminalMarker = markers.done || markers.summaries.length > 0;
  const ok = !timedOut
    && !result.spawnError
    && result.exitCode === 0
    && markers.failed.length === 0
    && (options.requireMarkers === false || (markers.passed.length > 0 && terminalMarker));
  const receipt = {
    schemaVersion: 2,
    label,
    diagnosticId,
    command: [executable, ...args].join(' '),
    phase: ok ? 'completed' : phase,
    status: ok ? 'passed' : timedOut ? 'timed_out' : 'failed',
    exitCode: result.exitCode,
    signal: result.signal,
    durationMs: Date.now() - startedAt,
    markers,
    logPath,
    userDataRoot,
    errorCode: timedOut ? `${phase}_timeout` : result.spawnError ? 'spawn_failed' : result.exitCode !== 0 ? 'process_failed' : markers.failed.length ? 'assertion_failed' : !terminalMarker ? 'terminal_marker_missing' : '',
    message: timedOut
      ? `${phase} 阶段超时，进程树已终止。`
      : result.spawnError?.message || markers.failed[0] || (result.exitCode !== 0 ? `Electron exited with code ${result.exitCode}` : !terminalMarker ? '测试进程没有输出终态标记。' : ''),
  };

  const keep = !ok && options.keepUserDataOnFailure !== false;
  if (!keep) fs.rmSync(tempRoot, { recursive: true, force: true });
  return receipt;
}

async function runElectronCase(options = {}) {
  const electronExecutable = options.electronExecutable || require('electron');
  const appRoot = options.appRoot || ROOT;
  const flags = Array.isArray(options.flags) ? options.flags : [options.flag].filter(Boolean);
  return runManagedCase({
    ...options,
    executable: electronExecutable,
    args: [appRoot, '--no-sandbox', ...flags],
    cwd: appRoot,
  });
}

module.exports = {
  parseMarkers,
  runElectronCase,
  runManagedCase,
  safeLabel,
  terminateProcessTree,
};
