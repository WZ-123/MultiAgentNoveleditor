'use strict';

/**
 * Compatibility facade for the unified modelConfig domain.
 * New code should use modelConfig + modelResolver directly. Legacy IPC and
 * callers remain functional while the v2 Provider/Alias APIs are phased out.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const modelConfig = require('../modelConfig');

const CURRENT_ENV_FILE = path.join(os.homedir(), '.ccs', 'current-env.json');
let cachedEnv = null;
let cachedEnvMtimeMs = 0;

function inferProviderType(provider) {
  if (provider?.adapterId === 'anthropic-messages') return 'anthropic';
  if (provider?.adapterId === 'openai-chat-completions') return 'openai-compat';
  if (provider?.type === 'anthropic' || provider?.type === 'openai-compat') return provider.type;
  const baseUrl = String(provider?.baseUrl || '').toLowerCase();
  return baseUrl.includes('anthropic') ? 'anthropic' : 'openai-compat';
}

function adapterFromType(type, provider) {
  if (type === 'anthropic') return 'anthropic-messages';
  if (type === 'openai-compat') return 'openai-chat-completions';
  return inferProviderType(provider) === 'anthropic' ? 'anthropic-messages' : 'openai-chat-completions';
}

function detect() {
  return { available: true, version: 'model-config-v3' };
}

async function list() {
  const snapshot = await modelConfig.publicSnapshot();
  let activeProviderId = null;
  try {
    activeProviderId = (await modelConfig.resolvePreview({ driverId: 'direct-api' }))[0]?.providerId || null;
  } catch {}
  return snapshot.providers.map((provider) => ({
    ...provider,
    type: modelConfig.legacyTypeFromAdapter(provider.adapterId),
    active: provider.id === activeProviderId,
    hasApiKey: !!provider.auth?.hasApiKey,
  }));
}

async function current() {
  try {
    const preview = (await modelConfig.resolvePreview({ driverId: 'direct-api' }))[0];
    if (!preview?.providerId) return null;
    return (await list()).find((provider) => provider.id === preview.providerId) || null;
  } catch {
    return null;
  }
}

async function getProvider(id) {
  const provider = await modelConfig.getProviderInternal(id, { includeSecret: true });
  if (!provider) return null;
  return { ...provider, type: inferProviderType(provider) };
}

async function getProviderPublic(id) {
  const snapshot = await modelConfig.publicSnapshot();
  const provider = snapshot.providers.find((item) => item.id === String(id || '').trim().toLowerCase().replace(/\s+/g, '-')) || null;
  return provider ? { ...provider, type: modelConfig.legacyTypeFromAdapter(provider.adapterId) } : null;
}

async function getActiveProvider() {
  const cur = await current();
  return cur ? getProvider(cur.id) : null;
}

async function use(name) {
  const provider = await modelConfig.getProviderInternal(name);
  if (!provider) throw new Error(`Provider '${name}' not found`);
  if (!provider.models?.length) throw new Error(`Provider '${provider.name}' 没有可用模型`);
  const state = await modelConfig.load();
  const profileId = state.routing.defaultProfileId;
  const profile = state.profiles.find((item) => item.id === profileId);
  if (!profile) throw new Error('默认模型档案不存在');
  const next = JSON.parse(JSON.stringify(profile));
  const group = next.targetsByDriver['direct-api'];
  group.primary.providerId = provider.id;
  group.primary.modelId = provider.models[0].id;
  await modelConfig.saveProfile(next);
  return { ok: true, profileId };
}

async function add({ id, name, type, adapterId, baseUrl, apiKey, models } = {}) {
  await modelConfig.saveProvider({
    id,
    name,
    adapterId: adapterId || adapterFromType(type, { baseUrl }),
    baseUrl,
    apiKey,
    models: models || [],
  });
  return { ok: true };
}

async function update(payload = {}) {
  const snapshot = await modelConfig.saveProvider({
    ...payload,
    adapterId: payload.adapterId || adapterFromType(payload.type, payload),
  }, payload.expectedRevision);
  return { ok: true, revision: snapshot.revision };
}

async function remove(name, replacementProviderId) {
  await modelConfig.deleteProvider(name, replacementProviderId);
  return { ok: true };
}

async function addModel(providerId, model) {
  const provider = await modelConfig.getProviderInternal(providerId);
  if (!provider) throw new Error(`Provider '${providerId}' not found`);
  const models = [...(provider.models || [])];
  const idx = models.findIndex((item) => item.id === model?.id);
  const normalized = modelConfig.modelRecord(model, model?.source || 'manual');
  if (!normalized.id) throw new Error('模型 ID 不能为空');
  if (idx >= 0) models[idx] = { ...models[idx], ...normalized };
  else models.push(normalized);
  await modelConfig.saveProvider({ ...provider, models });
  return { ok: true };
}

async function removeModel(providerId, modelId, replacementModelId) {
  const provider = await modelConfig.getProviderInternal(providerId);
  if (!provider) throw new Error(`Provider '${providerId}' not found`);
  const state = await modelConfig.load();
  const refs = [];
  for (const profile of state.profiles) {
    for (const [driverId, group] of Object.entries(profile.targetsByDriver || {})) {
      for (const target of [group?.primary, ...(group?.fallbacks || [])].filter(Boolean)) {
        if (target.providerId === provider.id && target.modelId === modelId) refs.push({ profileId: profile.id, profileName: profile.name, driverId, targetId: target.id });
      }
    }
  }
  if (refs.length && !replacementModelId) {
    const err = new Error(`模型正被 ${refs.length} 个档案目标引用，请先选择替代模型`);
    err.code = 'MODEL_IN_USE';
    err.references = refs;
    throw err;
  }
  if (replacementModelId && !provider.models.some((item) => item.id === replacementModelId)) throw new Error('替代模型不存在');
  await modelConfig.transaction((draft) => {
    const targetProvider = draft.providers.find((item) => item.id === provider.id);
    targetProvider.models = targetProvider.models.filter((item) => item.id !== modelId);
    for (const profile of draft.profiles) {
      for (const group of Object.values(profile.targetsByDriver || {})) {
        for (const target of [group?.primary, ...(group?.fallbacks || [])].filter(Boolean)) {
          if (target.providerId === provider.id && target.modelId === modelId) target.modelId = replacementModelId;
        }
      }
    }
    return draft;
  });
  return { ok: true };
}

function candidateModelUrls(provider) {
  if (provider.endpoints?.models) return [provider.endpoints.models];
  const base = String(provider.baseUrl || '').replace(/\/+$/, '');
  if (!base) return [];
  if (/\/models$/i.test(base)) return [base];
  if (/\/v1$/i.test(base)) return [`${base}/models`];
  return [`${base}/v1/models`, `${base}/models`];
}

function discoveryHeaders(provider) {
  if (provider.adapterId === 'anthropic-messages') {
    return { 'x-api-key': provider.apiKey || '', 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' };
  }
  if (provider.auth?.mode === 'x-api-key') return { [provider.auth.headerName || 'api-key']: provider.apiKey || '', 'Content-Type': 'application/json' };
  return { Authorization: `Bearer ${provider.apiKey || ''}`, 'Content-Type': 'application/json' };
}

function extractModels(data) {
  if (Array.isArray(data)) return data;
  for (const key of ['data', 'models', 'items']) if (Array.isArray(data?.[key])) return data[key];
  return [];
}

function inferCaps(id, adapterId) {
  const value = String(id || '').toLowerCase();
  const caps = { contextWindow: adapterId === 'anthropic-messages' ? 200000 : 128000, maxOutputTokens: adapterId === 'anthropic-messages' ? 8192 : 4096, supportsThinking: false, thinkingBudget: 0 };
  if (/claude|deepseek.*reason|deepseek-v4|gpt-5|\bo[134]/.test(value)) {
    caps.supportsThinking = !/flash|haiku|nano/.test(value);
    caps.thinkingBudget = caps.supportsThinking ? 32000 : 0;
  }
  if (/deepseek-v4|dsv4/.test(value)) caps.contextWindow = 1024000;
  if (/kimi|moonshot/.test(value)) caps.contextWindow = value.includes('k2') ? 262144 : 128000;
  return caps;
}

function normalizeDiscovered(raw, provider) {
  const id = String(raw?.id || raw?.name || raw?.model || '').trim();
  if (!id) return null;
  const inferred = inferCaps(id, provider.adapterId);
  return modelConfig.modelRecord({
    id,
    name: raw.display_name || raw.displayName || raw.name || id,
    contextWindow: raw.contextWindow || raw.context_window || raw.context_length || raw.max_context_length || raw.input_token_limit || inferred.contextWindow,
    maxOutputTokens: raw.maxOutputTokens || raw.max_output_tokens || raw.output_token_limit || raw.max_completion_tokens || inferred.maxOutputTokens,
    supportsThinking: raw.supportsThinking ?? raw.supports_thinking ?? raw.reasoning ?? inferred.supportsThinking,
    thinkingBudget: raw.thinkingBudget || raw.thinking_budget || raw.reasoning_budget || inferred.thinkingBudget,
    supportsTools: raw.capabilities?.tools !== false,
    supportsStreaming: raw.capabilities?.streaming !== false,
    discoveredAt: new Date().toISOString(),
    source: 'discovered',
  }, 'discovered');
}

async function discoverModels(providerId, { save = false, timeoutMs = 12000 } = {}) {
  const provider = await getProvider(providerId);
  if (!provider) throw new Error(`Provider '${providerId}' not found`);
  if (!provider.apiKey) return { ok: false, error: 'API Key 未配置' };
  const urls = candidateModelUrls(provider);
  const errors = [];
  for (const url of urls) {
    try {
      const signal = typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined;
      const res = await fetch(url, { method: 'GET', headers: discoveryHeaders(provider), signal });
      if (!res.ok) {
        errors.push(`${url} → HTTP ${res.status}`);
        continue;
      }
      const data = await res.json();
      const models = extractModels(data).map((raw) => normalizeDiscovered(raw, provider)).filter(Boolean);
      if (!models.length) {
        errors.push(`${url} → 响应中没有模型列表`);
        continue;
      }
      if (save) await modelConfig.saveProvider({ ...provider, models });
      const compatibleModels = models.map((model) => ({
        ...model,
        contextWindow: model.capabilities.contextWindow,
        maxOutputTokens: model.capabilities.maxOutputTokens,
        supportsThinking: model.capabilities.supportsThinking,
        thinkingBudget: model.capabilities.thinkingBudget,
      }));
      return { ok: true, models: compatibleModels, endpoint: url, saved: !!save };
    } catch (err) {
      errors.push(`${url} → ${err.name === 'TimeoutError' ? '请求超时' : (err.message || String(err))}`);
    }
  }
  return { ok: false, error: `模型发现失败：${errors.join('；')}` };
}

async function testConnection(providerId) {
  const result = await discoverModels(providerId, { save: false, timeoutMs: 10000 });
  return result.ok
    ? { ok: true, message: `连接成功，发现 ${result.models.length} 个模型`, endpoint: result.endpoint }
    : result;
}

function _readCurrentEnvSync() {
  try {
    const stat = fs.statSync(CURRENT_ENV_FILE);
    if (cachedEnv && stat.mtimeMs === cachedEnvMtimeMs) return cachedEnv;
    cachedEnv = JSON.parse(fs.readFileSync(CURRENT_ENV_FILE, 'utf8'));
    cachedEnvMtimeMs = stat.mtimeMs;
    return cachedEnv;
  } catch {
    cachedEnv = null;
    cachedEnvMtimeMs = 0;
    return null;
  }
}

module.exports = {
  detect,
  list,
  current,
  getProvider,
  getProviderPublic,
  getActiveProvider,
  getProviderStateTokenSync: modelConfig.stateTokenSync,
  use,
  add,
  update,
  remove,
  addModel,
  removeModel,
  discoverModels,
  testConnection,
  getActiveEnv: _readCurrentEnvSync,
  inferProviderType,
  __defaultGetActiveProvider: getActiveProvider,
};
