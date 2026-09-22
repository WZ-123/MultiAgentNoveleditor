'use strict';

const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { paths } = require('../store/paths');
const { readJson, writeJson } = require('../store/jsonStore');
const secrets = require('../store/secrets');
const { enrichModel } = require('./modelMetadata');

const SCHEMA_VERSION = 8;
const VERIFICATION_VALUES = new Set(['unknown', 'ok', 'failed']);
let queue = Promise.resolve();

function filePath() { return paths().modelConfig; }
function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }
function normalizeId(value, prefix) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '') || `${prefix}-${crypto.randomUUID()}`;
}
function nullablePositiveInt(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error('模型容量参数必须是正整数或未知');
  return number;
}
function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : []).map((value) => String(value || '').trim()).filter(Boolean))];
}
function defaultState() {
  return { schemaVersion: SCHEMA_VERSION, revision: 0, credentials: [], connections: [], activeSelection: null, setupOperations: [] };
}
function normalizeUrl(value, label = 'API 地址') {
  const url = new URL(String(value || '').trim());
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`${label}必须使用 HTTP 或 HTTPS`);
  url.hash = '';
  return url.toString().replace(/\/+$/u, '');
}
function normalizeQueryParams(value) {
  const result = {};
  for (const [key, item] of Object.entries(value && typeof value === 'object' ? value : {})) {
    const name = String(key || '').trim();
    if (name) result[name] = String(item ?? '');
  }
  return result;
}
function normalizeCredential(value) {
  const id = normalizeId(value?.id, 'credential');
  return { id, name: String(value?.name || id).trim() || id, secretRef: String(value?.secretRef || `credential:${id}:api-key`) };
}
function normalizeCapabilities(value = {}) {
  return {
    contextWindow: nullablePositiveInt(value.contextWindow),
    maxOutputTokens: nullablePositiveInt(value.maxOutputTokens),
    inputModalities: uniqueStrings(value.inputModalities),
    supportsTools: typeof value.supportsTools === 'boolean' ? value.supportsTools : null,
    supportsStructuredOutput: typeof value.supportsStructuredOutput === 'boolean' ? value.supportsStructuredOutput : null,
    reasoningEfforts: uniqueStrings(value.reasoningEfforts),
    verbosityLevels: uniqueStrings(value.verbosityLevels),
  };
}
function normalizeVerification(value = {}) {
  const byEffort = value.byEffort || (value.responses || value.tools ? { default: { responses: value.responses || 'unknown', tools: value.tools || 'unknown', verifiedAt: value.verifiedAt || null } } : {});
  return {
    byEffort: clone(byEffort),
    responses: VERIFICATION_VALUES.has(value.responses) ? value.responses : 'unknown',
    tools: VERIFICATION_VALUES.has(value.tools) ? value.tools : 'unknown',
    verifiedEfforts: uniqueStrings(value.verifiedEfforts),
    verifiedAt: value.verifiedAt ? String(value.verifiedAt) : null,
    credentialRevision: Number.isInteger(value.credentialRevision) && value.credentialRevision > 0 ? value.credentialRevision : null,
    errorCode: value.errorCode ? String(value.errorCode) : null,
  };
}
function normalizeModel(value, source = 'manual') {
  const id = String(value?.id || '').trim();
  if (!id) throw new Error('模型 ID 不能为空');
  return {
    id,
    name: String(value?.name || id).trim() || id,
    capabilities: normalizeCapabilities(value?.capabilities || value),
    fieldSources: Object.fromEntries(Object.entries(value?.fieldSources || {}).map(([key, item]) => [String(key), String(item)])),
    availability: value?.availability === 'stale' ? 'stale' : 'available',
    verification: normalizeVerification(value?.verification),
    source: String(value?.source || source),
  };
}
function normalizeAuth(value = {}) {
  const mode = value.mode === 'header' ? 'header' : 'bearer';
  const headerName = mode === 'header' ? String(value.headerName || '').trim() : '';
  if (mode === 'header' && !/^[A-Za-z0-9-]{1,80}$/u.test(headerName)) throw new Error('自定义认证 Header 名称无效');
  return { mode, ...(headerName ? { headerName } : {}) };
}
function normalizeConnection(value) {
  const id = normalizeId(value?.id, 'connection');
  const models = (Array.isArray(value?.models) ? value.models : []).map((model) => normalizeModel(model));
  if (new Set(models.map((model) => model.id)).size !== models.length) throw new Error('同一连接内模型 ID 不能重复');
  const kind = value?.kind === 'codexSubscription' ? 'codexSubscription' : 'api';
  if (kind === 'codexSubscription') {
    return {
      id,
      kind,
      name: String(value?.name || 'Codex 订阅').trim() || 'Codex 订阅',
      credentialId: '', baseUrl: '', queryParams: {}, auth: { mode: 'managed' },
      templateId: 'codex-subscription', modelsUrl: '',
      discovery: {
        status: models.length ? 'ok' : 'never',
        discoveredAt: value?.discovery?.discoveredAt ? String(value.discovery.discoveredAt) : null,
        errorCode: value?.discovery?.errorCode ? String(value.discovery.errorCode) : null,
      },
      models,
    };
  }
  return {
    id,
    kind,
    name: String(value?.name || id).trim() || id,
    credentialId: String(value?.credentialId || '').trim(),
    baseUrl: normalizeUrl(value?.baseUrl, 'Responses Base URL'),
    queryParams: normalizeQueryParams(value?.queryParams),
    auth: normalizeAuth(value?.auth),
    templateId: String(value?.templateId || 'generic'),
    modelsUrl: value?.modelsUrl ? normalizeUrl(value.modelsUrl, 'Models URL') : '',
    discovery: {
      status: ['never', 'ok', 'manual', 'failed'].includes(value?.discovery?.status) ? value.discovery.status : 'never',
      discoveredAt: value?.discovery?.discoveredAt ? String(value.discovery.discoveredAt) : null,
      errorCode: value?.discovery?.errorCode ? String(value.discovery.errorCode) : null,
    },
    models: models.map((model) => enrichModel(model, value?.baseUrl)),
  };
}
function validateState(input) {
  const state = { ...defaultState(), ...(input || {}), schemaVersion: SCHEMA_VERSION };
  state.revision = Number.isInteger(state.revision) && state.revision >= 0 ? state.revision : 0;
  state.credentials = (Array.isArray(state.credentials) ? state.credentials : []).map(normalizeCredential);
  state.connections = (Array.isArray(state.connections) ? state.connections : []).map(normalizeConnection);
  if (new Set(state.credentials.map((item) => item.id)).size !== state.credentials.length) throw new Error('凭据 ID 不能重复');
  if (new Set(state.credentials.map((item) => item.secretRef)).size !== state.credentials.length) throw new Error('同一 secretRef 只能对应一条凭据');
  if (new Set(state.connections.map((item) => item.id)).size !== state.connections.length) throw new Error('连接 ID 不能重复');
  const credentialIds = new Set(state.credentials.map((item) => item.id));
  for (const connection of state.connections) if (connection.kind === 'api' && !credentialIds.has(connection.credentialId)) throw new Error(`连接「${connection.name}」引用的 API 凭据不存在`);
  const active = state.activeSelection;
  if (!active || typeof active !== 'object') state.activeSelection = null;
  else {
    const connection = state.connections.find((item) => item.id === active.connectionId);
    const model = connection?.models.find((item) => item.id === active.modelId && item.availability === 'available');
    state.activeSelection = connection && model ? { connectionId: connection.id, modelId: model.id, reasoningEffort: active.reasoningEffort == null || active.reasoningEffort === '' ? null : String(active.reasoningEffort) } : null;
  }
  return state;
}
function legacyCapabilities(model = {}) {
  const caps = model.capabilities || model;
  return {
    contextWindow: caps.contextWindow ?? caps.context_window ?? null,
    maxOutputTokens: caps.maxOutputTokens ?? caps.max_output_tokens ?? null,
    inputModalities: caps.inputModalities || [],
    supportsTools: typeof caps.supportsTools === 'boolean' ? caps.supportsTools : null,
    supportsStructuredOutput: typeof caps.supportsStructuredOutput === 'boolean' ? caps.supportsStructuredOutput : null,
    reasoningEfforts: caps.reasoningEfforts || [],
    verbosityLevels: caps.verbosityLevels || [],
  };
}
function migrateProviderState(raw) {
  const credentials = [];
  const bySecretRef = new Map();
  const connections = [];
  for (const provider of Array.isArray(raw?.providers) ? raw.providers : []) {
    const secretRef = String(provider?.secretRef || provider?.auth?.secretRef || `provider:${provider?.id || crypto.randomUUID()}:api-key`);
    let credential = bySecretRef.get(secretRef);
    if (!credential) {
      credential = normalizeCredential({ id: `credential-${provider?.id || crypto.randomUUID()}`, name: provider?.name || provider?.id || '迁移的 API Key', secretRef });
      bySecretRef.set(secretRef, credential);
      credentials.push(credential);
    }
    const legacyHeader = provider?.auth?.headerName || (provider?.adapterId === 'anthropic-messages' ? 'x-api-key' : '');
    const auth = legacyHeader && legacyHeader.toLowerCase() !== 'authorization' ? { mode: 'header', headerName: legacyHeader } : { mode: 'bearer' };
    const models = (Array.isArray(provider?.models) ? provider.models : []).map((model) => typeof model === 'string' ? { id: model, name: model } : model).filter((model) => model?.id).map((model) => {
      const capabilities = legacyCapabilities(model);
      return normalizeModel({ id: model.id, name: model.name, capabilities, fieldSources: Object.fromEntries(Object.keys(capabilities).map((key) => [key, 'legacy'])), verification: { responses: 'unknown', tools: 'unknown' }, source: 'legacy' }, 'legacy');
    });
    if (!provider?.baseUrl) continue;
    const hint = `${provider.id || ''} ${provider.name || ''}`.toLowerCase();
    connections.push(normalizeConnection({
      id: `connection-${provider.id || crypto.randomUUID()}`,
      name: provider.name || provider.id,
      credentialId: credential.id,
      baseUrl: provider.baseUrl,
      auth,
      templateId: hint.includes('kimi') ? 'kimi' : hint.includes('deepseek') ? 'deepseek' : provider.adapterId === 'anthropic-messages' ? 'anthropic' : 'generic',
      discovery: { status: 'never' },
      models,
    }));
  }
  return validateState({ credentials, connections, activeSelection: null, revision: 1 });
}
async function backupLegacyState(raw) {
  const dir = path.join(paths().root, 'migration-backups', 'responses-connections-v1');
  const file = path.join(dir, raw?.schemaVersion === 7 ? 'model-config-pre-v8.json' : raw?.schemaVersion === 6 ? 'model-config-pre-v7.json' : 'model-config-pre-v6.json');
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  try { await fsp.access(file); } catch { await writeJson(file, raw, { mode: 0o600 }); }
}
function legacyRecoveryPaths() {
  const dir = path.join(paths().root, 'migration-backups', 'responses-connections-v1');
  return {
    dir,
    providersBackup: path.join(dir, 'providers-pre-v6.json'),
    receipt: path.join(dir, 'providers-recovery-receipt.json'),
  };
}
async function recoverLegacyProvidersFromEmptyV6(raw) {
  if (raw?.schemaVersion !== SCHEMA_VERSION || raw.credentials?.length || raw.connections?.length) return null;
  const recovery = legacyRecoveryPaths();
  if (await readJson(recovery.receipt, null)) return null;
  const legacyFile = path.join(paths().root, 'providers.json');
  const legacy = await readJson(legacyFile, null);
  if (!Array.isArray(legacy?.providers) || !legacy.providers.length) return null;
  await fsp.mkdir(recovery.dir, { recursive: true, mode: 0o700 });
  try { await fsp.access(recovery.providersBackup); }
  catch { await writeJson(recovery.providersBackup, legacy, { mode: 0o600 }); }
  const secretMigration = await secrets.migratePlainRecords();
  const recovered = migrateProviderState(legacy);
  recovered.revision = Math.max(Number(raw.revision) || 0, 0) + 1;
  await writeJson(filePath(), recovered, { mode: 0o600 });
  await writeJson(recovery.receipt, {
    schemaVersion: 1,
    recoveredAt: new Date().toISOString(),
    source: 'providers.json',
    providerCount: legacy.providers.length,
    credentialCount: recovered.credentials.length,
    connectionCount: recovered.connections.length,
    migratedSecretCount: secretMigration.migrated || 0,
    unrecoverableSecretCount: secretMigration.unrecoverable || 0,
  }, { mode: 0o600 });
  return recovered;
}
async function migrate(raw) {
  if (raw?.schemaVersion === SCHEMA_VERSION) return validateState(raw);
  if (raw && typeof raw === 'object') await backupLegacyState(raw);
  await secrets.migratePlainRecords().catch(() => ({ migrated: 0 }));
  const state = [6, 7].includes(raw?.schemaVersion)
    ? validateState({ ...raw, connections: (raw.connections || []).map((connection) => ({ ...connection, kind: connection.kind || 'api', models: (connection.models || []).map((model) => ({ ...model, verification: { ...model.verification, byEffort: { [raw.activeSelection?.connectionId === connection.id && raw.activeSelection?.modelId === model.id ? raw.activeSelection.reasoningEffort || 'default' : 'default']: { responses: model.verification?.responses || 'unknown', tools: model.verification?.tools || 'unknown', verifiedAt: model.verification?.verifiedAt || null } } } })) })) })
    : migrateProviderState(raw || {});
  await writeJson(filePath(), state, { mode: 0o600 });
  return await recoverLegacyProvidersFromEmptyV6(state) || state;
}
async function load() {
  const raw = await readJson(filePath(), null);
  if (raw?.schemaVersion === SCHEMA_VERSION) {
    const recovered = await recoverLegacyProvidersFromEmptyV6(raw);
    return recovered || validateState(raw);
  }
  return migrate(raw);
}
async function persist(next, expectedRevision) {
  const operation = queue.then(async () => {
    const current = await load();
    if (expectedRevision != null && Number(expectedRevision) !== current.revision) {
      const error = new Error('模型配置已被其他窗口修改，请刷新后重试'); error.code = 'model_config_stale'; throw error;
    }
    const state = validateState({ ...next, revision: current.revision + 1 });
    await writeJson(filePath(), state, { mode: 0o600 });
    return clone(state);
  });
  queue = operation.catch(() => {});
  return operation;
}
function invalidateConnection(connection) {
  connection.models = connection.models.map((model) => ({ ...model, verification: normalizeVerification() }));
}
async function publicSnapshot() {
  const state = await load();
  const credentials = await Promise.all(state.credentials.map(async (credential) => {
    const status = await secrets.getSecretStatus(credential.secretRef);
    return { ...credential, secretStatus: { present: status.present, readable: status.readable, issue: status.issue || null, revision: status.revision || 0 }, connectionCount: state.connections.filter((item) => item.credentialId === credential.id).length };
  }));
  return { ...state, credentials };
}
async function saveCredential(input, expectedRevision) {
  const state = await load();
  if (expectedRevision != null && Number(expectedRevision) !== state.revision) { const error = new Error('模型配置已被其他窗口修改，请刷新后重试'); error.code = 'model_config_stale'; throw error; }
  const current = state.credentials.find((item) => item.id === input?.id);
  const credential = normalizeCredential({ ...current, ...input, secretRef: current?.secretRef || input?.secretRef });
  const apiKeyProvided = Object.prototype.hasOwnProperty.call(input || {}, 'apiKey') && !!String(input.apiKey || '').trim();
  if (!current && !apiKeyProvided) throw new Error('新凭据必须填写 API Key');
  if (apiKeyProvided) await secrets.setSecret(credential.secretRef, String(input.apiKey).trim());
  const index = state.credentials.findIndex((item) => item.id === credential.id);
  if (index >= 0) state.credentials[index] = credential; else state.credentials.push(credential);
  if (apiKeyProvided) for (const connection of state.connections.filter((item) => item.credentialId === credential.id)) invalidateConnection(connection);
  return persist(state, expectedRevision);
}
async function deleteCredential(id, expectedRevision) {
  const state = await load();
  const credential = state.credentials.find((item) => item.id === String(id));
  if (!credential) return publicSnapshot();
  const references = [...state.connections.filter((item) => item.credentialId === credential.id), ...(state.setupOperations || []).filter((item) => item.credentialId === credential.id && item.status !== 'complete')].map((item) => ({ id: item.id, name: item.name || '未完成配置' }));
  if (references.length) { const error = new Error(`API 凭据仍被 ${references.length} 个 Responses 连接引用`); error.code = 'credential_in_use'; error.references = references; throw error; }
  state.credentials = state.credentials.filter((item) => item.id !== credential.id);
  const saved = await persist(state, expectedRevision);
  await secrets.deleteSecret(credential.secretRef);
  return saved;
}
function connectionRouteIdentity(connection) {
  return JSON.stringify({ kind: connection.kind, credentialId: connection.credentialId, baseUrl: connection.baseUrl, queryParams: connection.queryParams, auth: connection.auth });
}
async function saveConnection(input, expectedRevision) {
  const state = await load();
  const current = state.connections.find((item) => item.id === input?.id);
  const connection = normalizeConnection({ ...current, ...input });
  if (connection.kind === 'api' && !state.credentials.some((item) => item.id === connection.credentialId)) throw new Error('请选择有效的 API 凭据');
  if (current && connectionRouteIdentity(current) !== connectionRouteIdentity(connection)) invalidateConnection(connection);
  const index = state.connections.findIndex((item) => item.id === connection.id);
  if (index >= 0) state.connections[index] = connection; else state.connections.push(connection);
  if (state.activeSelection?.connectionId === connection.id) {
    const model = connection.models.find((item) => item.id === state.activeSelection.modelId);
    if (!model || model.availability === 'stale' || model.verification.responses !== 'ok') state.activeSelection = null;
  }
  return persist(state, expectedRevision);
}
async function deleteConnection(id, expectedRevision) {
  const state = await load();
  state.connections = state.connections.filter((item) => item.id !== String(id));
  if (state.activeSelection?.connectionId === id) state.activeSelection = null;
  return persist(state, expectedRevision);
}
async function updateModelVerification({ connectionId, modelId, mode, reasoningEffort, ok, errorCode, credentialRevision, expectedConnection }, expectedRevision) {
  const state = await load();
  const connection = state.connections.find((item) => item.id === connectionId);
  const model = connection?.models.find((item) => item.id === modelId);
  if (!connection || !model) throw new Error('待验证模型不存在');
  if (connection.kind === 'api' && credentialRevision != null) {
    const credential = state.credentials.find((item) => item.id === connection.credentialId);
    const currentSecret = credential ? await secrets.getSecretStatus(credential.secretRef) : null;
    if (currentSecret?.revision !== credentialRevision || !currentSecret?.readable
      || (expectedConnection && connectionRouteIdentity(connection) !== connectionRouteIdentity(expectedConnection))) {
      const error = new Error('验证期间连接或 Key 已变更，请重新验证');
      error.code = 'verification_obsolete';
      throw error;
    }
  }
  const verification = normalizeVerification(model.verification);
  if (mode === 'responses') verification.responses = ok ? 'ok' : 'failed';
  else if (mode === 'tools') verification.tools = ok ? 'ok' : 'failed';
  else throw new Error('未知模型验证模式');
  if (ok && reasoningEffort && !verification.verifiedEfforts.includes(reasoningEffort)) verification.verifiedEfforts.push(reasoningEffort);
  verification.verifiedAt = new Date().toISOString();
  verification.credentialRevision = credentialRevision || null;
  verification.errorCode = ok ? null : String(errorCode || 'verification_failed');
  verification.byEffort[reasoningEffort || 'default'] = { ...(verification.byEffort[reasoningEffort || 'default'] || { responses: 'unknown', tools: 'unknown' }), [mode]: ok ? 'ok' : 'failed', verifiedAt: verification.verifiedAt, credentialRevision: verification.credentialRevision, errorCode: verification.errorCode };
  model.verification = verification;
  if (!ok && mode === 'responses' && state.activeSelection?.connectionId === connectionId && state.activeSelection?.modelId === modelId && (state.activeSelection.reasoningEffort || null) === (reasoningEffort || null)) state.activeSelection = null;
  return persist(state, expectedRevision ?? state.revision);
}
async function setActive({ connectionId, modelId, reasoningEffort }, expectedRevision) {
  const state = await load();
  const connection = state.connections.find((item) => item.id === connectionId);
  const model = connection?.models.find((item) => item.id === modelId);
  if (!connection || !model || model.availability !== 'available') throw new Error('Responses 模型不存在或已不可用');
  if (connection.kind !== 'codexSubscription' && verificationFor(model, reasoningEffort).responses !== 'ok') throw new Error('此思考档位必须先通过文本验证');
  const effort = reasoningEffort == null || reasoningEffort === '' ? null : String(reasoningEffort);
  if (effort && !model.capabilities.reasoningEfforts.includes(effort) && !model.verification.verifiedEfforts.includes(effort)) throw new Error('该 reasoning effort 尚未由供应商声明或实际验证');
  state.activeSelection = { connectionId, modelId, reasoningEffort: effort };
  state.selectionNotice = '';
  return persist(state, expectedRevision);
}
async function connectionRoute(connectionId, modelId) {
  const state = await load();
  const selection = connectionId ? { connectionId, modelId } : state.activeSelection;
  const connection = state.connections.find((item) => item.id === selection?.connectionId);
  const model = connection?.models.find((item) => item.id === (modelId || selection?.modelId));
  if (!connection || !model || model.availability !== 'available') { const error = new Error('尚未配置可用的 Responses 连接'); error.code = 'responses_provider_required'; throw error; }
  if (connection.kind === 'codexSubscription') {
    const effort = connectionId ? null : state.activeSelection?.reasoningEffort ?? null;
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify({ kind: connection.kind, connection: connection.id, model: model.id, effort, revision: state.revision })).digest('hex');
    return { connection: clone(connection), model: clone(model), reasoningEffort: effort, apiKey: '', credentialRevision: null, fingerprint, modelProvider: 'openai' };
  }
  const credential = state.credentials.find((item) => item.id === connection.credentialId);
  const secret = credential ? await secrets.getSecretStatus(credential.secretRef) : null;
  if (!secret?.readable || !secret.value) { const error = new Error(`Responses 连接「${connection.name}」缺少可读取的 API Key`); error.code = 'responses_provider_required'; throw error; }
  const effort = connectionId ? null : state.activeSelection?.reasoningEffort ?? null;
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify({ connection, model: model.id, effort, secretRevision: secret.revision })).digest('hex');
  return { connection: clone(connection), model: clone(model), reasoningEffort: effort, apiKey: secret.value, credentialRevision: secret.revision, fingerprint, modelProvider: 'mana_responses' };
}

