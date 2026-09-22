'use strict';

const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');
const modelConfig = require('../modelConfig');
const { templateById } = require('../modelConfig/providerTemplates');
const chatHistory = require('../store/chatHistory');
const chatRuns = require('../store/chatRuns');
const skillsStore = require('../store/skills');
const novels = require('../store/novels');
const { paths } = require('../store/paths');
const { bodyChineseCharacterCount, chineseCharacterCount, listResourceDescriptors, proseRepetitionEvidence, readResource } = require('../mcp/novelResources');
const { applyPrepared, prepareChanges } = require('../mcp/mutationService');
const { CodexProcessManager } = require('./processManager');
const { createDeepSeekNoReasoningBridge } = require('./deepseekNoReasoningBridge');
const { collectNativeNovelChanges, resourceRefFromRelativePath, resourceRelativePath, syncNativeNovelWorkspace } = require('./nativeNovelWorkspace');
const { developmentCacheRoot } = require('./runtimeManifest');
const { TaskLedger, normalizeTaskConstraints } = require('./taskLedger');
const { invalidateForResources, recordReview } = require('./reviewLedger');
const { contractError, hash: contentHash } = require('./contracts');
const { getAuthorization, revokeAuthorization, setAuthorization, withAuthorization } = require('./writingAuthorization');
const { getProgress, saveProgress } = require('./writingProgress');
const { assertSelectionChange, evidenceForNativeChanges, isAuthorizedProseAppend, nativeChangeFingerprint } = require('./nativeChangePolicy');

const BUILTIN_SKILLS = new Set([
  'mana-novel-workspace', 'mana-fiction-writing', 'mana-de-ai',
  'mana-consistency-review', 'mana-outline', 'mana-character-roleplay',
  'mana-import-enrichment',
]);

function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }
function digest(value) { return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function resultId(result, kind) { return result?.[kind]?.id || result?.[`${kind}Id`] || result?.[`${kind}_id`] || ''; }
function inputItem(message) {
  return {
    type: 'message',
    role: message.role,
    content: [{ type: message.role === 'assistant' ? 'output_text' : 'input_text', text: String(message.text || '') }],
  };
}
function itemArguments(item) {
  const value = item?.arguments || item?.args || item?.input || null;
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(String(value || '')); } catch { return {}; }
}
function runtimeEntry() {
  const root = path.resolve(__dirname, '..', '..', '..');
  return path.join(root, 'mcp-server-entry.js');
}
function builtinSkillRoot() {
  const packaged = process.resourcesPath && path.join(process.resourcesPath, 'codex-skills');
  if (packaged && fs.existsSync(packaged)) return packaged;
  return path.resolve(__dirname, '..', '..', '..', 'resources', 'codex-skills');
}
function additionalContext(payload, editorSnapshot, workspaceRoot = '') {
  const constraints = normalizeTaskConstraints(payload.taskConstraints);
  return {
    novelId: { kind: 'application', value: String(payload.novelId || '') },
    resourceRef: { kind: 'application', value: String(editorSnapshot.resourceRef || '') },
    baseHash: { kind: 'application', value: String(editorSnapshot.baseHash || '') },
    selection: { kind: 'application', value: JSON.stringify(editorSnapshot.selection || null) },
    nativeWorkspace: { kind: 'application', value: String(workspaceRoot || '') },
    resourcePath: { kind: 'application', value: editorSnapshot.resourceRef ? resourceRelativePath(editorSnapshot.resourceRef) : '' },
    taskConstraints: { kind: 'application', value: JSON.stringify(constraints) },
  };
}
function modelCatalogForRoute(route) {
  if (route.connection.kind === 'codexSubscription') return null;
  const template = templateById(route.connection.templateId);
  const contract = template.codexModels?.[route.model.id] || null;
  // A custom Codex catalog entry has required fields whose values must come
  // from an explicit, versioned provider contract. Generic/discovered models
  // work without a catalog entry; fabricating truncation metadata for them
  // would both violate schema and pretend unknown limits are known.
  if (!contract) return null;
  const capabilities = route.model.capabilities || {};
  const contextWindow = capabilities.contextWindow || contract?.contextWindow || null;
  const truncationLimit = capabilities.maxOutputTokens || contract?.truncationLimit || null;
  const reasoningEfforts = [...new Set([...(capabilities.reasoningEfforts || []), ...(route.model.verification?.verifiedEfforts || []), ...(contract?.reasoningEfforts || [])])];
  const catalogReasoningEfforts = reasoningEfforts.filter((effort) => effort !== 'none');
  const inputModalities = capabilities.inputModalities?.length ? capabilities.inputModalities : contract?.inputModalities || ['text'];
  const model = {
    slug: route.model.id,
    display_name: route.model.name || route.model.id,
    description: `${route.connection.name} Responses model`,
    base_instructions: '你是小说创作工作台中的 Codex。只通过应用允许的原生工具工作。',
    // `none` is a valid Responses request toggle but is not a Codex model
    // catalog reasoning preset. Keep it in activeSelection/turn config and
    // describe only actual reasoning levels in the catalog.
    default_reasoning_level: catalogReasoningEfforts.includes(route.reasoningEffort) ? route.reasoningEffort : catalogReasoningEfforts[0] || 'low',
    supported_reasoning_levels: catalogReasoningEfforts.map((effort) => ({ effort, description: `${effort} (provider metadata or verified)` })),
    shell_type: 'shell_command',
    visibility: 'list',
    supported_in_api: true,
    priority: 1,
    include_skills_usage_instructions: false,
    include_plugin_usage_instructions: false,
    include_apps_usage_instructions: false,
    supports_reasoning_summary_parameter: false,
    default_reasoning_summary: 'none',
    support_verbosity: !!(capabilities.verbosityLevels?.length || contract?.defaultVerbosity),
    default_verbosity: contract?.defaultVerbosity || capabilities.verbosityLevels?.[0] || 'low',
    apply_patch_tool_type: 'freeform',
    web_search_tool_type: 'text',
    ...(truncationLimit ? { truncation_policy: { mode: 'tokens', limit: truncationLimit } } : {}),
    supports_image_detail_original: contract.supportsImageDetailOriginal === true,
    ...(contextWindow ? { context_window: contextWindow, max_context_window: contextWindow } : {}),
    effective_context_window_percent: 95,
    experimental_supported_tools: [],
    input_modalities: inputModalities,
    supports_search_tool: false,
    use_responses_lite: false,
    tool_mode: null,
    multi_agent_version: contract?.multiAgentVersion || 'v1',
  };
  return { models: [model] };
}
function validateNativeFileChanges(workspaceRoot, value) {
  if (!workspaceRoot || !Array.isArray(value) || !value.length) throw new Error('原生补丁未提供可验证的文件变更');
  const root = path.resolve(workspaceRoot);
  const approved = [];
  const seen = new Set();
  for (const change of value) {
    const targets = [change?.path, change?.kind?.move_path].filter(Boolean);
    if (!targets.length) throw new Error('原生补丁包含缺少路径的文件变更');
    for (const target of targets) {
      const absolute = path.isAbsolute(String(target)) ? path.resolve(String(target)) : path.resolve(root, String(target));
      const relative = path.relative(root, absolute);
      if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error(`原生补丁越出小说工作区：${target}`);
      }
      const normalized = relative.replaceAll(path.sep, '/');
      const resourceRef = resourceRefFromRelativePath(normalized);
      if (!seen.has(resourceRef)) {
        seen.add(resourceRef);
        approved.push({ resourceRef, path: normalized, kind: clone(change.kind || null), diff: String(change.diff || '') });
      }
    }
  }
  if (approved.length > 16) throw new Error('原生补丁单次最多修改 16 个小说资源');
  return approved;
}
async function novelBodyCjk(entry) {
  if (!entry) return 0;
  const refs = (await listResourceDescriptors(entry)).filter((item) => item.kind === 'chapter').map((item) => item.resourceRef);
  const resources = await Promise.all(refs.map((resourceRef) => readResource(entry, resourceRef).catch(() => null)));
  return resources.filter(Boolean).reduce((sum, resource) => sum + bodyChineseCharacterCount(resource.content), 0);
}
function projectNotification(message, run) {
  const method = String(message?.method || '');
  const params = message?.params || {};
  const base = { runId: run.runId, conversationId: run.conversationId, threadId: run.threadId, turnId: run.turnId || resultId(params, 'turn') || null };
  if (method === 'turn/started') return { ...base, type: 'turn_started' };
  if (method === 'item/agentMessage/delta') return { ...base, type: 'text_delta', delta: String(params.delta || '') };
  if (method === 'item/started') return { ...base, type: 'item_started', item: clone(params.item || null) };
  if (method === 'item/completed') return { ...base, type: 'item_completed', item: clone(params.item || null) };
  if (method === 'turn/completed' || method === 'turn/failed') {
    const status = String(params.turn?.status || params.status || (method === 'turn/failed' ? 'failed' : 'completed'));
    if (status === 'interrupted' || status === 'cancelled') return { ...base, type: 'turn_interrupted' };
    if (status !== 'completed') {
      const messageText = params.turn?.error?.message || params.error?.message || 'Codex turn failed';
      return { ...base, type: 'turn_failed', error: messageText, failure: { code: params.turn?.error?.code || params.error?.code || 'model_turn_failed', message: messageText, stage: 'model-turn', savedResources: run.committedResources || [] } };
    }
    return { ...base, type: 'turn_completed', usage: clone(params.turn?.usage || params.usage || null) };
  }
  return null;
}

