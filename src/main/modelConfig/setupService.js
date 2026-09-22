'use strict';
const config = require('./index');
const { discoveryPreview, templateById } = require('./providerTemplates');
const { discoverConnection, normalizeDiscoveredModel } = require('./connectionDiscovery');
const clone = (value) => JSON.parse(JSON.stringify(value));
const fault = (message, code) => Object.assign(new Error(message), { code });
function errorText(error) {
  let text = String(error?.message || error || '配置失败');
  try { const parsed = JSON.parse(text); text = parsed.error?.message || parsed.message || text; } catch { /* plain message */ }
  return text;
}

class ModelSetupService {
  constructor({ session, notify = () => {}, discover = discoverConnection } = {}) {
    this.session = session;
    this.notify = notify;
    this.discover = discover;
    this.running = new Map();
    this.starting = new Map();
  }
  async query(id) {
    const state = await config.load();
    const operations = (state.setupOperations || []).map((operation) => ({ ...operation, candidate: operation.candidate ? config.normalizeConnection(operation.candidate) : null })).map((operation) => operation.status === 'running' && !this.running.has(operation.id)
      ? { ...operation, status: 'paused', error: '上次配置已中断，点击继续，不会自动发送请求。' } : operation);
    return id ? operations.find((operation) => operation.id === id) || null : operations;
  }
  async update(id, patch) {
    let result;
    if (patch.error) {
      patch = { ...patch, error: errorText(patch.error) };
      const operation = await this.query(id);
      const secret = operation && await config.credentialSecret(operation.credentialId).catch(() => null);
      if (secret?.value) patch.error = patch.error.split(secret.value).join('[已隐藏 Key]');
    }
    await config.mutateState((state) => {
      const operation = state.setupOperations.find((item) => item.id === id);
      if (!operation) throw fault('配置操作不存在', 'setup_missing');
      Object.assign(operation, patch, { updatedAt: Date.now() });
      result = clone(operation);
    });
    this.notify(result);
    return result;
  }
  async start(input) {
    if (!/^[a-zA-Z0-9-]{1,100}$/.test(input.id || '')) throw new Error('配置操作 ID 无效');
    if (this.starting.has(input.id)) return this.starting.get(input.id);
    const promise = this.create(input);
    this.starting.set(input.id, promise);
    try { return await promise; } finally { this.starting.delete(input.id); }
  }
  async create(input) {
    const prior = await this.query(input.id);
    if (prior) return prior;
    let state = await config.load();
    if (state.revision !== input.expectedRevision) throw fault('配置已更新，输入已保留，请重新提交', 'model_config_stale');
    const original = input.connectionId ? state.connections.find((item) => item.id === input.connectionId) : null;
    if (input.connectionId && !original) throw fault('原连接已被删除', 'model_config_stale');
    if (input.useSaved && (!original || input.apiKey?.trim() || input.credentialId !== original.credentialId)) throw new Error('复用模型必须使用原连接的凭据');
    const preview = discoveryPreview(input);
    const approvedUrls = (input.approvedCandidateUrls || []).filter((url) => preview.candidates.some((candidate) => candidate.modelsUrl === url));
    if (!approvedUrls.length) throw fault('请确认实际请求地址', 'discovery_confirmation_required');
    const credentialId = input.apiKey?.trim() ? `setup-key-${input.id}` : input.credentialId;
    if (input.apiKey?.trim()) state = await config.saveCredential({ id: credentialId, name: `${input.name || new URL(input.inputUrl).hostname} Key`, apiKey: input.apiKey }, state.revision);
    const secret = await config.credentialSecret(credentialId);
    const operation = {
      id: input.id, connectionId: original?.id || `setup-connection-${input.id}`, credentialId,
      name: String(input.name || new URL(input.inputUrl).hostname),
      inputUrl: input.inputUrl, templateId: input.templateId || 'auto', authMode: input.authMode || 'auto', customHeaderName: input.customHeaderName || '',
      approvedCandidateUrls: approvedUrls, originalConnection: original ? clone(original) : null,
      originalSelection: clone(state.activeSelection), credentialRevision: secret.revision,
      status: input.useSaved && original ? 'awaiting_model' : 'running', stage: input.useSaved && original ? 'select' : 'discover', startedAt: Date.now(), updatedAt: Date.now(), error: '', errorCode: '', candidate: input.useSaved && original ? clone(original) : null, modelId: input.modelId || '', reasoningEffort: input.reasoningEffort || '',
    };
    await config.mutateState((current) => { current.setupOperations.push(operation); }, state.revision);
    if (!operation.candidate) this.launch(operation.id, {});
    return operation;
  }
  launch(id, input) {
    if (this.running.has(id)) return;
    const controller = new AbortController();
    this.running.set(id, controller);
    controller.promise = this.execute(id, input, controller.signal).catch(async (error) => {
      const cancelled = controller.signal.aborted;
      await this.update(id, { status: cancelled ? 'cancelled' : error.code === 'codex_turn_active' ? 'paused' : 'failed', error: cancelled ? '配置已取消，可继续。' : error.message, errorCode: cancelled ? 'setup_cancelled' : error.code || 'setup_failed' }).catch(() => {});
    }).finally(() => { this.running.delete(id); });
  }
  async retry(id, input = {}) {
    const operation = await this.query(id);
    if (!operation) throw new Error('配置操作不存在');
    if (operation.status === 'complete' || this.running.has(id)) return operation;
    if (operation.errorCode === 'model_config_stale') throw fault('原配置已改变，请保留输入并重新检测以创建新的候选配置。', 'model_config_stale');
    this.launch(id, input);
    return { ...operation, status: 'running' };
  }
  async cancel(id) {
    const active = this.running.get(id);
    if (active) { active.abort(); await active.promise; return this.query(id); }
    return this.update(id, { status: 'cancelled', error: '配置已取消，可继续。' });
  }
  async ensureCurrent(operation) {
    const secret = await config.credentialSecret(operation.credentialId);
    if (secret.revision !== operation.credentialRevision) throw fault('Key 已更新，请重新检测；输入已保留。', 'model_config_stale');
    const state = await config.load();
    const current = state.connections.find((item) => item.id === operation.connectionId) || null;
    if (JSON.stringify(current) !== JSON.stringify(operation.originalConnection)) throw fault('原连接已被修改，请重新检测；输入已保留。', 'model_config_stale');
  }
  async execute(id, input, signal) {
    let operation = await this.query(id);
    const check = () => { if (signal.aborted) throw fault('配置已取消', 'setup_cancelled'); };
    check();
    await this.ensureCurrent(operation);
    operation = await this.update(id, { status: 'running', error: '', errorCode: '', stageStartedAt: Date.now() });
    if (!operation.candidate) {
      await this.update(id, { stage: 'discover' });
      let found;
      if (input.manualModelId?.trim()) {
        const preview = discoveryPreview(operation);
        const target = preview.candidates.find((item) => operation.approvedCandidateUrls.includes(item.modelsUrl));
        const mode = operation.authMode === 'auto' ? preview.authCandidates[0] : operation.authMode;
        found = { ...target, queryParams: preview.queryParams, auth: mode === 'bearer' ? { mode: 'bearer' } : { mode: 'header', headerName: mode === 'custom' ? operation.customHeaderName : mode }, template: preview.template, models: [{ ...normalizeDiscoveredModel({ id: input.manualModelId.trim() }), source: 'manual' }] };
      } else {
        const secret = await config.credentialSecret(operation.credentialId);
        found = await this.discover({ ...operation, apiKey: secret.value, signal });
      }
      check();
      const models = config.mergeDiscoveredModels(operation.originalConnection?.models || [], found.models).sort((a, b) => a.id.localeCompare(b.id, 'en'));
      const candidate = config.normalizeConnection({ id: operation.connectionId, name: operation.name, credentialId: operation.credentialId, baseUrl: found.baseUrl, modelsUrl: found.modelsUrl, queryParams: found.queryParams, auth: found.auth, templateId: found.template.id, models, discovery: { status: input.manualModelId ? 'manual' : 'ok', discoveredAt: new Date().toISOString() } });
      if (!operation.originalConnection || config.connectionRouteIdentity(candidate) !== config.connectionRouteIdentity(operation.originalConnection)) candidate.models = candidate.models.map((model) => config.normalizeModel({ ...model, verification: {} }));
      const hint = templateById(candidate.templateId).preferredModelHint;
      const available = candidate.models.filter((model) => model.availability !== 'stale');
      const recommended = hint && available.find((model) => model.id.includes(hint));
      const selected = recommended || available[0];
      await this.update(id, { candidate, status: 'awaiting_model', stage: 'select', modelId: selected.id, reasoningEffort: '', recommended: !!recommended });
      return;
    }
    const modelId = input.modelId || operation.modelId;
    const effort = input.reasoningEffort !== undefined ? input.reasoningEffort : operation.reasoningEffort || '';
    const candidate = clone(operation.candidate);
    const model = candidate.models.find((item) => item.id === modelId && item.availability !== 'stale');
    if (!model) throw new Error('请选择有效模型');
    if (input.capabilities) {
      const next = config.normalizeCapabilities(input.capabilities);
      if (JSON.stringify(next) !== JSON.stringify(model.capabilities)) {
        model.fieldSources = { ...model.fieldSources, ...Object.fromEntries(Object.keys(next).filter((key) => JSON.stringify(next[key]) !== JSON.stringify(model.capabilities[key])).map((key) => [key, 'manual'])) };
        model.capabilities = next;
        model.verification = config.normalizeModel({ id: model.id }).verification;
      }
    }
    operation = await this.update(id, { modelId, reasoningEffort: effort, candidate });
    const route = await config.candidateRoute(candidate, modelId);
    for (const mode of ['responses', 'tools']) {
      check();
      const status = config.verificationFor(model, effort);
      if (status[mode] === 'ok' || (mode === 'tools' && input.chatOnly && status.responses === 'ok' && status.tools === 'failed')) continue;
      await this.update(id, { stage: mode, stageStartedAt: Date.now() });
      try {
        await this.session().verifyModel({ connectionId: candidate.id, modelId, mode, reasoningEffort: effort || null, candidateRoute: route, signal });
        check();
        model.verification.byEffort[effort || 'default'] = { ...status, [mode]: 'ok', credentialRevision: operation.credentialRevision, verifiedAt: new Date().toISOString() };
        if (effort && !model.verification.verifiedEfforts.includes(effort)) model.verification.verifiedEfforts.push(effort);
      } catch (error) {
        if (signal.aborted || ['codex_turn_active', 'setup_cancelled', 'turn_interrupted'].includes(error.code)) throw error;
        model.verification.byEffort[effort || 'default'] = { ...status, [mode]: 'failed', errorCode: error.code || 'verification_failed' };
        Object.assign(model.verification, model.verification.byEffort[effort || 'default']);
        await this.update(id, { candidate });
        if (mode === 'tools') { await this.update(id, { status: 'awaiting_chat', error: error.message, errorCode: error.code || 'tools_failed' }); return; }
        throw error;
      }
      Object.assign(model.verification, model.verification.byEffort[effort || 'default']);
      await this.update(id, { candidate });
    }
    check();
    await this.ensureCurrent(operation);
    await this.update(id, { stage: 'activate', stageStartedAt: Date.now() });
    await this.session().prepareModelSwitch({ interruptActive: input.interruptActive === true });
    check();
    await config.mutateState(async (state) => {
      check();
      const current = state.connections.find((item) => item.id === operation.connectionId) || null;
      if (JSON.stringify(current) !== JSON.stringify(operation.originalConnection) || JSON.stringify(state.activeSelection) !== JSON.stringify(operation.originalSelection)) throw fault('配置或当前模型已在其他窗口改变，请重新检测。', 'model_config_stale');
      const secret = await config.credentialSecret(operation.credentialId);
      if (secret.revision !== operation.credentialRevision) throw fault('Key 已更新，请重新检测。', 'model_config_stale');
      check();
      const index = state.connections.findIndex((item) => item.id === candidate.id);
      if (index < 0) state.connections.push(candidate); else state.connections[index] = candidate;
      state.activeSelection = { connectionId: candidate.id, modelId, reasoningEffort: effort || null };
      state.selectionNotice = '';
      Object.assign(state.setupOperations.find((item) => item.id === id), { candidate, status: 'complete', stage: 'complete', error: '', updatedAt: Date.now() });
    });
    this.notify(await this.query(id));
  }
}
module.exports = { ModelSetupService };
