'use strict';

const MAX_ENTRIES = 200;
const MAX_MESSAGE_LENGTH = 2400;

let installed = false;
let entries = [];

function truncateText(value, limit = MAX_MESSAGE_LENGTH) {
  const text = typeof value === 'string' ? value : value == null ? '' : String(value);
  if (!text || text.length <= limit) return text;
  return `${text.slice(0, limit)}...`;
}

function serializeValue(value) {
  if (typeof value === 'string') return value;
  if (value instanceof Error) {
    return truncateText(value.stack || value.message || String(value));
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function inferSource(message) {
  if (typeof message !== 'string') return 'main';
  if (message.includes('[codex')) return 'codex';
  if (message.includes('[offlineLog')) return 'offlineLog';
  return 'main';
}

function appendEntry({ level = 'info', source = 'main', message = '' }) {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    source,
    message: truncateText(message),
  };
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) {
    entries = entries.slice(-MAX_ENTRIES);
  }
  return entry;
}

function captureConsole(level, args) {
  const message = truncateText((args || []).map((arg) => serializeValue(arg)).join(' '));
  appendEntry({
    level,
    source: inferSource(message),
    message,
  });
}

function installConsoleCapture() {
  if (installed) return;
  installed = true;

  for (const level of ['log', 'info', 'warn', 'error']) {
    const original = console[level];
    console[level] = (...args) => {
      try {
        captureConsole(level, args);
      } catch {}
      return original.apply(console, args);
    };
  }

  process.on('uncaughtException', (err) => {
    try {
      appendEntry({
        level: 'error',
        source: 'main',
        message: truncateText(err?.stack || err?.message || String(err)),
      });
    } catch {}
  });

  process.on('unhandledRejection', (reason) => {
    try {
      appendEntry({
        level: 'error',
        source: 'main',
        message: truncateText(`UnhandledRejection: ${serializeValue(reason)}`),
      });
    } catch {}
  });
}

function getRecentEntries({ limit = 30, sources, levels } = {}) {
  const sourceSet = Array.isArray(sources) && sources.length ? new Set(sources) : null;
  const levelSet = Array.isArray(levels) && levels.length ? new Set(levels) : null;
  return entries
    .filter((entry) => (!sourceSet || sourceSet.has(entry.source)) && (!levelSet || levelSet.has(entry.level)))
    .slice(-limit)
    .map((entry) => ({ ...entry }));
}

function getLatestEntry({ sources, levels } = {}) {
  const result = getRecentEntries({ limit: MAX_ENTRIES, sources, levels });
  return result.length ? result[result.length - 1] : null;
}

function getFeedbackLogSnapshot() {
  return {
    latestMainProcessError: getLatestEntry({ sources: ['main', 'offlineLog'], levels: ['error', 'warn'] }),
    latestCodexError: getLatestEntry({ sources: ['codex'], levels: ['error', 'warn'] }),
    recentMainLogs: getRecentEntries({ limit: 20, sources: ['main', 'offlineLog'] }),
    recentCodexLogs: getRecentEntries({ limit: 20, sources: ['codex'] }),
  };
}

function _resetForTests() {
  entries = [];
}

module.exports = {
  appendEntry,
  installConsoleCapture,
  getRecentEntries,
  getFeedbackLogSnapshot,
  _resetForTests,
};