async function saveCodexSubscription(models, expectedRevision) {
  const state = await load();
  const normalizedModels = (Array.isArray(models) ? models : []).map((model) => normalizeModel({
    ...model,
    verification: { responses: 'ok', tools: 'ok', verifiedEfforts: model.capabilities?.reasoningEfforts || [], verifiedAt: new Date().toISOString() },
    source: 'codex',
  }, 'codex'));
  if (!normalizedModels.length) throw new Error('Codex 订阅未返回可用模型');
  const connection = normalizeConnection({
    id: 'codex-subscription', kind: 'codexSubscription', name: 'Codex 订阅', models: normalizedModels,
    discovery: { status: 'ok', discoveredAt: new Date().toISOString() },
  });
  const index = state.connections.findIndex((item) => item.kind === 'codexSubscription');
  if (index >= 0) state.connections[index] = connection; else state.connections.unshift(connection);
  // Refresh never selects a model. validateState clears a removed selection.
  if (state.activeSelection?.connectionId === connection.id && !normalizedModels.some((model) => model.id === state.activeSelection.modelId)) state.selectionNotice = '当前订阅模型已从列表消失，请重新选择模型。';
  return persist(state, expectedRevision);
}
async function credentialSecret(credentialId) {
  const state = await load();
  const credential = state.credentials.find((item) => item.id === String(credentialId || ''));
  if (!credential) { const error = new Error('API 凭据不存在'); error.code = 'credential_unavailable'; throw error; }
  const status = await secrets.getSecretStatus(credential.secretRef);
  if (!status.readable || !status.value) { const error = new Error(`API 凭据「${credential.name}」不可读取`); error.code = 'credential_unavailable'; throw error; }
  return { value: status.value, revision: status.revision, credential: clone(credential) };
}
async function activeRoute(connectionId = '', modelId = '') {
  const route = await connectionRoute(connectionId, modelId);
  if (route.connection.kind === 'api') route.model.verification = { ...route.model.verification, ...verificationFor(route.model, route.reasoningEffort) };
  if (!connectionId && route.model.verification.responses !== 'ok') {
    const error = new Error('当前模型尚未通过 Responses 文本验证');
    error.code = 'responses_provider_required';
    throw error;
  }
  return route;
}
function stateTokenSync() { return `model-config-v${SCHEMA_VERSION}`; }
function mergeDiscoveredModels(existingModels, discoveredModels) {
  const existing = new Map((existingModels || []).map((model) => [model.id, normalizeModel(model)]));
  const merged = (discoveredModels || []).map((model) => {
    const prior = existing.get(model.id); existing.delete(model.id);
    if (!prior) return normalizeModel(model, 'provider');
    const next = normalizeModel(model, 'provider');
    for (const [field, source] of Object.entries(prior.fieldSources || {})) if (source === 'manual') { next.capabilities[field] = prior.capabilities[field]; next.fieldSources[field] = 'manual'; }
    next.verification = prior.verification;
    return next;
  });
  for (const prior of existing.values()) merged.push({ ...prior, availability: 'stale' });
  return merged;
}


