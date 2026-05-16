'use strict';

const { paths } = require('./paths');
const { readJson, writeJson } = require('./jsonStore');

const SCHEMA_VERSION = 2;

const DEFAULT_DRIVERS = {
  'claude-code-vscode': {
    kind: 'claude-code-vscode',
    binPath: '',
    autoDetectedPath: '',
    env: {},
    cwd: '',
    extra: { permissionMode: 'default', allowedToolPrefixes: ['mcp__novel-tools__'] },
  },
  'claude-code-cli': {
    kind: 'claude-code-cli',
    binPath: '',
    env: {},
    cwd: '',
    extra: {},
  },
  codex: {
    kind: 'codex',
    binPath: '',
    env: {},
    cwd: '',
    extra: {},
  },
  'direct-api': {
    kind: 'direct-api',
  },
};

const DEFAULT_APP_CONFIG = {
  schemaVersion: SCHEMA_VERSION,
  language: 'system',
  recents: [],
  lastNovelId: null,
  lastNovelDir: null,
  activeDriverId: 'direct-api',
  drivers: DEFAULT_DRIVERS,
  storageQuota: {
    chatHistoryMaxMB: 200,
    offlineLogMaxMB: 100,
  },
  searchEngine: 'auto',
  enrichmentConcurrency: 10,
  enrichmentMode: 'traditional',
  feishuSync: {
    enabled: false,
    endpointProfile: 'dev',
    appId: '',
    appSecret: '',
    appToken: '',
    tableId: '',
    // Relay mode: client talks to a relay server instead of Feishu directly.
    // When relayUrl is set, appId/appSecret/appToken/tableId are not used client-side.
    relayUrl: '',
    relayApiKey: '',
  },
};

function mergeDrivers(saved) {
  // Deep-merge each driver's config so newly-added drivers (e.g. when we add a
  // 5th driver in a future release) inherit defaults, while user-edited fields
  // on existing drivers (binPath, env, etc.) are preserved.
  const out = {};
  for (const id of Object.keys(DEFAULT_DRIVERS)) {
    out[id] = { ...DEFAULT_DRIVERS[id], ...(saved && saved[id]) };
  }
  // Preserve any user-added drivers that aren't in defaults (forward compat).
  if (saved && typeof saved === 'object') {
    for (const id of Object.keys(saved)) {
      if (!out[id]) out[id] = saved[id];
    }
  }
  return out;
}

function normalizeDrivers(saved) {
  const merged = mergeDrivers(saved);
  let changed = false;

  for (const id of Object.keys(merged)) {
    const next = { ...merged[id] };
    if (next.kind !== id) {
      next.kind = id;
      changed = true;
    }
    if (!saved || !saved[id]) {
      changed = true;
    }
    merged[id] = next;
  }

  return { drivers: merged, changed };
}

async function load() {
  const file = paths().appConfig;
  const data = await readJson(file, null);
  let changed = false;
  if (!data || typeof data !== 'object') {
    const next = { ...DEFAULT_APP_CONFIG, drivers: { ...DEFAULT_DRIVERS } };
    await writeJson(file, next);
    return next;
  }
  const { drivers, changed: driversChanged } = normalizeDrivers(data.drivers);
  const next = {
    ...DEFAULT_APP_CONFIG,
    ...data,
    feishuSync: { ...DEFAULT_APP_CONFIG.feishuSync, ...(data.feishuSync || {}) },
    drivers,
  };
  if (next.schemaVersion !== SCHEMA_VERSION) {
    next.schemaVersion = SCHEMA_VERSION;
    changed = true;
  }
  if (!next.activeDriverId || !next.drivers[next.activeDriverId]) {
    next.activeDriverId = 'direct-api';
    changed = true;
  }
  changed = changed || driversChanged;
  if (JSON.stringify(next.drivers) !== JSON.stringify(data.drivers || {})) changed = true;
  if (JSON.stringify(next) !== JSON.stringify(data)) {
    changed = true;
  }
  if (changed) {
    await writeJson(file, next);
  }
  return next;
}

async function save(patch) {
  const current = await load();
  const next = { ...current, ...patch, schemaVersion: SCHEMA_VERSION };
  // If patch.drivers is provided, deep-merge it so partial driver patches
  // (e.g. just updating one binPath) don't drop sibling driver configs.
  if (patch && patch.drivers) {
    next.drivers = mergeDrivers({ ...current.drivers, ...patch.drivers });
  } else {
    next.drivers = current.drivers;
  }
  // Deep-merge feishuSync so partial patches don't drop sibling fields.
  if (patch && patch.feishuSync) {
    next.feishuSync = { ...current.feishuSync, ...patch.feishuSync };
  } else {
    next.feishuSync = current.feishuSync;
  }
  await writeJson(paths().appConfig, next);
  return next;
}

module.exports = { load, save, DEFAULT_APP_CONFIG, DEFAULT_DRIVERS, SCHEMA_VERSION };
