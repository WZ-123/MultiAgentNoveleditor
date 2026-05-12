'use strict';

const path = require('node:path');
const { paths, generateId } = require('../store/paths');
const { appendJsonl } = require('../store/jsonStore');

let webContents = null;
const subscribers = new Map();

function setWebContents(wc) {
  webContents = wc;
}

function ensureRunId(runId) {
  return runId || generateId('run');
}

function logFileForRun(runId) {
  return path.join(paths().logs, `${runId}.jsonl`);
}

async function emit(event) {
  const payload = {
    runId: event.runId,
    pipelineRunId: event.pipelineRunId || null,
    nodeId: event.nodeId || null,
    subagentId: event.subagentId || null,
    kind: event.kind,
    data: event.data ?? null,
    ts: event.ts || Date.now(),
  };
  try {
    await appendJsonl(logFileForRun(payload.runId), payload);
  } catch (err) {
    console.error('[eventBus] log write failed', err);
  }
  if (webContents && !webContents.isDestroyed()) {
    try {
      webContents.send('agent:event', payload);
    } catch (err) {
      console.error('[eventBus] send failed', err);
    }
  }
  const subs = subscribers.get(payload.runId);
  if (subs) {
    for (const fn of subs) {
      try { fn(payload); } catch (err) { console.error('[eventBus] subscriber threw', err); }
    }
  }
  return payload;
}

async function emitPipeline(event) {
  const payload = {
    pipelineRunId: event.pipelineRunId,
    dagId: event.dagId || null,
    nodeId: event.nodeId || null,
    kind: event.kind,
    data: event.data ?? null,
    ts: event.ts || Date.now(),
  };
  try {
    if (payload.pipelineRunId) {
      await appendJsonl(logFileForRun(payload.pipelineRunId), { type: 'pipeline', ...payload });
    }
  } catch (err) {
    console.error('[eventBus] pipeline log write failed', err);
  }
  if (webContents && !webContents.isDestroyed()) {
    try {
      webContents.send('pipeline:event', payload);
    } catch (err) {
      console.error('[eventBus] pipeline send failed', err);
    }
  }
  const subs = subscribers.get(payload.pipelineRunId);
  if (subs) {
    for (const fn of subs) {
      try { fn(payload); } catch (err) { console.error('[eventBus] subscriber threw', err); }
    }
  }
  return payload;
}

function subscribe(runId, fn) {
  if (!subscribers.has(runId)) subscribers.set(runId, new Set());
  subscribers.get(runId).add(fn);
  return () => {
    const s = subscribers.get(runId);
    if (s) s.delete(fn);
  };
}

module.exports = { setWebContents, emit, emitPipeline, subscribe, ensureRunId };
