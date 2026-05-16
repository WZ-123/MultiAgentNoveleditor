const MAX_RENDERER_LOGS = 80;
const STORE_KEY = '__manaRecentRendererLogs';
const INSTALL_KEY = '__manaRecentRendererLogsInstalled';

function truncateText(value, limit = 1800) {
  const text = typeof value === 'string' ? value : value == null ? '' : String(value);
  if (!text || text.length <= limit) return text;
  return `${text.slice(0, limit)}...`;
}

function serializeValue(value) {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return truncateText(value.stack || value.message || String(value));
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function getStore() {
  if (typeof window === 'undefined') return [];
  if (!Array.isArray(window[STORE_KEY])) {
    window[STORE_KEY] = [];
  }
  return window[STORE_KEY];
}

function appendEntry(level, message, source = 'renderer') {
  if (typeof window === 'undefined') return;
  const entries = getStore();
  entries.push({
    timestamp: new Date().toISOString(),
    level,
    source,
    message: truncateText(message),
  });
  if (entries.length > MAX_RENDERER_LOGS) {
    entries.splice(0, entries.length - MAX_RENDERER_LOGS);
  }
}

export function installRecentRendererLogCapture() {
  if (typeof window === 'undefined' || window[INSTALL_KEY]) return;
  window[INSTALL_KEY] = true;

  for (const level of ['warn', 'error']) {
    const original = console[level];
    console[level] = (...args) => {
      try {
        appendEntry(level, args.map((arg) => serializeValue(arg)).join(' '), 'renderer-console');
      } catch {}
      return original.apply(console, args);
    };
  }

  window.addEventListener('error', (event) => {
    appendEntry('error', `${event.message || 'Unknown error'} @ ${event.filename || 'inline'}:${event.lineno || 0}:${event.colno || 0}`, 'window-error');
  });

  window.addEventListener('unhandledrejection', (event) => {
    appendEntry('error', `UnhandledRejection: ${serializeValue(event.reason)}`, 'window-rejection');
  });
}

export function getRecentRendererLogs(limit = 20) {
  return getStore().slice(-limit).map((entry) => ({ ...entry }));
}