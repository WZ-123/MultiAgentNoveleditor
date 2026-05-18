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
    enabled: true,
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
  license: {
    authCode: '',
    verifiedUntil: '',
    deviceId: '',
  },
  updater: {
    skipVersion: '',
    autoDownload: false,
    lastCheckAt: '',
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

  // Merge feishuSync: saved non-empty values take precedence over defaults,
  // but empty strings do NOT override pre-seeded defaults (for beta builds).
  const savedFeishu = data.feishuSync || {};
  const feishuSync = { ...DEFAULT_APP_CONFIG.feishuSync };
  for (const key of Object.keys(DEFAULT_APP_CONFIG.feishuSync)) {
    const saved = savedFeishu[key];
    const hasSavedValue = saved !== undefined && saved !== null && saved !== '';
    if (hasSavedValue) {
      feishuSync[key] = saved;
    }
  }

  // Merge license: same rules as feishuSync
  const savedLicense = data.license || {};
  const license = { ...DEFAULT_APP_CONFIG.license };
  for (const key of Object.keys(DEFAULT_APP_CONFIG.license)) {
    const saved = savedLicense[key];
    const hasSavedValue = saved !== undefined && saved !== null && saved !== '';
    if (hasSavedValue) {
      license[key] = saved;
    }
  }

  // Merge updater: same rules as feishuSync
  const savedUpdater = data.updater || {};
  const updater = { ...DEFAULT_APP_CONFIG.updater };
  for (const key of Object.keys(DEFAULT_APP_CONFIG.updater)) {
    const saved = savedUpdater[key];
    const hasSavedValue = saved !== undefined && saved !== null && saved !== '';
    if (hasSavedValue) {
      updater[key] = saved;
    }
  }

  const next = {
    ...DEFAULT_APP_CONFIG,
    ...data,
    feishuSync,
    license,
    updater,
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
  // Deep-merge license so partial patches don't drop sibling fields.
  if (patch && patch.license) {
    next.license = { ...current.license, ...patch.license };
  } else {
    next.license = current.license;
  }
  // Deep-merge updater so partial patches don't drop sibling fields.
  if (patch && patch.updater) {
    next.updater = { ...current.updater, ...patch.updater };
  } else {
    next.updater = current.updater;
  }
  await writeJson(paths().appConfig, next);
  return next;
}

module.exports = { load, save, DEFAULT_APP_CONFIG, DEFAULT_DRIVERS, SCHEMA_VERSION };
