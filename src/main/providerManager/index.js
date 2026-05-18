'use strict';

/**
 * In-app provider manager for Direct API mode.
 * Reads/writes provider config directly under <userData>/providers.json.
 * No longer manages external Claude Code environment variables.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readJson, writeJson } = require('../store/jsonStore');
const { paths: appPaths } = require('../store/paths');

const SCHEMA_VERSION = 2;
const CURRENT_ENV_FILE = path.join(os.homedir(), '.ccs', 'current-env.json');
const CCS_LEGACY_PROVIDERS = path.join(os.homedir(), '.claude', 'providers.json');

let cachedEnv = null;
let cachedEnvMtimeMs = 0;
let providersCache = null;

function _providersFile() {
  return path.join(appPaths().root, 'providers.json');
}

function _normalizeId(name) {
  return String(name).trim().toLowerCase().replace(/\s+/g, '-');
}

function inferProviderType(provider) {
  const baseUrl = String(provider?.baseUrl || '').trim().toLowerCase().replace(/\/$/, '');
  const id = String(provider?.id || '').trim().toLowerCase();
  const name = String(provider?.name || '').trim().toLowerCase();
  if (id === 'anthropic' || name === 'anthropic') return 'anthropic';
  if (!baseUrl) return 'openai-compat';
  if (baseUrl.includes('/anthropic')) return 'anthropic';
  if (baseUrl.includes('api.anthropic.com')) return 'anthropic';
  return 'openai-compat';
}

function _builtinAnthropic() {
  return {
    id: 'anthropic',
    name: 'Anthropic',
    type: 'anthropic',
    baseUrl: '',
    apiKey: '',
    isBuiltin: true,
    models: [
      { id: 'claude-opus-4-7',   name: 'Claude Opus 4.7',   contextWindow: 200000 },
      { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', contextWindow: 200000 },
      { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5', contextWindow: 200000 },
    ],
  };
}

function _defaultState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    providers: [_builtinAnthropic()],
    activeProviderId: 'anthropic',
  };
}

function _upgradeProvider(p) {
  if (!p) return p;
  if (!p.type) {
    p.type = inferProviderType(p);
  }
  if (!Array.isArray(p.models)) {
    // Soft migration: seed with a single default model derived from provider name
    const modelId = p.id === 'anthropic' ? 'claude-sonnet-4-6' : _normalizeId(p.name);
    const modelName = p.id === 'anthropic' ? 'Claude Sonnet 4.6' : p.name;
    p.models = [
      { id: modelId, name: modelName, contextWindow: 200000 },
    ];
  }
  return p;
}

async function _loadState() {
  if (providersCache) return providersCache;
  const file = _providersFile();
  let state = await readJson(file, null);
  let changed = false;

  if (!state || typeof state !== 'object') {
    state = await _tryMigrateFromCcs();
    if (state) changed = true;
  }

  if (!state || typeof state !== 'object') {
    state = _defaultState();
    changed = true;
  }

  state.schemaVersion = SCHEMA_VERSION;
  if (!Array.isArray(state.providers)) state.providers = [];
  if (!state.providers.find((p) => p.id === 'anthropic')) {
    state.providers.unshift(_builtinAnthropic());
    changed = true;
  }
  state.providers.forEach((p) => {
    if (p.id === 'anthropic') p.isBuiltin = true;
    const beforeType = p.type;
    _upgradeProvider(p);
    if (beforeType !== p.type) changed = true;
  });
  if (!state.activeProviderId) {
    state.activeProviderId = 'anthropic';
    changed = true;
  }

  if (changed) {
    await writeJson(file, state);
  }

  providersCache = state;
  return state;
}

async function _saveState(state) {
  const file = _providersFile();
  await writeJson(file, state);
  providersCache = state;
}

async function _tryMigrateFromCcs() {
  try {
    const legacy = await readJson(CCS_LEGACY_PROVIDERS, null);
    if (!legacy || typeof legacy !== 'object') return null;
    const providers = [_builtinAnthropic()];
    for (const [name, cfg] of Object.entries(legacy)) {
      const id = _normalizeId(name);
      if (id === 'anthropic') continue;
      providers.push({
        id,
        name,
        type: inferProviderType({ id, name, baseUrl: cfg.base_url || '' }),
        baseUrl: cfg.base_url || '',
        apiKey: cfg.api_key || '',
        isBuiltin: false,
        models: [
          { id, name, contextWindow: 200000 },
        ],
      });
    }
    let activeId = 'anthropic';
    const env = _readCurrentEnvSync();
    if (env?.ANTHROPIC_BASE_URL) {
      const match = providers.find((p) => p.baseUrl === env.ANTHROPIC_BASE_URL);
      if (match) activeId = match.id;
    }
    return { schemaVersion: SCHEMA_VERSION, providers, activeProviderId: activeId };
  } catch {
    return null;
  }
}

function _readCurrentEnvSync() {
  try {
    const stat = fs.statSync(CURRENT_ENV_FILE);
    if (cachedEnv && stat.mtimeMs === cachedEnvMtimeMs) return cachedEnv;
    const raw = fs.readFileSync(CURRENT_ENV_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      cachedEnv = parsed;
      cachedEnvMtimeMs = stat.mtimeMs;
      return cachedEnv;
    }
  } catch { /* missing or unreadable */ }
  cachedEnv = null;
  cachedEnvMtimeMs = 0;
  return null;
}