class CodexSessionService extends EventEmitter {
  constructor() {
    super();
    this.processManager = null;
    this.providerBridge = null;
    this.routeFingerprint = '';
    this.activeRuns = new Map();
    this.threadRuns = new Map();
    this.projectRuns = new Map();
    this.pendingConfirmations = new Map();
    this.knownThreads = new Set();
    this.notificationQueue = Promise.resolve();
    this.processTransition = Promise.resolve();
    this.ledger = new TaskLedger();
    this.runRecords = new Map();
    this.startPromises = new Map();
    this.checkpointTimers = new Map();
    this.recoveryPromise = null;
    chatHistory.setBranchMutationGuard(({ threadId }) => {
      if (this.threadRuns.has(String(threadId))) throw contractError('对话正在启动或运行，请先停止任务', 'chat_turn_active');
    });
  }

  async getWritingAuthorization({ novelId } = {}) {
    const entry = novelId ? await novels.getNovelById(String(novelId)) : null;
    if (!entry) throw new Error('小说项目不存在');
    return getAuthorization(entry);
  }

  async setWritingAuthorization({ novelId, mode } = {}) {
    const entry = novelId ? await novels.getNovelById(String(novelId)) : null;
    if (!entry) throw new Error('小说项目不存在');
    const authorization = await setAuthorization(entry, mode);
    this._emitEvent({ type: 'writing_authorization_changed', novelId: entry.id, authorization });
    return authorization;
  }

  async revokeWritingAuthorization({ novelId } = {}) {
    const entry = novelId ? await novels.getNovelById(String(novelId)) : null;
    if (!entry) throw new Error('小说项目不存在');
    const authorization = await revokeAuthorization(entry);
    this._emitEvent({ type: 'writing_authorization_changed', novelId: entry.id, authorization });
    return authorization;
  }

  async getWritingProgress(query = {}) {
    return getProgress(query);
  }

  async getResourceContext({ novelId, resourceRef } = {}) {
    const entry = await novels.getNovelById(String(novelId || ''));
    if (!entry) throw new Error('小说项目不存在');
    const resource = await readResource(entry, String(resourceRef || ''));
    return { novelId: entry.id, resourceRef: resource.resourceRef, baseHash: resource.sourceHash };
  }

  async _updateProgress(run, patch = {}) {
    if (!run?.entry || !run?.progress) return null;
    run.progress = {
      ...run.progress,
      ...patch,
      elapsedMs: Math.max(0, Date.now() - run.progress.startedAtMs),
      updatedAt: new Date().toISOString(),
    };
    await saveProgress(run.progress);
    this._emitEvent({ type: 'writing_progress', runId: run.runId, conversationId: run.conversationId, novelId: run.entry.id, progress: clone(run.progress) });
    return run.progress;
  }

  async _ensureProcess(route) {
    const operation = this.processTransition.then(() => this._ensureProcessNow(route));
    this.processTransition = operation.catch(() => {});
    return operation;
  }

  async _ensureProcessNow(route) {
    const runtimeFingerprint = route.connection.kind === 'codexSubscription' ? 'codex-subscription-managed-auth' : route.fingerprint;
    if (this.processManager && this.routeFingerprint === runtimeFingerprint) return this.processManager.start();
    if (this.processManager && this.activeRuns.size > 0) {
      const error = new Error('当前仍有 Codex turn 在运行，完成或取消后才能切换模型连接');
      error.code = 'codex_turn_active';
      throw error;
    }
    if (this.processManager) await this.processManager.stop();
    if (this.providerBridge) await this.providerBridge.close();
    this.providerBridge = null;
    if (route.connection.kind === 'api' && route.connection.templateId === 'deepseek' && route.reasoningEffort === 'none') {
      this.providerBridge = await createDeepSeekNoReasoningBridge(route.connection.baseUrl);
    }
    this.processManager = new CodexProcessManager({
      runtimeRoot: app?.isPackaged ? null : path.join(developmentCacheRoot(), 'staging'),
      extraEnv: route.connection.kind === 'api' ? { MANA_CODEX_API_KEY: route.apiKey } : {},
      modelCatalog: modelCatalogForRoute(route),
      requestHandler: (method, params, message) => this._handleServerRequest(method, params, message),
    });
    this.routeFingerprint = runtimeFingerprint;
    this.knownThreads.clear();
    this.processManager.on('notification', (message) => {
      this._cacheNativePatchUpdate(message);
      this.notificationQueue = this.notificationQueue.then(() => this._onNotification(message)).catch((error) => this._failAll(error));
    });
    this.processManager.on('exit', (error) => this._failAll(error));
    const client = await this.processManager.start();
    const roots = [builtinSkillRoot(), path.join(paths().root, 'codex-home', 'skills')];
    await client.request('skills/extraRoots/set', { extraRoots: roots });
    await this._syncSkillIsolation(client);
    return client;
  }

  async _syncSkillIsolation(client) {
    const configured = new Map((await skillsStore.listSkills()).map((skill) => [skill.name, skill.enabled !== false]));
    const listed = await client.request('skills/list', { cwds: [this.processManager.runDirectory], forceReload: true });
    for (const skill of (listed.data || []).flatMap((group) => group.skills || [])) {
      const enabled = configured.get(skill.name) === true;
      if (skill.enabled === enabled) continue;
      await client.request('skills/config/write', { path: null, name: skill.name, enabled });
    }
    return client.request('skills/list', { cwds: [this.processManager.runDirectory], forceReload: true });
  }

  async _threadConfig(route, novelId, runId, { includeMcp = true, disableAgents = false } = {}) {
    const entry = novelId ? await novels.getNovelById(novelId) : null;
    const subscription = route.connection.kind === 'codexSubscription';
    return {
      model_provider: subscription ? 'openai' : 'mana_responses',
      ...(!subscription ? { model_providers: {
        mana_responses: {
          name: route.connection.name,
          base_url: this.providerBridge?.baseUrl || route.connection.baseUrl,
          ...(route.connection.auth.mode === 'bearer'
            ? { env_key: 'MANA_CODEX_API_KEY' }
            : { env_http_headers: { [route.connection.auth.headerName]: 'MANA_CODEX_API_KEY' } }),
          ...(Object.keys(route.connection.queryParams || {}).length ? { query_params: route.connection.queryParams } : {}),
          wire_api: 'responses',
          requires_openai_auth: false,
          request_max_retries: 1,
          stream_max_retries: 1,
          supports_websockets: false,
          supports_standalone_web_search: false,
        },
      } } : {}),
      ...(route.reasoningEffort ? { model_reasoning_effort: route.reasoningEffort } : {}),
      ...(route.model.capabilities?.contextWindow ? { model_context_window: route.model.capabilities.contextWindow } : {}),
      // DeepSeek accepts native function tools and apply_patch, but rejects the
      // custom exec wrapper produced by code mode. Keep MCP and agents intact.
      features: {
        ...(route.connection.templateId === 'deepseek' || disableAgents ? { code_mode: false } : {}),
        ...(disableAgents ? { multi_agent: false, multi_agent_v2: false } : {}),
      },
      ...(disableAgents ? { agents: { enabled: false } } : {}),
      ...(includeMcp ? { mcp_servers: {
        novel_tools: {
          command: process.execPath,
          args: [runtimeEntry(), ...(novelId ? ['--novel-id', novelId] : []), ...(entry?.dir ? ['--novel-dir', entry.dir] : []), '--run-id', runId],
          env: { ELECTRON_RUN_AS_NODE: '1', MANA_USER_DATA_ROOT: paths().root },
          enabled: true,
          required: true,
          // This isolated application-owned MCP is read-only. File mutations
          // use Codex native apply_patch and its App Server approval request.
          default_tools_approval_mode: 'approve',
          startup_timeout_sec: 10,
          tool_timeout_sec: 600,
          supports_parallel_tool_calls: true,
        },
      } } : {}),
    };
  }