function verificationFor(model, effort) {
  return model?.verification?.byEffort?.[effort || 'default'] || { responses: 'unknown', tools: 'unknown' };
}
// All operation mutations share the configuration write queue; no stale whole-file writes.
async function mutateState(fn, expectedRevision) {
  const operation = queue.then(async () => {
    const state = await load();
    if (expectedRevision != null && state.revision !== expectedRevision) throw Object.assign(new Error('配置已更新，输入已保留，请重新提交'), { code: 'model_config_stale' });
    await fn(state);
    const next = validateState({ ...state, revision: state.revision + 1 });
    await writeJson(filePath(), next, { mode: 0o600 });
    return clone(next);
  });
  queue = operation.catch(() => {});
  return operation;
}
async function candidateRoute(connection, modelId) {
  const model = connection.models.find((item) => item.id === modelId);
  if (!model) throw new Error('请选择有效模型');
  const secret = await credentialSecret(connection.credentialId);
  return { connection: clone(connection), model: clone(model), apiKey: secret.value, credentialRevision: secret.revision, reasoningEffort: null, fingerprint: crypto.createHash('sha256').update(connectionRouteIdentity(connection) + secret.revision + modelId).digest('hex'), modelProvider: 'mana_responses' };
}

module.exports = { verificationFor, mutateState, candidateRoute, connectionRouteIdentity, SCHEMA_VERSION, activeRoute, connectionRoute, credentialSecret, deleteConnection, deleteCredential, load, mergeDiscoveredModels, normalizeCapabilities, normalizeConnection, normalizeCredential, normalizeModel, publicSnapshot, saveCodexSubscription, saveConnection, saveCredential, setActive, stateTokenSync, updateModelVerification, validateState };
