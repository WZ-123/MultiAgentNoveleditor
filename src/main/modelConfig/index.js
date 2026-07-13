'use strict';

/**
 * Unified model configuration domain.
 *
 * model-config.json contains only non-secret provider metadata, semantic model
 * profiles and assignments. API keys live in store/secrets.js and are resolved
 * only inside the main process.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const lockfile = require('proper-lockfile');
const { paths: appPaths } = require('../store/paths');
const { readJson, writeJson } = require('../store/jsonStore');
const secrets = require('../store/secrets');
const { BUILTIN_SUBAGENTS, LEGACY_AGENT_TO_SUBAGENT } = require('../seeds/builtinSubagents');

const SCHEMA_VERSION = 3;
const DIRECT_DRIVER = 'direct-api';
const LEGACY_PROFILE_IDS = {
  opus: 'profile-deep-reasoning',
  sonnet: 'profile-longform-writing',
  haiku: 'profile-fast-utility',
};
const SYSTEM_TASKS = [
  'chat',
  'import-analysis',
  'character-enrichment',
  'chatbox-extraction',
  'config-helper',
];

let cache = null;
let cacheMtimeMs = -1;
let inProcessQueue = Promise.resolve();

function filePath() {
  return appPaths().modelConfig || path.join(appPaths().root, 'model-config.json');
}

function normalizeId(value, fallback = '') {
  const id = String(value || '').trim().toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return id || fallback;
}

function generatedId(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function adapterFromLegacy(provider) {
  if (provider?.adapterId) return provider.adapterId;
  if (provider?.type === 'anthropic') return 'anthropic-messages';
  if (provider?.type === 'openai-compat') return 'openai-chat-completions';
  const hint = `${provider?.id || ''} ${provider?.name || ''} ${provider?.baseUrl || ''}`.toLowerCase();
  return hint.includes('anthropic') ? 'anthropic-messages' : 'openai-chat-completions';
}

function legacyTypeFromAdapter(adapterId) {
  return adapterId === 'anthropic-messages' ? 'anthropic' : 'openai-compat';
}

function builtinAnthropic() {
  return {
    id: 'anthropic',
    name: 'Anthropic',
    adapterId: 'anthropic-messages',
    baseUrl: 'https://api.anthropic.com',
    endpoints: {},
    auth: { mode: 'x-api-key', secretRef: 'provider:anthropic:api-key', headerName: 'x-api-key' },
    isBuiltin: true,
    models: [
      modelRecord({ id: 'claude-opus-4-7', name: 'Claude Opus 4.7', contextWindow: 200000, maxOutputTokens: 8192, supportsThinking: true, thinkingBudget: 32000 }, 'builtin'),
      modelRecord({ id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', contextWindow: 200000, maxOutputTokens: 8192, supportsThinking: true, thinkingBudget: 32000 }, 'builtin'),
      modelRecord({ id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5', contextWindow: 200000, maxOutputTokens: 4096, supportsThinking: false }, 'builtin'),
    ],
  };
}

function modelRecord(model, source = 'manual') {
  const capabilities = model?.capabilities || {};
  return {
    id: String(model?.id || '').trim(),
    name: String(model?.name || model?.id || '').trim(),
    capabilities: {
      contextWindow: positiveInt(capabilities.contextWindow ?? model?.contextWindow, 128000),
      maxOutputTokens: positiveInt(capabilities.maxOutputTokens ?? model?.maxOutputTokens, 4096),
      supportsThinking: !!(capabilities.supportsThinking ?? model?.supportsThinking),
      thinkingBudget: positiveInt(capabilities.thinkingBudget ?? model?.thinkingBudget, 0, true),
      supportsTools: capabilities.supportsTools !== false,
      supportsStreaming: capabilities.supportsStreaming !== false,
      supportsStructuredOutput: capabilities.supportsStructuredOutput !== false,
    },
    source: model?.source || source,
    discoveredAt: model?.discoveredAt || null,
    updatedAt: new Date().toISOString(),
  };
}

function positiveInt(value, fallback, allowZero = false) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.trunc(n);
  if (allowZero && i === 0) return 0;
  return i > 0 ? i : fallback;
}

function defaultParams(tier) {
  if (tier === 'opus') return { maxOutputTokens: 8192, temperature: 0.7, thinking: true, thinkingBudget: 32000, effortLevel: 'max' };
  if (tier === 'haiku') return { maxOutputTokens: 4096, temperature: 0.9, thinking: false, thinkingBudget: 0, effortLevel: 'low' };
  return { maxOutputTokens: 8192, temperature: 0.7, thinking: false, thinkingBudget: 0, effortLevel: 'high' };
}

function createProfileFromAlias(tier, alias, providerId = 'anthropic') {
  const profileNames = {
    opus: '深度推理',
    sonnet: '长篇正文',
    haiku: '快速任务',
  };
  const descriptions = {
    opus: '复杂推理、主聊天与一致性审查',
    sonnet: '长篇正文、改写与均衡型任务',
    haiku: '批量整理、轻量审查与低延迟任务',
  };
  const params = { ...defaultParams(tier) };
  for (const key of ['maxOutputTokens', 'temperature', 'thinking', 'thinkingBudget', 'effortLevel']) {
    if (alias?.[key] != null) params[key] = alias[key];
  }
  if (alias?.contextWindow != null) params.contextLimit = positiveInt(alias.contextWindow, 128000);
  const target = {
    id: `target-${tier}-direct-primary`,
    providerId: alias?.providerId || providerId,
    modelId: alias?.modelId || '',
    params,
  };
  const externalTarget = {
    id: `target-${tier}-claude-primary`,
    providerId: target.providerId,
    modelId: target.modelId,
    params: { effortLevel: params.effortLevel },
  };
  return {
    id: LEGACY_PROFILE_IDS[tier],
    name: profileNames[tier],
    description: descriptions[tier],
    workloadTags: tier === 'opus' ? ['reasoning', 'review', 'chat'] : tier === 'sonnet' ? ['longform-writing', 'editing'] : ['fast-utility', 'structured-extraction'],
    priority: tier === 'opus' ? 'quality' : tier === 'haiku' ? 'cost' : 'balanced',
    targetsByDriver: {
      [DIRECT_DRIVER]: { primary: target, fallbacks: [] },
      'claude-code-vscode': { primary: externalTarget, fallbacks: [] },
      'claude-code-cli': { primary: { ...externalTarget, id: `target-${tier}-claude-cli-primary` }, fallbacks: [] },
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function defaultRouting() {
  const subagentAssignments = {};
  for (const subagent of BUILTIN_SUBAGENTS) {
    subagentAssignments[subagent.id] = LEGACY_PROFILE_IDS[subagent.tier] || LEGACY_PROFILE_IDS.sonnet;
  }
  return {
    defaultProfileId: LEGACY_PROFILE_IDS.sonnet,
    systemAssignments: {
      chat: LEGACY_PROFILE_IDS.opus,
      'import-analysis': LEGACY_PROFILE_IDS.sonnet,
      'character-enrichment': LEGACY_PROFILE_IDS.haiku,
      'chatbox-extraction': LEGACY_PROFILE_IDS.sonnet,
      'config-helper': LEGACY_PROFILE_IDS.haiku,
    },
    subagentAssignments,
    legacyTierProfileMap: { ...LEGACY_PROFILE_IDS },
  };
}

function defaultState() {
  const provider = builtinAnthropic();
  const aliases = {
    opus: { providerId: provider.id, modelId: 'claude-opus-4-7' },
    sonnet: { providerId: provider.id, modelId: 'claude-sonnet-4-6' },
    haiku: { providerId: provider.id, modelId: 'claude-haiku-4-5-20251001' },
  };
  return {
    schemaVersion: SCHEMA_VERSION,
    revision: 1,
    providers: [provider],
    profiles: Object.keys(LEGACY_PROFILE_IDS).map((tier) => createProfileFromAlias(tier, aliases[tier], provider.id)),
    routing: defaultRouting(),
    migration: { source: 'fresh', migratedAt: new Date().toISOString(), warnings: [] },
  };
}

async function migrateLegacy() {
  const root = appPaths().root;
  const legacyProviders = await readJson(path.join(root, 'providers.json'), null);
  const legacyAliases = await readJson(path.join(root, 'modelAliases.json'), null);
  if (!legacyProviders && !legacyAliases) return defaultState();

  const warnings = [];
  const providers = [];
  for (const raw of legacyProviders?.providers || []) {
    const id = normalizeId(raw.id || raw.name, `provider-${providers.length + 1}`);
    const secretRef = `provider:${id}:api-key`;
    if (raw.apiKey) {
      await secrets.setSecret(secretRef, raw.apiKey);
    }
    providers.push({
      id,
      name: String(raw.name || id),
      adapterId: adapterFromLegacy(raw),
      baseUrl: String(raw.baseUrl || (raw.type === 'anthropic' ? 'https://api.anthropic.com' : '')).replace(/\/+$/, ''),
      endpoints: {},
      auth: {
        mode: adapterFromLegacy(raw) === 'anthropic-messages' ? 'x-api-key' : 'bearer',
        secretRef,
        headerName: adapterFromLegacy(raw) === 'anthropic-messages' ? 'x-api-key' : 'Authorization',
      },
      isBuiltin: !!raw.isBuiltin,
      models: (raw.models || []).filter((m) => m?.id).map((m) => modelRecord(m, 'legacy')),
    });
  }
  if (!providers.length) providers.push(builtinAnthropic());
  if (!providers.some((p) => p.id === 'anthropic')) providers.unshift(builtinAnthropic());

  const aliasesById = new Map((legacyAliases?.aliases || []).map((alias) => [alias.id, alias]));
  const activeProviderId = normalizeId(legacyProviders?.activeProviderId || 'anthropic', 'anthropic');
  const fallbackProvider = providers.find((p) => p.id === activeProviderId) || providers[0];
  const profiles = Object.keys(LEGACY_PROFILE_IDS).map((tier) => {
    const alias = aliasesById.get(tier) || {};
    const provider = providers.find((p) => p.id === normalizeId(alias.providerId || '')) || fallbackProvider;
    const modelId = alias.modelId || provider?.models?.[0]?.id || '';
    if (!modelId) warnings.push(`档案 ${tier} 没有可用模型，请在模型中心补充。`);
    return createProfileFromAlias(tier, { ...alias, providerId: provider?.id, modelId }, provider?.id);
  });
  // Legacy Alias values were user-editable and may be higher than the old
  // provider metadata. Preserve the effective configuration during migration
  // by promoting the legacy model capability instead of silently clamping it.
  for (const profile of profiles) {
    const target = profile.targetsByDriver?.[DIRECT_DRIVER]?.primary;
    const provider = providers.find((item) => item.id === target?.providerId);
    const model = provider?.models?.find((item) => item.id === target?.modelId);
    if (!model) continue;
    model.capabilities.contextWindow = Math.max(
      positiveInt(model.capabilities.contextWindow, 128000),
      positiveInt(target.params?.contextLimit, 0, true),
    );
    model.capabilities.maxOutputTokens = Math.max(
      positiveInt(model.capabilities.maxOutputTokens, 4096),
      positiveInt(target.params?.maxOutputTokens, 0, true),
    );
    if (target.params?.thinking) {
      model.capabilities.supportsThinking = true;
      model.capabilities.thinkingBudget = Math.max(
        positiveInt(model.capabilities.thinkingBudget, 0, true),
        positiveInt(target.params?.thinkingBudget, 0, true),
      );
    }
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    revision: 1,
    providers,
    profiles,
    routing: defaultRouting(),
    migration: { source: 'providers-v2+aliases-v2', migratedAt: new Date().toISOString(), warnings },
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function validateUrl(value, label, allowEmpty = false) {
  if (!value && allowEmpty) return;
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('protocol');
  } catch {
    throw new Error(`${label} 必须是有效的 HTTP(S) URL`);
  }
}

function validateTarget(state, profile, driverId, target, label) {
  if (!target || typeof target !== 'object') throw new Error(`${label} 缺少目标配置`);
  if (!target.id) throw new Error(`${label} 缺少 target.id`);
  if (!target.modelId) throw new Error(`${label} 缺少模型`);
  if (driverId === DIRECT_DRIVER) {
    const provider = state.providers.find((item) => item.id === target.providerId);
    if (!provider) throw new Error(`${label} 引用了不存在的 Provider：${target.providerId || '(空)'}`);
    const model = provider.models.find((item) => item.id === target.modelId);
    if (!model) throw new Error(`${label} 引用了 Provider 中不存在的模型：${target.modelId}`);
    const params = target.params || {};
    const caps = model.capabilities || {};
    if (params.contextLimit != null && positiveInt(params.contextLimit, 0, true) > positiveInt(caps.contextWindow, 0, true)) {
      throw new Error(`${label} 的上下文上限超过模型能力`);
    }
    if (params.maxOutputTokens != null && positiveInt(params.maxOutputTokens, 0, true) > positiveInt(caps.maxOutputTokens, 0, true)) {
      throw new Error(`${label} 的最大输出超过模型能力`);
    }
    if (params.temperature != null && (!Number.isFinite(Number(params.temperature)) || Number(params.temperature) < 0 || Number(params.temperature) > 2)) {
      throw new Error(`${label} 的 temperature 必须在 0-2 之间`);
    }
    if (params.thinking && !caps.supportsThinking) throw new Error(`${label} 的模型不支持思考模式`);
  } else if (target.providerId) {
    const provider = state.providers.find((item) => item.id === target.providerId);
    if (!provider) throw new Error(`${label} 引用了不存在的 Provider：${target.providerId}`);
    if ((driverId === 'claude-code-vscode' || driverId === 'claude-code-cli') && provider.adapterId !== 'anthropic-messages') {
      throw new Error(`${label} 的 Claude Code 目标只能使用 Anthropic Messages Provider`);
    }
  }
}

function validateState(state) {
  if (!state || typeof state !== 'object') throw new Error('模型配置必须是对象');
  const providerIds = new Set();
  for (const provider of state.providers || []) {
    if (!provider.id || providerIds.has(provider.id)) throw new Error(`Provider ID 无效或重复：${provider.id || '(空)'}`);
    providerIds.add(provider.id);
    if (!['anthropic-messages', 'openai-chat-completions'].includes(provider.adapterId)) throw new Error(`Provider ${provider.name} 的 Adapter 不受支持`);
    validateUrl(provider.baseUrl, `Provider ${provider.name} 的 Base URL`);
    const modelIds = new Set();
    for (const model of provider.models || []) {
      if (!model.id || modelIds.has(model.id)) throw new Error(`Provider ${provider.name} 的模型 ID 无效或重复`);
      modelIds.add(model.id);
    }
  }
  const profileIds = new Set();
  for (const profile of state.profiles || []) {
    if (!profile.id || profileIds.has(profile.id)) throw new Error(`模型档案 ID 无效或重复：${profile.id || '(空)'}`);
    profileIds.add(profile.id);
    for (const [driverId, group] of Object.entries(profile.targetsByDriver || {})) {
      validateTarget(state, profile, driverId, group?.primary, `档案「${profile.name}」/${driverId}/主目标`);
      const targetIds = new Set([group.primary.id]);
      for (const [idx, target] of (group.fallbacks || []).entries()) {
        validateTarget(state, profile, driverId, target, `档案「${profile.name}」/${driverId}/备用 ${idx + 1}`);
        if (targetIds.has(target.id)) throw new Error(`档案「${profile.name}」存在重复目标 ID`);
        targetIds.add(target.id);
      }
    }
  }
  const routing = state.routing || {};
  if (!profileIds.has(routing.defaultProfileId)) throw new Error('全局默认模型档案不存在');
  for (const [task, profileId] of Object.entries(routing.systemAssignments || {})) {
    if (!profileIds.has(profileId)) throw new Error(`系统任务 ${task} 引用了不存在的模型档案`);
  }
  for (const [subagentId, profileId] of Object.entries(routing.subagentAssignments || {})) {
    if (!profileIds.has(profileId)) throw new Error(`Subagent ${subagentId} 引用了不存在的模型档案`);
  }
  state.schemaVersion = SCHEMA_VERSION;
  return state;
}

async function statMtime() {
  try { return (await fsp.stat(filePath())).mtimeMs; } catch { return -1; }
}

async function load(options = {}) {
  const mtime = await statMtime();
  if (!options.force && cache && cacheMtimeMs === mtime) return cache;
  let state = await readJson(filePath(), null);
  if (!state || state.schemaVersion !== SCHEMA_VERSION) {
    state = await migrateLegacy();
    validateState(state);
    await writeJson(filePath(), state, { mode: 0o600 });
    try { await fsp.chmod(filePath(), 0o600); } catch {}
  }
  validateState(state);
  cache = state;
  cacheMtimeMs = await statMtime();
  return cache;
}

async function withExclusiveLock(fn) {
  const run = async () => {
    await fsp.mkdir(appPaths().root, { recursive: true });
    const release = await lockfile.lock(appPaths().root, {
      realpath: false,
      lockfilePath: `${filePath()}.lock`,
      retries: { retries: 8, factor: 1.5, minTimeout: 20, maxTimeout: 250 },
    });
    try { return await fn(); } finally { await release(); }
  };
  const promise = inProcessQueue.then(run, run);
  inProcessQueue = promise.catch(() => {});
  return promise;
}

async function transaction(mutator, expectedRevision) {
  return withExclusiveLock(async () => {
    const current = clone(await load({ force: true }));
    if (expectedRevision != null && current.revision !== expectedRevision) {
      const err = new Error('模型配置已被其他窗口修改，请刷新后重试');
      err.code = 'MODEL_CONFIG_CONFLICT';
      throw err;
    }
    const next = await mutator(current) || current;
    validateState(next);
    next.revision = positiveInt(current.revision, 0, true) + 1;
    next.updatedAt = new Date().toISOString();
    await writeJson(filePath(), next, { mode: 0o600 });
    try { await fsp.chmod(filePath(), 0o600); } catch {}
    cache = next;
    cacheMtimeMs = await statMtime();
    return clone(next);
  });
}

async function providerHasKey(provider) {
  if (!provider?.auth?.secretRef) return false;
  const ids = await secrets.listSecretIds();
  return ids.includes(provider.auth.secretRef);
}

function redactTarget(target) {
  return target ? clone(target) : target;
}

async function publicSnapshot() {
  const state = await load();
  const secretStates = new Map(await Promise.all(state.providers.map(async (provider) => [
    provider.id,
    await secrets.getSecretStatus(provider.auth?.secretRef || ''),
  ])));
  const secretStatus = await secrets.status();
  return {
    schemaVersion: state.schemaVersion,
    revision: state.revision,
    providers: state.providers.map((provider) => ({
      ...clone(provider),
      auth: {
        mode: provider.auth?.mode || 'none',
        headerName: provider.auth?.headerName || '',
        hasApiKey: !!secretStates.get(provider.id)?.readable,
        keyStatus: secretStates.get(provider.id)?.issue || 'missing',
      },
    })),
    profiles: clone(state.profiles),
    routing: clone(state.routing),
    migration: clone(state.migration || {}),
    secretStatus,
    environment: {
      kind: appPaths().root.includes('MultiAgentNovelAssistant-dev') ? 'development' : 'production',
      configRoot: appPaths().root,
    },
  };
}

async function getProviderInternal(id, { includeSecret = false } = {}) {
  const state = await load();
  const provider = state.providers.find((item) => item.id === normalizeId(id)) || null;
  if (!provider) return null;
  const result = clone(provider);
  if (includeSecret) result.apiKey = await secrets.getSecret(provider.auth?.secretRef || '');
  return result;
}

async function saveProvider(input, expectedRevision) {
  if (!input || typeof input !== 'object') throw new Error('Provider 配置不能为空');
  if (!String(input.id || input.name || '').trim()) throw new Error('Provider 名称不能为空');
  const id = normalizeId(input.id || input.name, generatedId('provider'));
  const existing = await getProviderInternal(id);
  const secretRef = existing?.auth?.secretRef || `provider:${id}:api-key`;
  if (Object.prototype.hasOwnProperty.call(input, 'apiKey')) {
    if (input.apiKey) await secrets.setSecret(secretRef, String(input.apiKey));
    else await secrets.deleteSecret(secretRef);
  }
  return transaction((state) => {
    const idx = state.providers.findIndex((item) => item.id === id);
    const current = idx >= 0 ? state.providers[idx] : null;
    const adapterId = input.adapterId || current?.adapterId || 'openai-chat-completions';
    const provider = {
      ...(current || {}),
      id,
      name: String(input.name || current?.name || id).trim(),
      adapterId,
      baseUrl: String(input.baseUrl ?? current?.baseUrl ?? '').trim().replace(/\/+$/, ''),
      endpoints: { ...(current?.endpoints || {}), ...(input.endpoints || {}) },
      auth: {
        mode: input.auth?.mode || current?.auth?.mode || (adapterId === 'anthropic-messages' ? 'x-api-key' : 'bearer'),
        headerName: input.auth?.headerName || current?.auth?.headerName || (adapterId === 'anthropic-messages' ? 'x-api-key' : 'Authorization'),
        secretRef,
      },
      models: Array.isArray(input.models) ? input.models.map((model) => modelRecord(model, model.source || 'manual')) : (current?.models || []),
      isBuiltin: !!current?.isBuiltin,
    };
    if (idx >= 0) state.providers[idx] = provider;
    else state.providers.push(provider);
    return state;
  }, expectedRevision);
}

function providerReferences(state, providerId) {
  const refs = [];
  for (const profile of state.profiles) {
    for (const [driverId, group] of Object.entries(profile.targetsByDriver || {})) {
      for (const target of [group?.primary, ...(group?.fallbacks || [])].filter(Boolean)) {
        if (target.providerId === providerId) refs.push({ profileId: profile.id, profileName: profile.name, driverId, targetId: target.id });
      }
    }
  }
  return refs;
}

async function deleteProvider(id, replacementProviderId, expectedRevision) {
  const normalized = normalizeId(id);
  const existing = await getProviderInternal(normalized);
  if (!existing) throw new Error(`Provider 不存在：${id}`);
  if (existing.isBuiltin) throw new Error('内置 Provider 不能删除，可以清空密钥或修改连接');
  let secretToDelete = existing.auth?.secretRef || '';
  const next = await transaction((state) => {
    const refs = providerReferences(state, normalized);
    if (refs.length && !replacementProviderId) {
      const err = new Error(`Provider 正被 ${refs.length} 个模型目标引用，请先选择替代 Provider`);
      err.code = 'PROVIDER_IN_USE';
      err.references = refs;
      throw err;
    }
    if (replacementProviderId) {
      const replacement = state.providers.find((item) => item.id === normalizeId(replacementProviderId));
      if (!replacement) throw new Error('替代 Provider 不存在');
      for (const profile of state.profiles) {
        for (const group of Object.values(profile.targetsByDriver || {})) {
          for (const target of [group?.primary, ...(group?.fallbacks || [])].filter(Boolean)) {
            if (target.providerId === normalized) {
              target.providerId = replacement.id;
              if (!replacement.models.some((model) => model.id === target.modelId)) {
                target.modelId = replacement.models[0]?.id || '';
              }
            }
          }
        }
      }
    }
    state.providers = state.providers.filter((item) => item.id !== normalized);
    return state;
  }, expectedRevision);
  if (secretToDelete) {
    const stillUsed = next.providers.some((provider) => provider.auth?.secretRef === secretToDelete);
    if (!stillUsed) await secrets.deleteSecret(secretToDelete);
  }
  return next;
}

async function saveProfile(profile, expectedRevision) {
  if (!profile?.id && !profile?.name) throw new Error('模型档案名称不能为空');
  const id = normalizeId(profile.id || profile.name, generatedId('profile'));
  return transaction((state) => {
    const idx = state.profiles.findIndex((item) => item.id === id);
    const current = idx >= 0 ? state.profiles[idx] : null;
    const next = {
      ...(current || {}),
      ...clone(profile),
      id,
      name: String(profile.name || current?.name || id).trim(),
      targetsByDriver: clone(profile.targetsByDriver || current?.targetsByDriver || {}),
      createdAt: current?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    if (idx >= 0) state.profiles[idx] = next;
    else state.profiles.push(next);
    return state;
  }, expectedRevision);
}

function profileReferences(state, profileId) {
  const refs = [];
  if (state.routing.defaultProfileId === profileId) refs.push({ kind: 'default' });
  for (const [task, id] of Object.entries(state.routing.systemAssignments || {})) if (id === profileId) refs.push({ kind: 'system', id: task });
  for (const [subagentId, id] of Object.entries(state.routing.subagentAssignments || {})) if (id === profileId) refs.push({ kind: 'subagent', id: subagentId });
  return refs;
}

async function deleteProfile(id, replacementProfileId, expectedRevision) {
  const normalized = normalizeId(id);
  return transaction((state) => {
    if (!state.profiles.some((profile) => profile.id === normalized)) throw new Error('模型档案不存在');
    const refs = profileReferences(state, normalized);
    if (refs.length && !replacementProfileId) {
      const err = new Error(`模型档案正被 ${refs.length} 处引用，请先选择替代档案`);
      err.code = 'PROFILE_IN_USE';
      err.references = refs;
      throw err;
    }
    if (replacementProfileId) {
      const replacement = normalizeId(replacementProfileId);
      if (!state.profiles.some((profile) => profile.id === replacement)) throw new Error('替代模型档案不存在');
      if (state.routing.defaultProfileId === normalized) state.routing.defaultProfileId = replacement;
      for (const key of Object.keys(state.routing.systemAssignments || {})) if (state.routing.systemAssignments[key] === normalized) state.routing.systemAssignments[key] = replacement;
      for (const key of Object.keys(state.routing.subagentAssignments || {})) if (state.routing.subagentAssignments[key] === normalized) state.routing.subagentAssignments[key] = replacement;
    }
    state.profiles = state.profiles.filter((profile) => profile.id !== normalized);
    return state;
  }, expectedRevision);
}

async function saveRouting(routing, expectedRevision) {
  return transaction((state) => {
    const systemAssignments = { ...state.routing.systemAssignments };
    for (const [key, value] of Object.entries(routing?.systemAssignments || {})) {
      if (value) systemAssignments[key] = value;
      else delete systemAssignments[key];
    }
    const subagentAssignments = { ...state.routing.subagentAssignments };
    for (const [key, value] of Object.entries(routing?.subagentAssignments || {})) {
      if (value) subagentAssignments[key] = value;
      else delete subagentAssignments[key];
    }
    state.routing = {
      ...state.routing,
      ...clone(routing || {}),
      systemAssignments,
      subagentAssignments,
      legacyTierProfileMap: { ...state.routing.legacyTierProfileMap, ...(routing?.legacyTierProfileMap || {}) },
    };
    return state;
  }, expectedRevision);
}

function profileSelection(state, context = {}) {
  const candidates = [
    ['explicit', context.modelProfileId],
    ['dag-node', context.dagModelProfileId],
    ['subagent', context.subagentId ? state.routing.subagentAssignments?.[context.subagentId] : null],
    ['system-task', context.systemTask ? state.routing.systemAssignments?.[context.systemTask] : null],
    ['legacy-tier', context.legacyTier ? state.routing.legacyTierProfileMap?.[context.legacyTier] : null],
    ['default', state.routing.defaultProfileId],
  ];
  for (const [source, profileId] of candidates) {
    if (!profileId) continue;
    const profile = state.profiles.find((item) => item.id === profileId);
    if (profile) return { profile, source };
  }
  throw new Error('没有可用的模型档案，请打开模型中心完成配置');
}

async function resolveTargets(context = {}) {
  const state = await load();
  const driverId = context.driverId || DIRECT_DRIVER;
  const { profile, source } = profileSelection(state, context);
  const group = profile.targetsByDriver?.[driverId];
  if (!group?.primary) throw new Error(`模型档案「${profile.name}」没有配置 Driver「${driverId}」的目标`);
  const targets = [group.primary, ...(group.fallbacks || [])];
  const resolved = [];
  for (let idx = 0; idx < targets.length; idx += 1) {
    const target = clone(targets[idx]);
    if (driverId === DIRECT_DRIVER) {
      const provider = state.providers.find((item) => item.id === target.providerId);
      if (!provider) throw new Error(`模型目标引用的 Provider 不存在：${target.providerId}`);
      const model = provider.models.find((item) => item.id === target.modelId);
      if (!model) throw new Error(`模型目标引用的模型不存在：${target.modelId}`);
      const key = await secrets.getSecretStatus(provider.auth?.secretRef || '');
      if (!key.readable) {
        if (key.present) {
          throw new Error(`Provider「${provider.name}」的 API Key 已保存但无法从系统安全存储读取，请在 Provider 中重新输入并保存该密钥`);
        }
        throw new Error(`Provider「${provider.name}」尚未配置 API Key`);
      }
      const apiKey = key.value;
      resolved.push({
        profileId: profile.id,
        profileName: profile.name,
        selectionSource: source,
        driverId,
        targetIndex: idx,
        isFallback: idx > 0,
        target,
        provider: { ...clone(provider), apiKey },
        model: clone(model),
      });
    } else {
      const provider = target.providerId ? state.providers.find((item) => item.id === target.providerId) : null;
      resolved.push({
        profileId: profile.id,
        profileName: profile.name,
        selectionSource: source,
        driverId,
        targetIndex: idx,
        isFallback: idx > 0,
        target,
        provider: provider ? { ...clone(provider), apiKey: await secrets.getSecret(provider.auth?.secretRef || '') } : null,
        model: provider?.models?.find((item) => item.id === target.modelId) || { id: target.modelId, name: target.modelId, capabilities: {} },
      });
    }
  }
  return resolved;
}

async function resolvePreview(context = {}) {
  const targets = await resolveTargets(context);
  return targets.map((item) => ({
    profileId: item.profileId,
    profileName: item.profileName,
    selectionSource: item.selectionSource,
    driverId: item.driverId,
    targetIndex: item.targetIndex,
    isFallback: item.isFallback,
    providerId: item.provider?.id || null,
    providerName: item.provider?.name || null,
    modelId: item.model?.id || item.target.modelId,
    params: clone(item.target.params || {}),
  }));
}

function tierFromResolved(resolved) {
  const provider = resolved.provider;
  const params = resolved.target.params || {};
  const caps = resolved.model?.capabilities || {};
  const adapterId = provider?.adapterId || 'anthropic-messages';
  return {
    tierName: resolved.profileId,
    profileId: resolved.profileId,
    profileName: resolved.profileName,
    selectionSource: resolved.selectionSource,
    targetIndex: resolved.targetIndex,
    driverId: resolved.driverId,
    type: legacyTypeFromAdapter(adapterId),
    adapterId,
    baseUrl: provider?.baseUrl || '',
    endpoint: provider?.endpoints?.messages || '',
    model: resolved.target.modelId,
    apiKey: provider?.apiKey || '',
    contextWindow: positiveInt(params.contextLimit, positiveInt(caps.contextWindow, 128000)),
    extra: {
      maxTokens: positiveInt(params.maxOutputTokens, positiveInt(caps.maxOutputTokens, 4096)),
      ...(params.temperature != null ? { temperature: Number(params.temperature) } : {}),
      ...(params.reasoningEffort ? { reasoningEffort: params.reasoningEffort } : {}),
      ...(params.effortLevel ? { effortLevel: params.effortLevel } : {}),
    },
    thinking: params.thinking ? { type: 'enabled', budget_tokens: positiveInt(params.thinkingBudget, 16000) } : undefined,
    provenance: {
      profileId: resolved.profileId,
      profileName: resolved.profileName,
      selectionSource: resolved.selectionSource,
      driverId: resolved.driverId,
      providerId: provider?.id || null,
      providerName: provider?.name || null,
      modelId: resolved.target.modelId,
      targetIndex: resolved.targetIndex,
      isFallback: resolved.targetIndex > 0,
    },
  };
}

function shouldFallback(err) {
  if (!err) return false;
  if (err.name === 'AbortError' || err.name === 'TimeoutError' && err?.userInitiated) return false;
  const status = Number(err.status || err.statusCode || err.httpStatus || err.cause?.status || 0);
  if ([401, 403, 404, 408, 409, 429].includes(status) || status >= 500) return true;
  const message = String(err.message || err).toLowerCase();
  return /timeout|timed out|econn|enotfound|network|fetch failed|socket|model.*not found|unavailable|api key|authentication|unauthorized|forbidden/.test(message);
}

function stateTokenSync() {
  try {
    const raw = fs.readFileSync(filePath(), 'utf8');
    return `model-config:${crypto.createHash('sha1').update(raw).digest('hex')}`;
  } catch (err) {
    return `model-config:${err?.code || 'missing'}:v${SCHEMA_VERSION}`;
  }
}

async function importLegacyRendererConfig(config) {
  if (!config || typeof config !== 'object') return { imported: 0 };
  let imported = 0;
  const assignmentUpdates = {};
  for (const [legacyId, row] of Object.entries(config)) {
    if (!row || row.useMock || !String(row.apiKey || '').trim() || !String(row.baseUrl || '').trim() || !String(row.model || '').trim()) continue;
    const id = normalizeId(`legacy-${row.providerId || legacyId}`);
    const existing = await getProviderInternal(id);
    const models = [...(existing?.models || [])];
    if (!models.some((model) => model.id === row.model)) {
      models.push({ id: row.model, name: row.model, contextWindow: 128000, maxOutputTokens: 4096 });
    }
    await saveProvider({
      id,
      name: existing?.name || `迁移配置 · ${row.providerId || legacyId}`,
      adapterId: 'openai-chat-completions',
      baseUrl: row.baseUrl,
      apiKey: row.apiKey,
      models,
    });
    const profileId = normalizeId(`profile-legacy-${legacyId}`);
    const currentState = await load({ force: true });
    const existingProfile = currentState.profiles.find((profile) => profile.id === profileId);
    await saveProfile({
      ...(existingProfile || {}),
      id: profileId,
      name: existingProfile?.name || `迁移档案 · ${legacyId}`,
      description: '从旧 Agent API 配置迁移',
      workloadTags: ['legacy'],
      priority: 'balanced',
      targetsByDriver: {
        ...(existingProfile?.targetsByDriver || {}),
        'direct-api': {
          primary: {
            id: `target-${profileId}-primary`,
            providerId: id,
            modelId: row.model,
            params: { contextLimit: 128000, maxOutputTokens: 4096, temperature: 0.7, thinking: false, thinkingBudget: 0 },
          },
          fallbacks: [],
        },
      },
    });
    const subagentId = LEGACY_AGENT_TO_SUBAGENT[legacyId];
    if (subagentId) assignmentUpdates[subagentId] = profileId;
    imported += 1;
  }
  if (Object.keys(assignmentUpdates).length) {
    await saveRouting({ subagentAssignments: assignmentUpdates });
  }
  return { imported };
}

module.exports = {
  SCHEMA_VERSION,
  DIRECT_DRIVER,
  LEGACY_PROFILE_IDS,
  SYSTEM_TASKS,
  load,
  publicSnapshot,
  transaction,
  validateState,
  saveProvider,
  deleteProvider,
  getProviderInternal,
  providerReferences,
  saveProfile,
  deleteProfile,
  saveRouting,
  resolveTargets,
  resolvePreview,
  tierFromResolved,
  shouldFallback,
  stateTokenSync,
  importLegacyRendererConfig,
  modelRecord,
  legacyTypeFromAdapter,
};