  async _startThread(route, payload) {
    const client = await this._ensureProcess(route);
    const includeMcp = payload.includeMcp !== false;
    const config = await this._threadConfig(route, payload.novelId, payload.runId, { includeMcp, disableAgents: payload.disableAgents === true });
    const result = await client.request('thread/start', {
      model: route.model.id,
      modelProvider: route.modelProvider || 'mana_responses',
      cwd: payload.workspaceRoot || this.processManager.runDirectory,
      approvalPolicy: payload.workspaceRoot ? 'on-request' : 'never',
      sandbox: 'read-only',
      ephemeral: false,
      allowProviderModelFallback: false,
      baseInstructions: includeMcp
        ? '你是小说创作工作台中的 Codex。自行理解需求、管理上下文、使用显式提供的 Skill，并在适合时使用原生 subagent。小说 MCP server 标识是 novel_tools；直接调用它提供的 list_novel_resources、read_novel_resource、report_writing_progress 等命名工具，不得用通用 list_mcp_resources、list_mcp_resource_templates 或 read_mcp_resource 探测 server、读取 Skill 或代替小说工具。每类资源最多列举一次，已知 resourceRef 时直接读取，独立读取应在同一轮并行发起；不得读取与当前任务无关或已知为空的资源。只通过 novel_tools 读取小说资料；不得使用 shell、插件或网页工具。修改小说时只使用 Codex 原生 apply_patch 编辑 nativeWorkspace 中的映射文件；nativeWorkspace 本身就是补丁根目录，补丁路径必须是映射相对路径（如 chapters/chapter-001.md），绝不添加 novel/、nativeWorkspace 名或绝对路径前缀。原生 fileChange 由宿主按项目授权决定自动批准或展示差异；不得调用自定义写入工具，也不得声称提交完成前已写入真实小说。functions.exec 只能编排真实工具调用，禁止用代码循环、模板或字符串拼接生成小说正文。长篇任务以完整场景或章节为单位创作；先用 report_writing_progress 报告当前章节，自然落点后提交，提交成功后在同一回合继续下一场景或章节，直到本次内容目标完成。不得按固定字数切段，也不能把全部生成延迟到回合末尾。'
        : '你是小说创作工作台中的 Codex。当前是普通文本对话，没有挂载小说资料工具或写作 Skill；直接回答用户，不要尝试读取、修改或声称已读取小说项目。',
      developerInstructions: '应用只提供资源标识、映射路径与版本信息，不替你检索或裁剪上下文。范围不清时直接询问用户。不要暴露思维链。',
      config,
    });
    const threadId = resultId(result, 'thread');
    if (!threadId) throw new Error('Codex App Server 未返回 threadId');
    this.knownThreads.add(threadId);
    return threadId;
  }

  async _startNativeTurn(params) {
    return this.processManager.request('turn/start', params);
  }

  async _resumeThread(client, threadId, route, payload = {}) {
    if (this.knownThreads.has(threadId)) return;
    const config = await this._threadConfig(route, payload.novelId, payload.runId || `resume-${crypto.randomUUID()}`, { includeMcp: payload.includeMcp !== false });
    await client.request('thread/resume', {
      threadId,
      model: route.model.id,
      modelProvider: route.modelProvider || 'mana_responses',
      cwd: payload.workspaceRoot || this.processManager.runDirectory,
      approvalPolicy: payload.workspaceRoot ? 'on-request' : 'never',
      sandbox: 'read-only',
      config,
    });
    this.knownThreads.add(threadId);
  }

  async _bindConversation(route, payload, history) {
    const prior = history?.codexBinding;
    const toolMode = payload.includeMcp === false ? 'text' : 'tools';
    // Older DeepSeek threads may retain incompatible code-mode tool history.
    const transportVersion = route.connection.templateId === 'deepseek' ? ':native-functions-v1' : '';
    const bindingFingerprint = `${route.fingerprint}${transportVersion}:${toolMode}`;
    const reusable = prior?.schemaVersion === 1
      && prior.providerFingerprint === bindingFingerprint
      && String(prior.novelId || '') === String(payload.novelId || '');
    let threadId;
    let importedBoundaryMessageId = '';
    let importedHistoryHash = '';
    const client = await this._ensureProcess(route);
    if (reusable) {
      threadId = prior.threadId;
      await this._resumeThread(client, threadId, route, payload);
      importedBoundaryMessageId = prior.importedBoundaryMessageId || '';
      importedHistoryHash = prior.importedHistoryHash || '';
    } else {
      threadId = await this._startThread(route, payload);
      const branch = chatHistory.getBranch(history || {}).filter((message) => ['user', 'assistant'].includes(message.role) && !message.isStreaming && message.id !== payload.userMessageId);
      if (branch.length) {
        const chunkSize = 100;
        for (let offset = 0; offset < branch.length; offset += chunkSize) {
          await client.request('thread/inject_items', { threadId, items: branch.slice(offset, offset + chunkSize).map(inputItem) });
        }
        importedBoundaryMessageId = branch.at(-1)?.id || '';
        importedHistoryHash = digest(branch.map(({ id, role, text }) => ({ id, role, text })));
        if (branch.length > 100) await client.request('thread/compact/start', { threadId });
      }
      if (payload.persistence === 'chat') {
        await chatHistory.updateCodexBinding(payload.conversationId, {
          schemaVersion: 1,
          threadId,
          providerFingerprint: bindingFingerprint,
          novelId: payload.novelId || null,
          importedHistoryHash,
          importedBoundaryMessageId,
        });
      }
    }
    return threadId;
  }

