'use strict';

const path = require('node:path');
const { paths, generateId } = require('../store/paths');
const { appendJsonl } = require('../store/jsonStore');
const clientEvents = require('./clientEvents');

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

function isThinkingEvent(event) {
  const kind = String(event?.kind || '').trim().toLowerCase();
  if (['thinking', 'analysis', 'reasoning'].includes(kind)) return true;
  if (kind !== 'text') return false;
  const data = event?.data;
  if (data?.thinking === true || data?.reasoning === true || data?.internal === true) return true;
  const internalLabels = new Set(['thinking', 'analysis', 'reasoning', 'internal', 'hidden']);
  return [data?.channel, data?.visibility, data?.stream]
    .map((value) => String(value || '').trim().toLowerCase())
    .some((value) => internalLabels.has(value));
}

function thinkingCharCount(data) {
  if (typeof data === 'string') return data.length;
  if (!data || typeof data !== 'object') return 0;
  for (const key of ['thinking', 'delta', 'text', 'reasoning', 'reasoning_content', 'content']) {
    if (typeof data[key] === 'string') return data[key].length;
  }
  return 0;
}

/**
 * Thinking content is runtime-private. Keep only aggregate telemetry at the
 * event bus boundary so logs, Electron IPC, remote clients, and subscribers
 * can never observe the raw model reasoning. The legacy `text + thinking`
 * shape is canonicalized too, preventing old producers from bypassing this
 * boundary or being mistaken for user-visible assistant text.
 */
function normalizeEventForEmission(event) {
  if (!isThinkingEvent(event)) return event;
  return {
    ...event,
    kind: 'thinking',
    data: {
      redacted: true,
      charCount: thinkingCharCount(event.data),
    },
  };
}

async function emit(event) {
  const normalizedEvent = normalizeEventForEmission(event);
  const payload = {
    runId: normalizedEvent.runId,
    nodeId: normalizedEvent.nodeId || null,
    subagentId: normalizedEvent.subagentId || null,
    kind: normalizedEvent.kind,
    data: normalizedEvent.data ?? null,
    ts: normalizedEvent.ts || Date.now(),
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
  clientEvents.emit('agent:event', payload);
  const subs = subscribers.get(payload.runId);
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

module.exports = { setWebContents, emit, subscribe, ensureRunId };
