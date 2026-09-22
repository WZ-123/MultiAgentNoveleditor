'use strict';

const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { paths } = require('../store/paths');

function plainText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.filter((item) => item?.type === 'text').map((item) => String(item.text || '')).join('\n');
  if (value && typeof value === 'object') return plainText(value.content || value.output || value.text || '');
  return '';
}

function normalizeTaskConstraints(value = {}) {
  const source = value && typeof value === 'object' ? value : {};
  const strings = (items) => [...new Set((Array.isArray(items) ? items : []).map(String).map((item) => item.trim()).filter(Boolean))];
  const integer = (item) => item !== null && item !== undefined && item !== '' && Number.isSafeInteger(Number(item)) && Number(item) >= 0 ? Number(item) : null;
  return {
    operation: source.operation ? String(source.operation) : 'unspecified',
    targetResourceRefs: strings(source.targetResourceRefs),
    allowedWriteResourceRefs: strings(source.allowedWriteResourceRefs),
    minBodyCjk: integer(source.minBodyCjk),
    maxBodyCjk: integer(source.maxBodyCjk),
    completionEvidence: strings(source.completionEvidence),
    prohibitRepetition: source.prohibitRepetition === true,
    requiresCompleteEnding: source.requiresCompleteEnding === true,
  };
}

class TaskLedger {
  constructor(options = {}) {
    this.file = options.file || path.join(paths().root, 'codex-task-ledger.jsonl');
    this.queue = Promise.resolve();
    this.tasks = new Map();
    this.recovered = false;
  }

  append(entry) {
    const row = { schemaVersion: 1, eventId: crypto.randomUUID(), timestamp: new Date().toISOString(), ...entry };
    this.queue = this.queue.catch(() => {}).then(async () => {
      await fsp.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      if (!this.recovered) {
        this.recovered = true;
        let prior = [];
        try { prior = (await fsp.readFile(this.file, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)); } catch { prior = []; }
        const open = new Map();
        for (const item of prior) {
          if (item.type === 'task_started') open.set(item.runId, item);
          if (['task_finished', 'task_attempt_rejected', 'task_abandoned'].includes(item.type)) open.delete(item.runId);
        }
        for (const item of open.values()) {
          const abandoned = { schemaVersion: 1, eventId: crypto.randomUUID(), timestamp: new Date().toISOString(), type: 'task_abandoned', taskId: item.taskId, attemptId: item.attemptId, runId: item.runId, outcome: 'host_stopped_before_terminal_event' };
          await fsp.appendFile(this.file, `${JSON.stringify(abandoned)}\n`, { encoding: 'utf8', mode: 0o600 });
        }
      }
      await fsp.appendFile(this.file, `${JSON.stringify(row)}\n`, { encoding: 'utf8', mode: 0o600 });
    });
    return this.queue;
  }

  start({ taskId, attemptId, runId, conversationId, constraints, route }) {
    const startedAt = Date.now();
    const state = { taskId, attemptId, runId, startedAt, firstTextAt: null, firstCommitAt: null, confirmationWaitMs: 0, confirmationStarted: new Map(), toolStarted: new Map(), toolDurationMs: 0, commitCount: 0, toolErrors: 0 };
    this.tasks.set(runId, state);
    return this.append({ type: 'task_started', taskId, attemptId, runId, conversationId: conversationId || null, constraints: normalizeTaskConstraints(constraints), route });
  }

  record(runId, type, details = {}) {
    const state = this.tasks.get(runId);
    if (!state) return Promise.resolve();
    const now = Date.now();
    if (type === 'text_delta' && !state.firstTextAt && plainText(details.delta)) state.firstTextAt = now;
    if (type === 'confirmation_requested') state.confirmationStarted.set(details.confirmationId, now);
    if (type === 'confirmation_resolved') {
      const start = state.confirmationStarted.get(details.confirmationId);
      if (start) state.confirmationWaitMs += now - start;
      state.confirmationStarted.delete(details.confirmationId);
    }
    if (type === 'tool_started' && details.itemId) state.toolStarted.set(details.itemId, now);
    if (type === 'tool_completed' && details.itemId) {
      const start = state.toolStarted.get(details.itemId);
      if (start) state.toolDurationMs += now - start;
      state.toolStarted.delete(details.itemId);
      if (details.ok === false) state.toolErrors += 1;
    }
    if (type === 'commit_completed') {
      state.commitCount += 1;
      if (!state.firstCommitAt) state.firstCommitAt = now;
    }
    const stored = { ...details };
    if (type === 'text_delta') {
      const delta = plainText(details.delta);
      stored.deltaLength = delta.length;
      stored.deltaSha256 = delta ? crypto.createHash('sha256').update(delta).digest('hex') : null;
      delete stored.delta;
    }
    if (type === 'tool_completed' && Object.hasOwn(stored, 'output')) {
      const output = plainText(stored.output);
      stored.output = {
        format: Array.isArray(details.output) ? 'text-block-array' : typeof details.output,
        textLength: output.length,
        textSha256: output ? crypto.createHash('sha256').update(output).digest('hex') : null,
        ...(details.ok === false && output ? { errorExcerpt: output.slice(0, 500) } : {}),
      };
    }
    return this.append({ type, taskId: state.taskId, attemptId: state.attemptId, runId, ...stored });
  }

  finish(runId, outcome, details = {}) {
    const state = this.tasks.get(runId);
    if (!state) return Promise.resolve();
    const finishedAt = Date.now();
    for (const start of state.confirmationStarted.values()) state.confirmationWaitMs += finishedAt - start;
    for (const start of state.toolStarted.values()) state.toolDurationMs += finishedAt - start;
    this.tasks.delete(runId);
    return this.append({
      type: 'task_finished', taskId: state.taskId, attemptId: state.attemptId, runId, outcome,
      totalDurationMs: finishedAt - state.startedAt,
      modelDurationMs: Math.max(0, finishedAt - state.startedAt - state.confirmationWaitMs - state.toolDurationMs),
      confirmationWaitMs: state.confirmationWaitMs,
      toolDurationMs: state.toolDurationMs,
      timeToFirstTextMs: state.firstTextAt ? state.firstTextAt - state.startedAt : null,
      timeToFirstCommitMs: state.firstCommitAt ? state.firstCommitAt - state.startedAt : null,
      commitCount: state.commitCount, toolErrors: state.toolErrors, ...details,
    });
  }
}

module.exports = { TaskLedger, normalizeTaskConstraints, plainText };