// ---------- Public API ----------

function detect() {
  return { available: true, version: 'builtin' };
}

async function list() {
  const state = await _loadState();
  return state.providers.map((p) => ({
    id: p.id,
    name: p.name,
    type: p.type,
    baseUrl: p.baseUrl,
    active: p.id === state.activeProviderId,
    models: p.models || [],
    isBuiltin: !!p.isBuiltin,
  }));
}

async function current() {
  const state = await _loadState();
  const p = state.providers.find((p) => p.id === state.activeProviderId);
  if (!p) return null;
  return { id: p.id, name: p.name, type: p.type, baseUrl: p.baseUrl, models: p.models || [] };
}

async function getProvider(id) {
  const state = await _loadState();
  const normalizedId = _normalizeId(id || '');
  return state.providers.find((p) => p.id === normalizedId) || null;
}

async function getActiveProvider() {
  const state = await _loadState();
  return state.providers.find((p) => p.id === state.activeProviderId) || null;
}

async function use(name) {
  if (!name || typeof name !== 'string') throw new Error('use(name): name required');
  const state = await _loadState();
  const id = _normalizeId(name);
  const provider = state.providers.find((p) => p.id === id);
  if (!provider) throw new Error(`Provider '${name}' not found`);

  state.activeProviderId = id;
  await _saveState(state);

  return { ok: true };
}

async function add({ name, type, baseUrl, apiKey } = {}) {
  if (!name || typeof name !== 'string') throw new Error('add: name required');
  const state = await _loadState();
  const id = _normalizeId(name);
  if (state.providers.find((p) => p.id === id)) {
    throw new Error(`Provider '${name}' already exists`);
  }
  state.providers.push({
    id,
    name: name.trim(),
    type: type || inferProviderType({ id, name, baseUrl }),
    baseUrl: (baseUrl || '').trim(),
    apiKey: (apiKey || '').trim(),
    isBuiltin: false,
    models: [],
  });
  await _saveState(state);
  return { ok: true };
}

async function remove(name) {
  if (!name || typeof name !== 'string') throw new Error('remove: name required');
  const state = await _loadState();
  const id = _normalizeId(name);
  const idx = state.providers.findIndex((p) => p.id === id);
  if (idx === -1) throw new Error(`Provider '${name}' not found`);
  if (state.providers[idx].isBuiltin) {
    throw new Error(`Cannot remove built-in provider '${name}'`);
  }
  state.providers.splice(idx, 1);
  if (state.activeProviderId === id) {
    state.activeProviderId = 'anthropic';
  }
  await _saveState(state);
  return { ok: true };
}

async function addModel(providerId, model) {
  if (!providerId || !model || !model.id) throw new Error('addModel: providerId and model.id required');
  const state = await _loadState();
  const p = state.providers.find((p) => p.id === _normalizeId(providerId));
  if (!p) throw new Error(`Provider '${providerId}' not found`);
  if (!Array.isArray(p.models)) p.models = [];
  const idx = p.models.findIndex((m) => m.id === model.id);
  if (idx >= 0) {
    p.models[idx] = { ...p.models[idx], ...model };
  } else {
    p.models.push(model);
  }
  await _saveState(state);
  return { ok: true };
}

async function removeModel(providerId, modelId) {
  const state = await _loadState();
  const p = state.providers.find((p) => p.id === _normalizeId(providerId));
  if (!p) throw new Error(`Provider '${providerId}' not found`);
  if (!Array.isArray(p.models)) p.models = [];
  p.models = p.models.filter((m) => m.id !== modelId);
  await _saveState(state);
  return { ok: true };
}

async function discoverModels(providerId) {
  const state = await _loadState();
  const p = state.providers.find((p) => p.id === _normalizeId(providerId));
  if (!p) throw new Error(`Provider '${providerId}' not found`);
  if (p.isBuiltin) {
    return { ok: false, error: 'Auto-discovery is not available for built-in Anthropic provider. Models are maintained manually.' };
  }
  const baseUrl = (p.baseUrl || '').replace(/\/$/, '');
  if (!baseUrl) {
    return { ok: false, error: 'Provider baseUrl is required for model discovery.' };
  }
  try {
    const res = await fetch(`${baseUrl}/v1/models`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${p.apiKey || ''}`,
        'Content-Type': 'application/json',
      },
    });
    if (!res.ok) {
      const text = await res.text();
      return { ok: false, error: `Discovery failed (${res.status}): ${text}` };
    }
    const data = await res.json();
    const models = (data.data || [])
      .filter((m) => m.object === 'model')
      .map((m) => ({ id: m.id, name: m.id }));
    return { ok: true, models };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

function getActiveEnv() {
  return _readCurrentEnvSync();
}

module.exports = {
  detect,
  list,
  current,
  getProvider,
  getActiveProvider,
  use,
  add,
  remove,
  addModel,
  removeModel,
  discoverModels,
  getActiveEnv,
  inferProviderType,
};
