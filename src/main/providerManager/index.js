'use strict';

/**
 * In-app provider manager for Direct API mode.
 * Reads/writes provider config directly under <userData>/providers.json.
 * No longer manages external Claude Code environment variables.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
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

function getProviderStateTokenSync() {
  const file = _providersFile();
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const hash = crypto.createHash('sha1').update(raw).digest('hex');
    return `providers:${hash}`;
  } catch (err) {
    if (err?.code === 'ENOENT') return `providers:missing:v${SCHEMA_VERSION}`;
    return `providers:error:${err?.code || 'unknown'}`;
  }
}

function _normalizeId(name) {
  return String(name).trim().toLowerCase().replace(/\s+/g, '-');
}

function inferProviderType(provider) {
  if (provider?.type === 'anthropic' || provider?.type === 'openai-compat') return provider.type;
  const baseUrl = String(provider?.baseUrl || '').trim().toLowerCase().replace(/\/$/, '');
  const id = String(provider?.id || '').trim().toLowerCase();
  const name = String(provider?.name || '').trim().toLowerCase();
  if (id === 'anthropic' || name === 'anthropic') return 'anthropic';
  if (!baseUrl) return 'openai-compat';
  if (baseUrl.includes('/anthropic')) return 'anthropic';
  if (baseUrl.includes('api.anthropic.com')) return 'anthropic';
  return 'openai-compat';
}

function _numberFromAny(...values) {
  for (const value of values) {
    if (value == null || value === '') continue;
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return undefined;
}

function _boolFromAny(...values) {
  for (const value of values) {
    if (value === true || value === 'true') return true;
    if (value === false || value === 'false') return false;
  }
  return undefined;
}

function _inferModelCapabilities(modelId, providerType) {
  const id = String(modelId || '').toLowerCase();
  const caps = {
    contextWindow: providerType === 'anthropic' ? 200000 : 128000,
    maxOutputTokens: providerType === 'anthropic' ? 8192 : 4096,
    supportsThinking: false,
    thinkingBudget: 0,
  };

  if (id.includes('claude')) {
    caps.contextWindow = 200000;
    caps.maxOutputTokens = 8192;
    caps.supportsThinking = /opus|sonnet/.test(id);
    caps.thinkingBudget = caps.supportsThinking ? 32000 : 0;
  }

  if (id.includes('gpt-5') || id.includes('gpt-4.1') || id.includes('o3') || id.includes('o4')) {
    caps.contextWindow = 128000;
    caps.maxOutputTokens = id.includes('mini') || id.includes('nano') ? 8192 : 16384;
    caps.supportsThinking = id.includes('gpt-5') || /^o[134]/.test(id);
    caps.thinkingBudget = caps.supportsThinking ? 16000 : 0;
  }

  if (id.includes('deepseek-v4') || id.includes('dsv4')) {
    caps.contextWindow = 1024000;
    caps.maxOutputTokens = id.includes('flash') ? 4096 : 8192;
    caps.supportsThinking = !id.includes('flash');
    caps.thinkingBudget = caps.supportsThinking ? 32000 : 0;
  } else if (id.includes('deepseek-reasoner')) {
    caps.contextWindow = 64000;
    caps.maxOutputTokens = 8192;
    caps.supportsThinking = true;
    caps.thinkingBudget = 32000;
  } else if (id.includes('deepseek')) {
    caps.contextWindow = 128000;
    caps.maxOutputTokens = 8192;
  }

  if (id.includes('kimi') || id.includes('moonshot')) {
    caps.contextWindow = id.includes('k2') ? 262144 : 128000;
    caps.maxOutputTokens = 8192;
    caps.supportsThinking = /thinking|reason|k2/.test(id);
    caps.thinkingBudget = caps.supportsThinking ? 16000 : 0;
  }

  return caps;
}

function _normalizeDiscoveredModel(raw, providerType) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id || raw.name || raw.model || '').trim();
  if (!id) return null;
  const inferred = _inferModelCapabilities(id, providerType);
  const contextWindow = _numberFromAny(
    raw.contextWindow,
    raw.context_window,
    raw.context_length,
    raw.max_context_length,
    raw.max_context_tokens,
    raw.input_token_limit,
    raw.max_input_tokens,
    raw.maxInputTokens,
    raw.capabilities?.contextWindow,
    raw.capabilities?.context_window,
    inferred.contextWindow
  );
  const maxOutputTokens = _numberFromAny(
    raw.maxOutputTokens,
    raw.max_output_tokens,
    raw.output_token_limit,
    raw.max_completion_tokens,
    raw.capabilities?.maxOutputTokens,
    raw.capabilities?.max_output_tokens,
    inferred.maxOutputTokens
  );
  const supportsThinking = _boolFromAny(
    raw.supportsThinking,
    raw.supports_thinking,
    raw.reasoning,
    raw.capabilities?.supportsThinking,
    raw.capabilities?.reasoning,
    inferred.supportsThinking
  );
  const thinkingBudget = _numberFromAny(
    raw.thinkingBudget,
    raw.thinking_budget,
    raw.reasoning_budget,
    raw.capabilities?.thinkingBudget,
    raw.capabilities?.thinking_budget,
    inferred.thinkingBudget
  ) || 0;

  return {
    id,
    name: String(raw.display_name || raw.displayName || raw.name || id),
    contextWindow,
    maxOutputTokens,
    supportsThinking: !!supportsThinking,
    thinkingBudget: supportsThinking ? thinkingBudget : 0,
    discoveredAt: new Date().toISOString(),
  };
}

function _modelListUrlCandidates(baseUrl, providerType) {
  const trimmed = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!trimmed) return [];
  const withoutChat = trimmed.replace(/\/chat\/completions$/i, '');
  const withoutMessages = withoutChat.replace(/\/messages$/i, '');
  const candidates = [];
  const add = (url) => {
    if (url && !candidates.includes(url)) candidates.push(url);
  };

  if (/\/v1$/i.test(withoutMessages)) {
    add(`${withoutMessages}/models`);
  } else if (/\/models$/i.test(withoutMessages)) {
    add(withoutMessages);
  } else {
    add(`${withoutMessages}/v1/models`);
    add(`${withoutMessages}/models`);
  }

  if (providerType === 'anthropic' && /\/anthropic$/i.test(withoutMessages)) {
    add(`${withoutMessages}/v1/models`);
  }

  return candidates;
}

function _discoveryHeaders(provider) {
  if (provider.type === 'anthropic') {
    return {
      'x-api-key': provider.apiKey || '',
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    };
  }
  return {
    Authorization: `Bearer ${provider.apiKey || ''}`,
    'Content-Type': 'application/json',
  };
}

function _extractModelList(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.models)) return data.models;
  if (Array.isArray(data?.items)) return data.items;
  return [];
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
  const baseUrl = (p.baseUrl || (p.type === 'anthropic' ? 'https://api.anthropic.com' : '')).replace(/\/$/, '');
  if (!baseUrl) {
    return { ok: false, error: 'Provider baseUrl is required for model discovery.' };
  }
  if (!p.apiKey) {
    return { ok: false, error: 'API key is required for model discovery.' };
  }

  const urls = _modelListUrlCandidates(baseUrl, p.type);
  const errors = [];
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: _discoveryHeaders(p),
      });
      if (!res.ok) {
        const text = await res.text();
        errors.push(`${url} -> ${res.status}: ${text.slice(0, 300)}`);
        continue;
      }
      const data = await res.json();
      const models = _extractModelList(data)
        .map((m) => _normalizeDiscoveredModel(m, p.type))
        .filter(Boolean);
      if (!models.length) {
        errors.push(`${url} -> no models in response`);
        continue;
      }
      return { ok: true, models, endpoint: url };
    } catch (err) {
      errors.push(`${url} -> ${err.message || String(err)}`);
    }
  }

  return {
    ok: false,
    error: `Model discovery failed. Tried ${urls.length} endpoint(s): ${errors.join(' | ')}`,
  };
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
  getProviderStateTokenSync,
  use,
  add,
  remove,
  addModel,
  removeModel,
  discoverModels,
  getActiveEnv,
  inferProviderType,
};