  startTurn(payload = {}) {
    const runId = String(payload.runId || `run-${crypto.randomUUID()}`);
    const request = { ...clone(payload), persistence: payload.conversationId ? 'chat' : (payload.persistence || 'one-shot'), runId, userMessageId: String(payload.userMessageId || `user-${runId}`) };
    const fingerprint = digest({ ...request, attemptId: undefined });
    const known = this.runRecords.get(runId);
    if (known) {
      if (known.fingerprint !== fingerprint) return Promise.reject(contractError('相同运行 ID 的请求内容不同', 'run_identity_conflict'));
      return this.startPromises.get(runId) || Promise.resolve(clone(known));
    }
    const conversationId = String(request.conversationId || '');
    if (conversationId && (this.threadRuns.has(conversationId) || chatHistory.isBranchMutationPending(conversationId))) {
      return Promise.reject(contractError('该对话已有启动中或运行中的任务', 'chat_turn_active'));
    }
    if (conversationId) this.threadRuns.set(conversationId, runId);
    const record = { schemaVersion: 1, runId, conversationId, novelId: request.novelId || null,
      userMessageId: request.userMessageId, fingerprint, persistence: request.persistence || 'chat',
      status: 'starting', version: 1, text: '', items: [], savedResources: [],
      startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), capability: 'preparing' };
    this.runRecords.set(runId, record);
    const promise = this._startReserved(request, record);
    this.startPromises.set(runId, promise);
    promise.finally(() => { if (this.startPromises.get(runId) === promise) this.startPromises.delete(runId); }).catch(() => {});
    return promise;
  }

  async _startReserved(payload, record) {
    const { runId, conversationId } = record;
    const taskId = String(payload.taskId || payload.userMessageId || runId);
    const attemptId = String(payload.attemptId || `attempt-${crypto.randomUUID()}`);
    try {
      await this._recoverRuns();
      const durable = await chatRuns.get(runId);
      if (durable) {
        if (durable.fingerprint !== record.fingerprint) throw contractError('相同运行 ID 的请求内容不同', 'run_identity_conflict');
        this.runRecords.set(runId, durable);
        if (this.threadRuns.get(conversationId) === runId) this.threadRuns.delete(conversationId);
        return clone(durable);
      }
      if (!String(payload.text || '').trim()) throw new Error('消息不能为空');
      if (payload.persistence === 'chat') {
        await chatHistory.ensureUserMessage(conversationId, payload.novelId, { id: payload.userMessageId, text: String(payload.text).trim() });
        record.messageStored = true;
      }
      if (record.cancelRequested) throw contractError('启动已取消', 'turn_interrupted');
      await this._persistRecord(record);
      await this.ledger.start({ taskId, attemptId, runId, conversationId, constraints: payload.taskConstraints, route: null });
      const result = await this._startTurnRecorded({ ...payload, taskId, attemptId });
      if (record.status === 'starting') record.status = 'running';
      Object.assign(record, result);
      await this._checkpointRun(runId);
      this._emitEvent({ type: 'run_state', runId, conversationId });
      return { ...result, status: record.status, version: record.version };
    } catch (error) {
      if (error.code === 'run_identity_conflict') {
        if (this.threadRuns.get(conversationId) === runId) this.threadRuns.delete(conversationId);
        this.runRecords.delete(runId);
        throw error;
      }
      const interrupted = error.code === 'turn_interrupted';
      record.error = error.message;
      record.failure = { code: error.code || 'turn_start_failed', message: error.message, stage: 'start' };
      await this.ledger.finish(runId, 'start_failed', { error: record.failure }).catch(() => {});
      const run = this.activeRuns.get(runId);
      if (run) await this._finalizeRun(run, { type: interrupted ? 'turn_interrupted' : 'turn_failed', runId, conversationId, error: error.message, failure: record.failure });
      else {
        record.status = interrupted ? 'interrupted' : 'failed'; record.version++;
        try { await this._persistRecord(record); }
        catch (saveError) {
          record.checkpointError = saveError.message;
          this._scheduleCheckpoint(runId);
        }
        if (this.threadRuns.get(conversationId) === runId) this.threadRuns.delete(conversationId);
        if (this.projectRuns.get(String(payload.novelId)) === runId) this.projectRuns.delete(String(payload.novelId));
        this._emitEvent({ type: interrupted ? 'turn_interrupted' : 'turn_failed', runId, conversationId, error: error.message });
      }
      throw error;
    }
  }

  async _startTurnRecorded(payload) {
    const runId = String(payload?.runId || `run-${crypto.randomUUID()}`);
    const taskId = String(payload?.taskId || payload?.conversationId || runId);
    const attemptId = String(payload?.attemptId || `attempt-${crypto.randomUUID()}`);
    const conversationId = String(payload?.conversationId || '');
    const text = String(payload?.text || '').trim();
    if (!text) throw new Error('消息不能为空');
    if (this.activeRuns.has(runId)) throw new Error('runId 已在执行');
    if (conversationId && this.threadRuns.has(conversationId) && this.threadRuns.get(conversationId) !== runId) throw contractError('该对话已有进行中的 Codex turn', 'chat_turn_active');
    const route = await modelConfig.activeRoute();
    await this.ledger.record(runId, 'route_selected', { connectionId: route.connection.id, connectionKind: route.connection.kind, modelId: route.model.id, reasoningEffort: route.reasoningEffort });
    if (route.connection.kind === 'codexSubscription') {
      const login = await this.accountStatus({ refreshToken: true });
      if (login.account?.type !== 'chatgpt') throw contractError('Codex 订阅账户不可用，请重新登录', 'codex_login_required', { stage: 'authentication' });
    }
    const taskConstraints = normalizeTaskConstraints(payload.taskConstraints);
    const editorInput = payload.editorContext && typeof payload.editorContext === 'object' ? payload.editorContext : {};
    const novelToolTask = payload.persistence === 'chat'
      ? !!payload.novelId && route.model.verification.tools === 'ok'
      : !!payload.skillName || !!editorInput.resourceRef || !!editorInput.chapterFileName;
    if (novelToolTask && route.model.verification.tools !== 'ok') {
      const error = new Error('当前模型已知不支持小说工具调用。普通文本聊天仍可使用，请切换到工具验证通过的模型后再读取或修改小说资料。');
      error.code = 'model_tools_unavailable';
      throw error;
    }
    const history = payload.persistence === 'chat' ? await chatHistory.getThread(conversationId) : null;
    if (payload.persistence === 'chat' && !history) throw new Error('聊天记录不存在');
    if (history && String(history.novelId || '') !== String(payload.novelId || '')) throw contractError('对话不属于目标小说', 'conversation_project_mismatch');
    const entry = payload.novelId ? await novels.getNovelById(payload.novelId) : null;
    if (payload.novelId && !entry) throw new Error('小说项目不存在');
    if (entry && novelToolTask) {
      const existingRunId = this.projectRuns.get(String(entry.id));
      if (existingRunId && existingRunId !== runId) {
        throw contractError('该小说项目已有进行中的原生任务，请等待其结束后再开始新的写入任务', 'novel_turn_active', { stage: 'validation', activeRunId: existingRunId });
      }
      this.projectRuns.set(String(entry.id), runId);
    }
    if (entry && novelToolTask) await this._ensureProcess(route);
    const workspace = entry && novelToolTask
      ? await syncNativeNovelWorkspace(entry, this.processManager.workspacesDirectory)
      : null;
    const threadId = await this._bindConversation(route, { ...payload, runId, conversationId, workspaceRoot: workspace?.root || '', includeMcp: novelToolTask }, history);
    if (this.runRecords.get(runId)?.cancelRequested) throw contractError('启动已取消', 'turn_interrupted');
    const resourceRef = String(editorInput.resourceRef || (editorInput.chapterFileName ? `chapter:${editorInput.chapterFileName}` : '') || payload.editScope?.resourceRef || '');
    let baseHash = '';
    let editorContent = '';
    if (payload.novelId && resourceRef) {
      const resource = await readResource(entry, resourceRef);
      baseHash = resource.sourceHash;
      editorContent = resource.content;
    }
    const scope = payload.editScope || { mode: 'unrestricted' };
    if (!['unrestricted', 'selection', 'insertion'].includes(scope.mode)) throw contractError('未知修改范围', 'selection_stale');
    const restricted = scope.mode !== 'unrestricted';
    const start = Number(scope.start);
    const end = Number(scope.end);
    if (restricted && (!resourceRef || scope.resourceRef !== resourceRef || !scope.baseHash || scope.baseHash !== baseHash
      || !Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > editorContent.length
      || (scope.mode === 'selection' ? end <= start : end !== start))) {
      throw contractError('编辑目标或选区版本已经变化，请重新选择', 'selection_stale', { resourceRef });
    }
    const editor = { resourceRef, baseHash, selection: restricted ? { start, end } : null };
    if (restricted) taskConstraints.allowedWriteResourceRefs = [resourceRef];
    const writingOperation = !!entry && novelToolTask;
    const initialBodyCjk = writingOperation ? await novelBodyCjk(entry) : 0;
    const priorProgress = writingOperation ? await getProgress({ novelId: entry.id, conversationId }) : null;
    const startedAtMs = Date.now();
    const run = {
      runId, conversationId, threadId, turnId: '', userMessageId: String(payload.userMessageId || ''), text: '', items: [],
      taskId, attemptId, taskConstraints, skillName: String(payload.skillName || ''), persistence: payload.persistence || 'chat', entry, workspace,
      nativeFileItems: new Map(), approvedFileItems: new Map(), userRejectedFileItems: new Set(), completedFileItems: new Set(), committedResources: [], interruptionRequested: false,
      selectionState: editor.selection ? { resourceRef, content: editorContent, range: editor.selection } : null,
      progress: writingOperation ? {
        schemaVersion: 1, novelId: String(entry.id), conversationId, runId, phase: 'waiting-model', currentResourceRef: resourceRef || null,
        totalSavedBodyCjk: initialBodyCjk, initialTotalBodyCjk: initialBodyCjk, runNetBodyCjk: 0, lastSavedAt: priorProgress?.lastSavedAt || null, startedAtMs, elapsedMs: 0,
        target: taskConstraints.minBodyCjk != null || taskConstraints.maxBodyCjk != null
          ? { minimum: taskConstraints.minBodyCjk, maximum: taskConstraints.maxBodyCjk }
          : priorProgress?.target || { minimum: null, maximum: null },
        goalStatus: 'in-progress', updatedAt: new Date(startedAtMs).toISOString(),
      } : null,
    };
    this.activeRuns.set(runId, run);
    const record = this.runRecords.get(runId);
    if (record) Object.assign(record, { capability: workspace ? 'project-tools' : 'text-only', threadId, modelId: route.model.id });
    if (conversationId) this.threadRuns.set(conversationId, runId);
    if (run.progress) await this._updateProgress(run);
    const input = [{ type: 'text', text }];
    if (payload.skillName && novelToolTask) {
      const name = String(payload.skillName);
      if (!BUILTIN_SKILLS.has(name) && !/^mana-user-[a-z0-9._-]+$/u.test(name)) throw new Error('Skill 不存在或未启用');
      const skill = await skillsStore.getSkill(name);
      if (!skill || skill.enabled === false) throw new Error('Skill 不存在或未启用');
      const roots = [builtinSkillRoot(), path.join(paths().root, 'codex-home', 'skills')];
      const skillPath = roots.map((root) => path.join(root, name, 'SKILL.md')).find((file) => fs.existsSync(file));
      if (!skillPath) throw new Error(`Skill 文件不存在：${name}`);
      input.push({ type: 'skill', name, path: skillPath });
    }
    try {
      const result = await this._startNativeTurn({
        threadId,
        input,
        model: route.model.id,
        ...(route.reasoningEffort ? { effort: route.reasoningEffort } : {}),
        approvalPolicy: workspace ? 'on-request' : 'never',
        additionalContext: additionalContext(payload, editor, workspace?.root || ''),
        ...(payload.outputSchema ? { outputSchema: payload.outputSchema } : {}),
      });
      run.turnId = resultId(result, 'turn');
      if (!run.turnId) throw new Error('Codex App Server 未返回 turnId');
      if (run.interruptionRequested) await this.interrupt({ runId });
      return { runId, conversationId, threadId, turnId: run.turnId };
    } catch (error) {
      if (entry && this.projectRuns.get(String(entry.id)) === runId && !this.activeRuns.has(runId)) this.projectRuns.delete(String(entry.id));
      throw error;
    }
  }

  async interrupt({ runId }) {
    const run = this.activeRuns.get(String(runId));
    if (!run) {
      const record = this.runRecords.get(String(runId));
      if (record?.status === 'starting') { record.cancelRequested = true; return { interrupted: true, starting: true }; }
      return { interrupted: false };
    }
    run.interruptionRequested = true;
    if (!run.turnId) return { interrupted: false, starting: true };
    await this.processManager.request('turn/interrupt', { threadId: run.threadId, turnId: run.turnId });
    return { interrupted: true };
  }

  async prepareModelSwitch({ interruptActive = false } = {}) {
    const starting = [...this.runRecords.values()].filter(item => item.status === 'starting');
    if (starting.length) throw contractError('任务正在启动，请稍后切换模型', 'codex_turn_active');
    if (this.activeRuns.size === 0) return { interruptedRuns: 0 };
    if (!interruptActive) {
      const error = new Error('当前仍有 Codex turn 在运行。可以等待完成，或确认取消当前任务后切换模型。');
      error.code = 'codex_turn_active';
      error.activeRunIds = [...this.activeRuns.keys()];
      throw error;
    }
    const runs = [...this.activeRuns.values()];
    await Promise.allSettled(runs.map((run) => this.interrupt({ runId: run.runId })));
    const deadline = Date.now() + 5_000;
    while (this.activeRuns.size > 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    if (this.activeRuns.size > 0) {
      for (const run of [...this.activeRuns.values()]) {
        await this._finalizeRun(run, { type: 'turn_interrupted', runId: run.runId, conversationId: run.conversationId, error: '已取消当前任务以切换模型' });
      }
      await this.processManager?.stop();
      await this.providerBridge?.close();
      this.processManager = null;
      this.providerBridge = null;
      this.routeFingerprint = '';
    }
    return { interruptedRuns: runs.length };
  }

  async resolveConfirmation({ confirmationId, runId, accept, reason }) {
    const key = String(confirmationId || '');
    const pending = this.pendingConfirmations.get(key);
    if (!pending || (runId && pending.run.runId !== runId)) throw new Error('确认请求已失效');
    if (pending.kind !== 'native-file-change') throw new Error('确认请求已失效');
    this.pendingConfirmations.delete(key);
    if (accept) pending.run.approvedFileItems.set(pending.itemId, {
      nativeChanges: pending.nativeChanges,
      fingerprint: pending.fingerprint,
      evidence: pending.evidence,
      nextSelectionState: pending.nextSelectionState,
      acceptedAt: new Date().toISOString(),
      approvalKind: 'explicit',
      consumed: false,
    });
    else pending.run.userRejectedFileItems.add(pending.itemId);
    await this.ledger.record(pending.run.runId, 'confirmation_resolved', { confirmationId: key, itemId: pending.itemId, decision: accept ? 'accept' : 'decline', reason: reason ? String(reason) : null });
    await this._updateProgress(pending.run, { phase: accept ? 'tool-running' : 'waiting-model' });
    const record = this.runRecords.get(pending.run.runId);
    if (record) { record.status = 'running'; record.confirmation = null; record.version++; }
    await this._checkpointRun(pending.run.runId);
    this._emitEvent({ type: 'run_state', runId: pending.run.runId, conversationId: pending.run.conversationId });
    pending.resolve({ decision: accept ? 'accept' : 'decline', ...(reason ? { reason: String(reason) } : {}) });
    return { resolved: true };
  }

  _subscriptionBootstrapRoute() {
    return {
      connection: { id: 'codex-subscription', kind: 'codexSubscription', name: 'Codex 订阅', templateId: 'codex-subscription' },
      model: { id: 'gpt-5.6-luna', name: 'gpt-5.6-luna', capabilities: {}, verification: { responses: 'ok', tools: 'ok' } },
      reasoningEffort: 'medium', apiKey: '', credentialRevision: null,
      fingerprint: 'codex-subscription-managed-auth', modelProvider: 'openai',
    };
  }

  async accountStatus({ refreshToken = false } = {}) {
    // account/read uses the shared auth store, independently of a thread's
    // provider. A background UI refresh must not switch an active API runtime.
    await this.processTransition;
    const client = this.processManager
      ? await this.processManager.start()
      : await this._ensureProcess(this._subscriptionBootstrapRoute());
    const result = await client.request('account/read', { refreshToken: !!refreshToken });
    return { account: result?.account || null, requiresOpenaiAuth: !!result?.requiresOpenaiAuth };
  }

  async accountLogin({ mode = 'browser' } = {}) {
    if (!['browser', 'device'].includes(mode)) throw new Error('未知 Codex 登录方式');
    const client = await this._ensureProcess(this._subscriptionBootstrapRoute());
    const params = mode === 'device'
      ? { type: 'chatgptDeviceCode' }
      : { type: 'chatgpt', useHostedLoginSuccessPage: true, appBrand: 'chatgpt' };
    const result = await client.request('account/login/start', params);
    return {
      type: result?.type || params.type,
      loginId: result?.loginId || null,
      authUrl: result?.authUrl || null,
      verificationUrl: result?.verificationUrl || null,
      userCode: result?.userCode || null,
    };
  }

  async accountCancel({ loginId } = {}) {
    if (!loginId) throw new Error('loginId 不能为空');
    const client = await this._ensureProcess(this._subscriptionBootstrapRoute());
    await client.request('account/login/cancel', { loginId: String(loginId) });
    return { cancelled: true };
  }

  async accountLogout() {
    const client = await this._ensureProcess(this._subscriptionBootstrapRoute());
    await client.request('account/logout', {});
    return { loggedOut: true };
  }

  async accountRateLimits() {
    const client = await this._ensureProcess(this._subscriptionBootstrapRoute());
    return client.request('account/rateLimits/read', {});
  }

  async refreshSubscriptionModels({ expectedRevision } = {}) {
    const account = await this.accountStatus({ refreshToken: true });
    if (account.account?.type !== 'chatgpt') {
      const error = new Error('请先登录 Codex 订阅账户');
      error.code = 'codex_login_required';
      throw error;
    }
    const client = await this._ensureProcess(this._subscriptionBootstrapRoute());
    const result = await client.request('model/list', { limit: 100 });
    const data = result?.data || result?.models || [];
    const models = data.filter((item) => item && item.id !== 'auto' && item.hidden !== true && item.visibility !== 'hidden').map((item) => {
      const efforts = (item.supportedReasoningEfforts || item.supportedReasoningLevels || item.supported_reasoning_levels || []).map((entry) => typeof entry === 'string' ? entry : entry.reasoningEffort || entry.effort).filter(Boolean);
      return {
        id: String(item.id || item.slug || ''), name: String(item.displayName || item.display_name || item.name || item.id || item.slug || ''),
        capabilities: {
          contextWindow: item.contextWindow || item.context_window || null,
          maxOutputTokens: item.maxOutputTokens || item.max_output_tokens || null,
          inputModalities: item.inputModalities || item.input_modalities || ['text'],
          supportsTools: true, supportsStructuredOutput: null,
          reasoningEfforts: efforts, verbosityLevels: item.verbosityLevels || item.verbosity_levels || [],
        },
      };
    }).filter((item) => item.id);
    const state = await modelConfig.saveCodexSubscription(models, expectedRevision);
    return { state, account: account.account };
  }

  async status() {
    try {
      const route = await modelConfig.activeRoute();
      // Configuration status is read-only: switching the process here can
      // terminate a candidate probe between thread/start and turn/start.
      if (route.connection.kind === 'codexSubscription') {
        const login = await this.accountStatus();
        if (login.account?.type !== 'chatgpt') return { ready: false, code: 'codex_login_required', message: 'Codex 订阅账户尚未登录', activeRuns: this.activeRuns.size };
      }
      return { ready: true, connectionId: route.connection.id, connectionName: route.connection.name, connectionKind: route.connection.kind, modelId: route.model.id, toolStatus: route.model.verification.tools, activeRuns: this.activeRuns.size };
    } catch (error) {
      return { ready: false, code: error.code || 'runtime_unavailable', message: error.message, activeRuns: this.activeRuns.size };
    }
  }

  async verifyModel({ connectionId, modelId, mode = 'responses', reasoningEffort = null, candidateRoute = null, signal = null } = {}) {
    if (!['responses', 'tools'].includes(mode)) throw new Error('未知模型验证模式');
    const route = candidateRoute || await modelConfig.connectionRoute(String(connectionId || ''), String(modelId || ''));
    if (!['ok', 'manual'].includes(route.connection.discovery?.status)) {
      const error = new Error('该连接尚未完成模型发现；请先编辑/刷新连接并确认 Responses 地址');
      error.code = 'connection_discovery_required';
      throw error;
    }
    // The probe must use the same thread-level effort and transport as activation.
    route.reasoningEffort = reasoningEffort ? String(reasoningEffort) : null;
    route.fingerprint = digest({ route: route.fingerprint, effort: route.reasoningEffort });
    const runId = `connection-test-${crypto.randomUUID()}`;
    let threadId = '';
    let timer;
    let onEvent;
    let terminalReceived = false;
    let run;
    let rejectCancelled;
    const cancelled = new Promise((_, reject) => { rejectCancelled = reject; });
    cancelled.catch(() => {});
    const onAbort = () => { rejectCancelled(contractError('配置验证已取消', 'setup_cancelled')); if (threadId) this.processManager?.request('turn/interrupt', { threadId, ...(run?.turnId ? { turnId: run.turnId } : {}) }).catch(() => {}); };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      if (signal?.aborted) throw contractError('配置验证已取消', 'setup_cancelled');
      threadId = await this._startThread(route, { runId, novelId: '', includeMcp: mode === 'tools', disableAgents: mode === 'responses' });
      if (signal?.aborted) throw contractError('配置验证已取消', 'setup_cancelled');
      run = { runId, conversationId: '', threadId, turnId: '', userMessageId: '', text: '', items: [], persistence: 'one-shot', nativeFileItems: new Map(), userRejectedFileItems: new Set() };
      this.activeRuns.set(runId, run);
      const terminal = new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(contractError('Responses 模型验证超时', 'verification_timeout')), this.verificationTimeoutMs ?? 45_000);
        onEvent = (event) => {
          if (event.runId !== runId || !['turn_completed', 'turn_failed', 'turn_interrupted'].includes(event.type)) return;
          terminalReceived = true;
          clearTimeout(timer);
          if (event.type === 'turn_completed') resolve(event);
          else reject(contractError(event.error || 'Responses 工具循环连接测试失败', event.failure?.code || 'verification_failed'));
        };
        this.on('event', onEvent);
      });
      // A terminal failure can arrive before turn/start returns its acknowledgement.
      terminal.catch(() => {});
      const started = await this._startNativeTurn({
        threadId,
        input: [{ type: 'text', text: mode === 'tools' ? 'Call the connection_probe tool exactly once, then reply with its ok value.' : 'Reply with exactly: MANA_RESPONSES_OK' }],
        model: route.model.id,
        ...(route.reasoningEffort ? { effort: route.reasoningEffort } : {}),
        approvalPolicy: 'never',
      });
      run.turnId = resultId(started, 'turn');
      if (!run.turnId) throw new Error('Codex App Server 未返回测试 turnId');
      await Promise.race([terminal, cancelled]);
      if (signal?.aborted) throw contractError('配置验证已取消', 'setup_cancelled');
      if (mode === 'tools') {
        const usedProbe = run.items.some((item) => item?.type === 'mcpToolCall'
          && item.server === 'novel_tools' && item.tool === 'connection_probe'
          && item.status === 'completed' && !item.error && item.result?.isError !== true);
        if (!usedProbe) throw new Error('模型未完成要求的 Responses 工具调用');
      } else if (!run.text.trim()) throw new Error('模型未返回有效的 Responses 文本');
      if (!candidateRoute) await modelConfig.updateModelVerification({ connectionId: route.connection.id, modelId: route.model.id, mode, reasoningEffort: route.reasoningEffort, ok: true, credentialRevision: route.credentialRevision, expectedConnection: route.connection });
      return { ok: true, connectionId: route.connection.id, modelId: route.model.id, mode };
    } catch (error) {
      // A busy runtime is a host condition, not evidence that this model failed.
      if (!candidateRoute && !signal?.aborted && !['codex_turn_active', 'setup_cancelled', 'turn_interrupted'].includes(error.code)) {
        await modelConfig.updateModelVerification({ connectionId: route.connection.id, modelId: route.model.id, mode, reasoningEffort: route.reasoningEffort, ok: false, errorCode: error.code || 'verification_failed', credentialRevision: route.credentialRevision, expectedConnection: route.connection }).catch(() => {});
      }
      throw error;
    } finally {
      signal?.removeEventListener('abort', onAbort);
      clearTimeout(timer);
      if (onEvent) this.off('event', onEvent);
      if (threadId && !terminalReceived) {
        await this.processManager?.request('turn/interrupt', { threadId, ...(run?.turnId ? { turnId: run.turnId } : {}) }).catch(() => {});
      }
      this._finishRun(runId);
      if (threadId) await this.archiveThread(threadId).catch(() => {});
    }
  }

  async runOneShot({ text, skillName, outputSchema, novelId, abortSignal } = {}) {
    const route = await modelConfig.activeRoute();
    if ((skillName || novelId) && route.model.verification.tools !== 'ok') throw contractError('当前模型仅用于聊天，小说工具需验证通过后使用', 'model_tools_unavailable');
    const runId = `one-shot-${crypto.randomUUID()}`;
    const threadId = await this._startThread(route, { runId, novelId: novelId || '', includeMcp: route.model.verification.tools === 'ok' });
    const run = { runId, conversationId: '', threadId, turnId: '', userMessageId: '', text: '', items: [], persistence: 'one-shot', nativeFileItems: new Map(), userRejectedFileItems: new Set() };
    this.activeRuns.set(runId, run);
    let timer;
    let onEvent;
    let terminalReceived = false;
    const abort = () => this.interrupt({ runId }).catch(() => {});
    try {
      const input = [{ type: 'text', text: String(text || '') }];
      if (skillName) {
        const skill = await skillsStore.getSkill(skillName);
        if (!skill || skill.enabled === false) throw new Error('Skill 不存在或未启用');
        const roots = [builtinSkillRoot(), path.join(paths().root, 'codex-home', 'skills')];
        const skillPath = roots.map((rootPath) => path.join(rootPath, skillName, 'SKILL.md')).find((file) => fs.existsSync(file));
        input.push({ type: 'skill', name: skillName, path: skillPath });
      }
      if (abortSignal?.aborted) throw contractError('Codex one-shot 已取消', 'turn_interrupted');
      const terminal = new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(contractError('Codex one-shot turn 超时', 'turn_timeout')), this.oneShotTimeoutMs ?? 180_000);
        onEvent = (event) => {
          if (event.runId !== runId || !['turn_completed', 'turn_failed', 'turn_interrupted'].includes(event.type)) return;
          terminalReceived = true;
          clearTimeout(timer);
          if (event.type === 'turn_completed') resolve(); else reject(new Error(event.error || 'Codex one-shot turn 未完成'));
        };
        this.on('event', onEvent);
      });
      terminal.catch(() => {});
      const started = await this._startNativeTurn({ threadId, input, model: route.model.id, ...(route.reasoningEffort ? { effort: route.reasoningEffort } : {}), approvalPolicy: 'never', ...(outputSchema ? { outputSchema } : {}) });
      run.turnId = resultId(started, 'turn');
      if (!run.turnId) throw new Error('Codex App Server 未返回 turnId');
      abortSignal?.addEventListener?.('abort', abort, { once: true });
      if (abortSignal?.aborted) abort();
      await terminal;
      return { text: run.text, items: clone(run.items), threadId, turnId: run.turnId };
    } finally {
      clearTimeout(timer);
      if (onEvent) this.off('event', onEvent);
      abortSignal?.removeEventListener?.('abort', abort);
      if (!terminalReceived) await this.processManager?.request('turn/interrupt', { threadId, ...(run.turnId ? { turnId: run.turnId } : {}) }).catch(() => {});
      this._finishRun(runId);
      await this.archiveThread(threadId).catch(() => {});
    }
  }

  async archiveThread(threadId) {
    if (!threadId || !this.processManager) return;
    const client = await this.processManager.start();
    await client.request('thread/archive', { threadId });
    this.knownThreads.delete(threadId);
  }

  async reconcileBranchMutation(conversationId, messageId) {
    const history = await chatHistory.getThread(conversationId);
    const binding = history?.codexBinding;
    if (!binding?.threadId) return;
    const branch = chatHistory.getBranch(history);
    const boundaryIndex = branch.findIndex((message) => message.id === binding.importedBoundaryMessageId);
    const changedIndex = branch.findIndex((message) => message.id === messageId);
    if (changedIndex < 0 || (boundaryIndex >= 0 && changedIndex <= boundaryIndex)) {
      await chatHistory.updateCodexBinding(conversationId, null);
      return;
    }
    const route = await modelConfig.activeRoute();
    const client = await this._ensureProcess(route);
    await this._resumeThread(client, binding.threadId, route, { novelId: history.novelId });
    const priorTurnId = [...branch.slice(0, changedIndex)].reverse().find((message) => message.codexTurnId)?.codexTurnId;
    if (!priorTurnId) {
      await chatHistory.updateCodexBinding(conversationId, null);
      return;
    }
    const result = await client.request('thread/fork', { threadId: binding.threadId, lastTurnId: priorTurnId });
    const forkedThreadId = resultId(result, 'thread');
    if (!forkedThreadId) throw new Error('Codex App Server 未返回 fork threadId');
    this.knownThreads.add(forkedThreadId);
    await chatHistory.updateCodexBinding(conversationId, { ...binding, threadId: forkedThreadId });
  }

  _runForProtocolParams(params = {}) {
    const threadId = params.threadId || params.thread_id || params.conversationId;
    const turnId = params.turnId || params.turn_id;
    return [...this.activeRuns.values()].find((item) => (turnId && item.turnId === turnId) || (threadId && item.threadId === threadId && (!turnId || !item.turnId)));
  }

  _cacheNativePatchUpdate(message) {
    if (message?.method !== 'item/fileChange/patchUpdated') return;
    const params = message.params || {};
    const run = this._runForProtocolParams(params);
    const itemId = String(params.itemId || '');
    if (run && itemId) run.nativeFileItems.set(itemId, { ...(run.nativeFileItems.get(itemId) || {}), ...clone(params) });
  }

  async _handleServerRequest(method, params = {}, message = {}) {
    // Native tool output may reach the model before the host has committed it.
    // Finish earlier fileChange notifications before authorizing another patch.
    // Notification handling never awaits approvals, so this is not a cyclic wait.
    await this.notificationQueue;
    if (!['item/fileChange/requestApproval', 'applyPatchApproval'].includes(String(method || ''))) {
      throw contractError(`Codex App Server request is not supported: ${method}`, 'runtime_protocol_mismatch', { stage: 'approval-routing' });
    }
    const run = this._runForProtocolParams(params);
    if (!run?.workspace) throw contractError('原生补丁没有绑定小说工作区', 'tool_scope_denied', { stage: 'approval-scope' });
    const itemId = String(params.itemId || params.callId || message.id || crypto.randomUUID());
    const confirmationId = `${run.runId}:native:${itemId}`;
    const cached = run.nativeFileItems.get(itemId) || null;
    let nativeChanges;
    try { nativeChanges = validateNativeFileChanges(run.workspace.root, cached?.changes || params.fileChanges); }
    catch (error) { throw contractError(error.message, error.code || 'tool_scope_denied', { stage: 'approval-validation', itemId }); }
    const allowed = new Set(run.taskConstraints.allowedWriteResourceRefs);
    if (allowed.size) {
      const outside = nativeChanges.filter((change) => !allowed.has(change.resourceRef)).map((change) => change.resourceRef);
      if (outside.length) throw contractError(`补丁超出本次任务允许的写入范围：${outside.join('、')}`, 'task_scope_violation', { stage: 'approval-scope', itemId, outside });
    }
    let evidence;
    let nextSelectionState = run.selectionState;
    try {
      evidence = evidenceForNativeChanges(run.workspace, nativeChanges);
      for (const change of evidence) nextSelectionState = assertSelectionChange(nextSelectionState, change);
    } catch (error) {
      throw contractError(error.message, error.code || 'unverifiable_native_diff', { stage: 'approval-validation', itemId });
    }
    const fingerprint = nativeChangeFingerprint(nativeChanges);
    const currentResourceRef = evidence.find((change) => change.resourceRef.startsWith('chapter:'))?.resourceRef || run.progress?.currentResourceRef || null;
    const authorization = await getAuthorization(run.entry);
    if (authorization.granted && isAuthorizedProseAppend(evidence)) {
      run.approvedFileItems.set(itemId, {
        nativeChanges, fingerprint, evidence, nextSelectionState, authorization,
        acceptedAt: new Date().toISOString(), approvalKind: 'project-append-prose', consumed: false,
      });
      await this.ledger.record(run.runId, 'confirmation_resolved', { confirmationId, itemId, decision: 'accept', automatic: true, authorizationVersion: authorization.version });
      await this._updateProgress(run, { phase: 'tool-running', currentResourceRef });
      return { decision: 'accept' };
    }
    return new Promise((resolve) => {
      this.pendingConfirmations.set(confirmationId, { kind: 'native-file-change', run, itemId, nativeChanges, fingerprint, evidence, nextSelectionState, resolve });
      this.ledger.record(run.runId, 'confirmation_requested', { confirmationId, itemId, resources: nativeChanges.map((change) => change.resourceRef) });
      this._updateProgress(run, { phase: 'waiting-approval', currentResourceRef }).catch(() => {});
      this._emitEvent({
        type: 'confirmation_requested',
        runId: run.runId,
        conversationId: run.conversationId,
        confirmationId,
        tool: 'apply_patch',
        arguments: {
          reason: params.reason || 'Codex 原生 apply_patch 将修改受控小说镜像；确认后由宿主原子写入真实小说。',
          nativeChanges,
        },
      });
      this._checkpointRun(run.runId).catch(error => this._failAll(error));
    });
  }

  async _commitNativeWorkspace(run, itemId, completedChanges = null) {
    if (!run.workspace || !run.entry) return null;
    if (run.completedFileItems.has(itemId)) return null;
    const approval = run.approvedFileItems.get(itemId);
    if (!approval || approval.consumed) throw contractError('补丁完成事件没有对应的有效批准', 'unapproved_native_change', { stage: 'commit', itemId });
    let completedNativeChanges;
    try {
      completedNativeChanges = validateNativeFileChanges(run.workspace.root, Array.isArray(completedChanges) && completedChanges.length ? completedChanges : approval.nativeChanges);
    } catch (error) {
      throw contractError(error.message, error.code || 'approved_diff_mismatch', { stage: 'commit', itemId });
    }
    if (nativeChangeFingerprint(completedNativeChanges) !== approval.fingerprint) {
      // App Server renders approved context hunks as numbered diffs on completion.
      // Bind approval to resource, operation and exact before/after bytes, not rendering.
      const completedEvidence = evidenceForNativeChanges(run.workspace, completedNativeChanges);
      const same = completedEvidence.length === approval.evidence.length && completedEvidence.every(actual =>
        approval.evidence.some(expected => expected.resourceRef === actual.resourceRef && expected.mode === actual.mode
          && expected.beforeHash === actual.beforeHash && expected.afterHash === actual.afterHash));
      if (!same) throw contractError('补丁完成时的差异与批准内容不一致', 'approved_diff_mismatch', { stage: 'commit', itemId });
    }
    const changes = await collectNativeNovelChanges(run.workspace);
    if (!changes.length) throw contractError('已批准补丁完成后没有检测到资源差异', 'empty_native_change', { stage: 'commit', itemId });
    const approvedRefs = new Set(approval.nativeChanges.map((change) => change.resourceRef));
    const changedRefs = new Set(changes.map((change) => change.resourceRef));
    const unexpected = [...changedRefs].filter((resourceRef) => !approvedRefs.has(resourceRef));
    const missing = [...approvedRefs].filter((resourceRef) => !changedRefs.has(resourceRef));
    if (unexpected.length || missing.length) throw contractError('补丁实际差异与批准范围不一致', 'approved_diff_mismatch', { stage: 'commit', itemId, unexpected, missing });
    for (const expected of approval.evidence) {
      const actual = changes.find((change) => change.resourceRef === expected.resourceRef);
      const actualAfterHash = actual?.mode === 'delete' ? contentHash(null) : contentHash(actual?.content || '');
      const actualBeforeHash = actual?.baseHash || contentHash(null);
      if (!actual || actual.mode !== expected.mode || actualBeforeHash !== expected.beforeHash || actualAfterHash !== expected.afterHash) {
        throw contractError(`补丁实际内容与批准内容不一致：${expected.resourceRef}`, 'approved_content_mismatch', {
          stage: 'commit', itemId, resourceRef: expected.resourceRef,
          expected: { mode: expected.mode, beforeHash: expected.beforeHash, afterHash: expected.afterHash },
          actual: { mode: actual?.mode || null, beforeHash: actualBeforeHash, afterHash: actualAfterHash },
        });
      }
    }
    const commit = async () => {
      const prepared = await prepareChanges(run.entry, { reason: 'Codex 原生 apply_patch（宿主已批准 fileChange）', changes });
      return applyPrepared(run.entry, prepared);
    };
    let committed;
    try {
      committed = approval.approvalKind === 'project-append-prose'
        ? await withAuthorization(run.entry, approval.authorization, commit)
        : await commit();
    } catch (error) {
      if (error.code === 'authorization_revoked') throw contractError(error.message, error.code, { stage: 'commit', itemId });
      throw error;
    }
    // Once the transaction returns, retain its evidence even if refresh/readback fails.
    approval.consumed = true;
    run.completedFileItems.add(itemId);
    const committedStart = run.committedResources.length;
    run.committedResources.push(...committed.resources.map(resource => ({
      ...resource, mode: changes.find(change => change.resourceRef === resource.resourceRef)?.mode,
    })));
    await this._checkpointRun(run.runId);
    // Each approved native patch is a transaction. Preserve the mirror's text
    // for subsequent patch matching, but use the canonical store's new hash.
    for (const change of changes) {
      if (change.mode === 'delete') run.workspace.snapshots.delete(change.resourceRef);
      else {
        const resource = await readResource(run.entry, change.resourceRef);
        run.workspace.snapshots.set(change.resourceRef, {
          ...resource, content: change.content, relativePath: resourceRelativePath(change.resourceRef),
        });
      }
    }
    approval.consumed = true;
    run.selectionState = approval.nextSelectionState || run.selectionState;
    run.completedFileItems.add(itemId);
    const resources = [];
    for (const resource of committed.resources) {
      const change = changes.find((item) => item.resourceRef === resource.resourceRef);
      const current = change.mode === 'delete' ? null : await readResource(run.entry, resource.resourceRef);
      resources.push({
        ...resource, mode: change.mode, oldHash: change.baseHash || null, newHash: current?.sourceHash || null,
        chineseCharacterCount: current ? chineseCharacterCount(current.content) : 0,
        bodyChineseCharacterCount: current ? bodyChineseCharacterCount(current.content) : 0,
      });
    }
    run.committedResources.splice(committedStart, committed.resources.length, ...resources);
    const invalidatedReviewIssues = await invalidateForResources(run.entry, resources);
    await this.ledger.record(run.runId, 'commit_completed', { itemId, resources });
    if (run.progress) {
      const totalSavedBodyCjk = await novelBodyCjk(run.entry);
      await this._updateProgress(run, {
        phase: 'waiting-model',
        currentResourceRef: resources.find((resource) => resource.resourceRef.startsWith('chapter:'))?.resourceRef || run.progress.currentResourceRef,
        totalSavedBodyCjk,
        runNetBodyCjk: totalSavedBodyCjk - run.progress.initialTotalBodyCjk,
        lastSavedAt: new Date().toISOString(),
      });
    }
    return { ...committed, resources, invalidatedReviewIssues };
  }

  async _onNotification(message) {
    const params = message?.params || {};
    if (['account/login/completed', 'account/updated', 'account/rateLimits/updated'].includes(String(message?.method || ''))) {
      this._emitEvent({ type: String(message.method).replaceAll('/', '_'), account: clone(params) });
      return;
    }
    const threadId = params.threadId || params.thread_id || params.thread?.id;
    const turnId = params.turnId || params.turn_id || params.turn?.id;
    const run = [...this.activeRuns.values()].find((item) => (turnId && item.turnId === turnId) || (threadId && item.threadId === threadId && (!turnId || !item.turnId)));
    if (!run) return;
    if (message?.method === 'item/fileChange/patchUpdated') {
      this._cacheNativePatchUpdate(message);
    }
    if (message?.method === 'item/started' && params.item?.type === 'fileChange' && params.item?.id) {
      run.nativeFileItems.set(String(params.item.id), clone(params.item));
    }
    let event = projectNotification(message, run);
    if (!event) return;
    if (event.type === 'turn_started') await this._updateProgress(run, { phase: 'waiting-model' });
    if (event.type === 'text_delta') {
      run.text += event.delta;
      await this.ledger.record(run.runId, 'text_delta', { delta: event.delta });
    }
    if (event.type === 'item_completed' && event.item?.status === 'declined') {
      const itemId = String(event.item?.id || '');
      event = { ...event, item: { ...event.item, status: run.interruptionRequested ? 'interrupted' : run.userRejectedFileItems.has(itemId) ? 'user_rejected' : 'declined' } };
    }
    if (event.type === 'item_started' || event.type === 'item_completed') {
      run.items = [...run.items.filter(item => item?.id !== event.item?.id), event.item];
      const itemId = String(event.item?.id || '');
      const itemType = event.item?.type || null;
      const isTool = /(?:tool|filechange|commandexecution)/iu.test(String(itemType || ''));
      const toolName = String(event.item?.tool || event.item?.name || '');
      const progressArgs = /report_writing_progress/u.test(toolName) ? itemArguments(event.item) : null;
      if (progressArgs?.chapterResourceRef) {
        await this._updateProgress(run, { phase: event.type === 'item_started' ? 'tool-running' : 'waiting-model', currentResourceRef: String(progressArgs.chapterResourceRef) });
      } else if (event.type === 'item_started') {
        await this._updateProgress(run, { phase: isTool ? 'tool-running' : String(itemType) === 'reasoning' ? 'reasoning' : 'waiting-model' });
      }
      await this.ledger.record(run.runId,
        isTool ? (event.type === 'item_started' ? 'tool_started' : 'tool_completed') : (event.type === 'item_started' ? 'native_item_started' : 'native_item_completed'),
        { itemId, itemType, ok: event.item?.status !== 'failed', output: event.type === 'item_completed' ? clone(event.item?.output || event.item?.result || null) : undefined });
    }
    if (event.type === 'item_completed' && event.item?.status === 'failed') {
      const failure = { code: 'tool_execution_failed', message: event.item?.error?.message || `${event.item?.type || '工具'}执行失败`, stage: 'tool', itemId: event.item?.id || null, savedResources: run.committedResources };
      await this.processManager?.request('turn/interrupt', { threadId: run.threadId, turnId: run.turnId }).catch(() => {});
      event = { ...event, type: 'turn_failed', error: failure.message, failure };
    }
    if (event.type === 'item_completed' && event.item?.type === 'fileChange' && event.item.status === 'completed') {
      try {
        const committed = await this._commitNativeWorkspace(run, String(event.item.id || ''), event.item.changes);
        if (committed) event = { ...event, novelId: run.entry.id, committedResources: committed.resources, invalidatedReviewIssues: committed.invalidatedReviewIssues };
      }
      catch (error) {
        if (this.processManager) await this.interrupt({ runId: run.runId }).catch(() => {});
        const failure = { code: error.code || 'commit_failed', message: error.message || String(error), stage: error.details?.stage || 'commit', details: error.details || null, savedResources: run.committedResources };
        event = { ...event, type: 'turn_failed', error: failure.message, failure };
      }
    }
    if (['turn_completed', 'turn_failed', 'turn_interrupted'].includes(event.type)) {
      if (event.type === 'turn_completed' && run.skillName === 'mana-consistency-review' && run.entry) {
        event = { ...event, reviewRecord: await recordReview(run.entry, run) };
      }
      await this._finalizeRun(run, event);
    } else {
      this._emitEvent(event);
      if (event.type === 'text_delta') this._scheduleCheckpoint(run.runId);
      else await this._checkpointRun(run.runId);
    }
  }

  async _evaluateTaskResult(run, modelTurnCompleted) {
    const result = {
      modelTurnCompleted,
      goalVerified: false,
      constraints: run.taskConstraints,
      savedResources: run.committedResources,
      contentReview: {
        ending: { status: 'not_evaluated' },
        plotProgression: { status: 'not_evaluated' },
        characterConsistency: { status: 'not_evaluated' },
      },
    };
    if (!modelTurnCompleted || !run.entry) return result;
    let refs = run.taskConstraints.targetResourceRefs;
    if (!refs.length && (run.taskConstraints.minBodyCjk != null || run.taskConstraints.maxBodyCjk != null)) {
      refs = (await listResourceDescriptors(run.entry)).filter((item) => item.kind === 'chapter').map((item) => item.resourceRef);
    }
    if (refs.length) {
      const resources = await Promise.all(refs.map((resourceRef) => readResource(run.entry, resourceRef).catch(() => null)));
      const bodyCjk = resources.filter(Boolean).reduce((sum, resource) => sum + bodyChineseCharacterCount(resource.content), 0);
      const readable = resources.filter(Boolean);
      result.evidence = { targetResourceRefs: refs, readableResources: readable.length, bodyChineseCharacterCount: bodyCjk, hashes: readable.map((resource) => ({ resourceRef: resource.resourceRef, hash: resource.sourceHash })) };
      const hasWordTarget = run.taskConstraints.minBodyCjk != null || run.taskConstraints.maxBodyCjk != null;
      const wordStatus = run.taskConstraints.minBodyCjk != null && bodyCjk < run.taskConstraints.minBodyCjk
        ? 'in_progress'
        : run.taskConstraints.maxBodyCjk != null && bodyCjk > run.taskConstraints.maxBodyCjk
          ? 'over_target'
          : hasWordTarget ? 'met' : 'not_requested';
      result.checks = {
        wordCount: { status: wordStatus, blocking: false, actual: bodyCjk, minimum: run.taskConstraints.minBodyCjk, maximum: run.taskConstraints.maxBodyCjk, belowBy: Math.max(0, (run.taskConstraints.minBodyCjk ?? bodyCjk) - bodyCjk), aboveBy: Math.max(0, bodyCjk - (run.taskConstraints.maxBodyCjk ?? bodyCjk)) },
      };
      if (run.taskConstraints.prohibitRepetition) {
        const repetition = proseRepetitionEvidence(readable.map((resource) => ({ resourceRef: resource.resourceRef, hash: resource.sourceHash, content: resource.content })));
        result.evidence.repetition = repetition;
        result.checks.repetition = { status: 'evidence_only', qualityConclusion: 'not_evaluated', actual: repetition.repeatedOccurrenceRatio };
      }
      if (run.taskConstraints.requiresCompleteEnding) result.contentReview.ending = { status: 'required_not_evaluated', reason: '需要独立内容审查证据' };
      const contentRequirementsMet = !run.taskConstraints.requiresCompleteEnding;
      const mutationSatisfied = !['write', 'edit'].includes(run.taskConstraints.operation) || run.committedResources.length > 0;
      result.goalVerified = readable.length === refs.length && contentRequirementsMet && mutationSatisfied;
    } else if (run.taskConstraints.operation !== 'unspecified') {
      result.goalVerified = run.committedResources.length > 0 || ['review', 'roleplay', 'read'].includes(run.taskConstraints.operation);
    }
    return result;
  }

  _finishRun(runId) {
    const run = this.activeRuns.get(runId);
    if (!run) return;
    this.activeRuns.delete(runId);
    for (const [confirmationId, pending] of this.pendingConfirmations) {
      if (!confirmationId.startsWith(`${runId}:`)) continue;
      this.pendingConfirmations.delete(confirmationId);
      pending.resolve?.({ decision: 'cancel' });
    }
    if (run.conversationId && this.threadRuns.get(run.conversationId) === runId) this.threadRuns.delete(run.conversationId);
    clearTimeout(this.checkpointTimers.get(runId));
    this.checkpointTimers.delete(runId);
    if (run.entry && this.projectRuns.get(String(run.entry.id)) === runId) this.projectRuns.delete(String(run.entry.id));
  }

  async _failAll(error) {
    for (const run of [...this.activeRuns.values()]) {
      const failure = { code: error?.code || 'runtime_interrupted', message: error?.message || 'Codex App Server stopped', stage: 'runtime', savedResources: run.committedResources || [] };
      await this._finalizeRun(run, { type: 'turn_failed', runId: run.runId, conversationId: run.conversationId, error: failure.message, failure });
    }
  }

  async dispose() {
    await this._failAll(new Error('应用运行时已停止'));
    await this.processManager?.stop();
    await this.providerBridge?.close();
    this.processManager = null;
    this.providerBridge = null;
  }
}

Object.assign(CodexSessionService.prototype, require('./chatRunLifecycle'));

module.exports = { BUILTIN_SKILLS, CodexSessionService, additionalContext, inputItem, modelCatalogForRoute, projectNotification, validateNativeFileChanges };
