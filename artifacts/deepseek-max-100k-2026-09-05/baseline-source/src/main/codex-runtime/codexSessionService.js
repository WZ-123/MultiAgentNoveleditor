'use strict';

const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');
const modelConfig = require('../modelConfig');
const { templateById } = require('../modelConfig/providerTemplates');
const chatHistory = require('../store/chatHistory');
const skillsStore = require('../store/skills');
const novels = require('../store/novels');
const { paths } = require('../store/paths');
const { readResource } = require('../mcp/novelResources');
const { applyPrepared, prepareChanges } = require('../mcp/mutationService');
const { CodexProcessManager } = require('./processManager');
const { createDeepSeekNoReasoningBridge } = require('./deepseekNoReasoningBridge');
const { collectNativeNovelChanges, resourceRefFromRelativePath, resourceRelativePath, syncNativeNovelWorkspace } = require('./nativeNovelWorkspace');
const { developmentCacheRoot } = require('./runtimeManifest');

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
  return {
    novelId: { kind: 'application', value: String(payload.novelId || '') },
    resourceRef: { kind: 'application', value: String(editorSnapshot.resourceRef || '') },
    baseHash: { kind: 'application', value: String(editorSnapshot.baseHash || '') },
    selection: { kind: 'application', value: JSON.stringify(editorSnapshot.selection || null) },
    nativeWorkspace: { kind: 'application', value: String(workspaceRoot || '') },
    resourcePath: { kind: 'application', value: editorSnapshot.resourceRef ? resourceRelativePath(editorSnapshot.resourceRef) : '' },
  };
}
function modelCatalogForRoute(route) {
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
    supports_image_detail_original: false,
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
    if (status !== 'completed') return { ...base, type: 'turn_failed', error: params.turn?.error?.message || params.error?.message || 'Codex turn failed' };
    return { ...base, type: 'turn_completed' };
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
    this.pendingConfirmations = new Map();
    this.knownThreads = new Set();
  }

  async _ensureProcess(route) {
    if (this.processManager && this.routeFingerprint === route.fingerprint) return this.processManager.start();
    if (this.processManager && this.activeRuns.size > 0) {
      const error = new Error('当前仍有 Codex turn 在运行，完成或取消后才能切换模型连接');
      error.code = 'codex_turn_active';
      throw error;
    }
    if (this.processManager) await this.processManager.stop();
    if (this.providerBridge) await this.providerBridge.close();
    this.providerBridge = null;
    if (route.connection.templateId === 'deepseek' && route.reasoningEffort === 'none') {
      this.providerBridge = await createDeepSeekNoReasoningBridge(route.connection.baseUrl);
    }
    this.processManager = new CodexProcessManager({
      runtimeRoot: app?.isPackaged ? null : path.join(developmentCacheRoot(), 'staging'),
      extraEnv: { MANA_CODEX_API_KEY: route.apiKey },
      modelCatalog: modelCatalogForRoute(route),
      requestHandler: (method, params, message) => this._handleServerRequest(method, params, message),
    });
    this.routeFingerprint = route.fingerprint;
    this.knownThreads.clear();
    this.processManager.on('notification', (message) => this._onNotification(message));
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
    return {
      model_provider: 'mana_responses',
      model_providers: {
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
      },
      ...(route.reasoningEffort ? { model_reasoning_effort: route.reasoningEffort } : {}),
      ...(route.model.capabilities?.contextWindow ? { model_context_window: route.model.capabilities.contextWindow } : {}),
      ...(disableAgents ? { agents: { enabled: false }, features: { multi_agent: false, multi_agent_v2: false } } : {}),
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
      modelProvider: 'mana_responses',
      cwd: payload.workspaceRoot || this.processManager.runDirectory,
      approvalPolicy: payload.workspaceRoot ? 'on-request' : 'never',
      sandbox: 'read-only',
      ephemeral: false,
      allowProviderModelFallback: false,
      baseInstructions: includeMcp
        ? '你是小说创作工作台中的 Codex。自行理解需求、管理上下文、使用显式提供的 Skill，并在适合时使用原生 subagent。小说 MCP server 标识是 novel_tools；直接调用它提供的 list_novel_resources、read_novel_resource 等命名工具，不得用通用 list_mcp_resources、list_mcp_resource_templates 或 read_mcp_resource 探测 server、读取 Skill 或代替小说工具。每类资源最多列举一次，已知 resourceRef 时直接读取，独立读取应在同一轮并行发起；不得读取与当前任务无关或已知为空的资源。只通过 novel_tools 读取小说资料；不得使用 shell、插件或网页工具。修改小说时只使用 Codex 原生 apply_patch 编辑 nativeWorkspace 中的映射文件；nativeWorkspace 本身就是补丁根目录，补丁路径必须是映射相对路径（如 chapters/chapter-001.md），绝不添加 novel/、nativeWorkspace 名或绝对路径前缀。等待用户批准原生 fileChange；不得调用自定义写入工具，也不得声称批准前已写入真实小说。'
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
      modelProvider: 'mana_responses',
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
    const bindingFingerprint = `${route.fingerprint}:${toolMode}`;
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

  async startTurn(payload) {
    const runId = String(payload?.runId || `run-${crypto.randomUUID()}`);
    const conversationId = String(payload?.conversationId || '');
    const text = String(payload?.text || '').trim();
    if (!text) throw new Error('消息不能为空');
    if (this.activeRuns.has(runId)) throw new Error('runId 已在执行');
    if (conversationId && this.threadRuns.has(conversationId)) throw new Error('该对话已有进行中的 Codex turn');
    const route = await modelConfig.activeRoute();
    const editorInput = payload.editorContext && typeof payload.editorContext === 'object' ? payload.editorContext : {};
    const novelToolTask = !!payload.skillName || !!editorInput.resourceRef || !!editorInput.chapterFileName;
    if (novelToolTask && route.model.verification.tools === 'failed') {
      const error = new Error('当前模型已知不支持小说工具调用。普通文本聊天仍可使用，请切换到工具验证通过的模型后再读取或修改小说资料。');
      error.code = 'model_tools_unavailable';
      throw error;
    }
    const history = payload.persistence === 'chat' ? await chatHistory.getThread(conversationId) : null;
    if (payload.persistence === 'chat' && !history) throw new Error('聊天记录不存在');
    const entry = payload.novelId ? await novels.getNovelById(payload.novelId) : null;
    if (payload.novelId && !entry) throw new Error('小说项目不存在');
    if (entry && novelToolTask) await this._ensureProcess(route);
    const workspace = entry && novelToolTask
      ? await syncNativeNovelWorkspace(entry, this.processManager.workspacesDirectory)
      : null;
    const threadId = await this._bindConversation(route, { ...payload, runId, conversationId, workspaceRoot: workspace?.root || '', includeMcp: novelToolTask }, history);
    const resourceRef = String(editorInput.resourceRef || (editorInput.chapterFileName ? `chapter:${editorInput.chapterFileName}` : ''));
    let baseHash = '';
    if (payload.novelId && resourceRef) {
      baseHash = (await readResource(entry, resourceRef)).sourceHash;
    }
    const start = Number(editorInput.selectionStart);
    const end = Number(editorInput.selectionEnd);
    const editor = {
      resourceRef,
      baseHash,
      selection: Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end >= start ? { start, end } : null,
    };
    const run = {
      runId, conversationId, threadId, turnId: '', userMessageId: String(payload.userMessageId || ''), text: '', items: [],
      persistence: payload.persistence || 'chat', entry, workspace, nativeApprovalsAccepted: 0, nativeFileItems: new Map(),
    };
    this.activeRuns.set(runId, run);
    if (conversationId) this.threadRuns.set(conversationId, runId);
    const input = [{ type: 'text', text }];
    if (payload.skillName) {
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
      return { runId, conversationId, threadId, turnId: run.turnId };
    } catch (error) {
      this._finishRun(runId);
      throw error;
    }
  }

  async interrupt({ runId }) {
    const run = this.activeRuns.get(String(runId));
    if (!run) return { interrupted: false };
    await this.processManager.request('turn/interrupt', { threadId: run.threadId, turnId: run.turnId });
    return { interrupted: true };
  }

  async prepareModelSwitch({ interruptActive = false } = {}) {
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
        this.emit('event', { type: 'turn_interrupted', runId: run.runId, conversationId: run.conversationId, error: '已取消当前任务以切换模型' });
        this._finishRun(run.runId);
      }
      await this.processManager?.stop();
      await this.providerBridge?.close();
      this.processManager = null;
      this.providerBridge = null;
      this.routeFingerprint = '';
    }
    return { interruptedRuns: runs.length };
  }

  async resolveConfirmation({ confirmationId, accept, reason }) {
    const key = String(confirmationId || '');
    const pending = this.pendingConfirmations.get(key);
    if (!pending) throw new Error('确认请求已失效');
    if (pending.kind !== 'native-file-change') throw new Error('确认请求已失效');
    this.pendingConfirmations.delete(key);
    if (accept) pending.run.nativeApprovalsAccepted += 1;
    pending.resolve({ decision: accept ? 'accept' : 'decline', ...(reason ? { reason: String(reason) } : {}) });
    return { resolved: true };
  }

  async status() {
    try {
      const route = await modelConfig.activeRoute();
      await this._ensureProcess(route);
      return { ready: true, connectionId: route.connection.id, connectionName: route.connection.name, modelId: route.model.id, toolStatus: route.model.verification.tools, activeRuns: this.activeRuns.size };
    } catch (error) {
      return { ready: false, code: error.code || 'runtime_unavailable', message: error.message, activeRuns: this.activeRuns.size };
    }
  }

  async verifyModel({ connectionId, modelId, mode = 'responses', reasoningEffort = null } = {}) {
    if (!['responses', 'tools'].includes(mode)) throw new Error('未知模型验证模式');
    const route = await modelConfig.connectionRoute(String(connectionId || ''), String(modelId || ''));
    if (route.connection.discovery?.status !== 'ok') {
      const error = new Error('该连接尚未完成模型发现；请先编辑/刷新连接并确认 Responses 地址');
      error.code = 'connection_discovery_required';
      throw error;
    }
    const runId = `connection-test-${crypto.randomUUID()}`;
    const threadId = await this._startThread(route, { runId, novelId: '', includeMcp: mode === 'tools', disableAgents: mode === 'responses' });
    const run = { runId, conversationId: '', threadId, turnId: '', userMessageId: '', text: '', items: [], persistence: 'one-shot' };
    this.activeRuns.set(runId, run);
    const terminal = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Responses 模型验证超时')), 45_000);
      const onEvent = (event) => {
        if (event.runId !== runId || !['turn_completed', 'turn_failed', 'turn_interrupted'].includes(event.type)) return;
        clearTimeout(timeout);
        this.off('event', onEvent);
        if (event.type === 'turn_completed') resolve(event);
        else reject(new Error(event.error || 'Responses 工具循环连接测试失败'));
      };
      this.on('event', onEvent);
    });
    const started = await this._startNativeTurn({
      threadId,
      input: [{ type: 'text', text: mode === 'tools' ? 'Call the connection_probe tool exactly once, then reply with its ok value.' : 'Reply with exactly: MANA_RESPONSES_OK' }],
      model: route.model.id,
      ...(reasoningEffort ? { effort: String(reasoningEffort) } : {}),
      approvalPolicy: 'never',
    });
    run.turnId = resultId(started, 'turn');
    if (!run.turnId) throw new Error('Codex App Server 未返回测试 turnId');
    try {
      await terminal;
      if (mode === 'tools') {
        const usedProbe = run.items.some((item) => JSON.stringify(item || {}).includes('connection_probe'));
        if (!usedProbe) throw new Error('模型未完成要求的 Responses 工具调用');
      } else if (!run.text.trim()) throw new Error('模型未返回有效的 Responses 文本');
      await modelConfig.updateModelVerification({ connectionId: route.connection.id, modelId: route.model.id, mode, reasoningEffort, ok: true, credentialRevision: route.credentialRevision });
      return { ok: true, connectionId: route.connection.id, modelId: route.model.id, mode };
    } catch (error) {
      await modelConfig.updateModelVerification({ connectionId: route.connection.id, modelId: route.model.id, mode, reasoningEffort, ok: false, errorCode: error.code || 'verification_failed', credentialRevision: route.credentialRevision }).catch(() => {});
      throw error;
    } finally {
      await this.archiveThread(threadId).catch(() => {});
    }
  }

  async runOneShot({ text, skillName, outputSchema, novelId, abortSignal } = {}) {
    const route = await modelConfig.activeRoute();
    const runId = `one-shot-${crypto.randomUUID()}`;
    const threadId = await this._startThread(route, { runId, novelId: novelId || '' });
    const run = { runId, conversationId: '', threadId, turnId: '', userMessageId: '', text: '', items: [], persistence: 'one-shot' };
    this.activeRuns.set(runId, run);
    const terminal = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Codex one-shot turn 超时')), 180_000);
      const onEvent = (event) => {
        if (event.runId !== runId || !['turn_completed', 'turn_failed', 'turn_interrupted'].includes(event.type)) return;
        clearTimeout(timeout); this.off('event', onEvent);
        if (event.type === 'turn_completed') resolve(); else reject(new Error(event.error || 'Codex one-shot turn 未完成'));
      };
      this.on('event', onEvent);
    });
    const input = [{ type: 'text', text: String(text || '') }];
    if (skillName) {
      const skill = await skillsStore.getSkill(skillName);
      if (!skill || skill.enabled === false) throw new Error('Skill 不存在或未启用');
      const roots = [builtinSkillRoot(), path.join(paths().root, 'codex-home', 'skills')];
      const skillPath = roots.map((rootPath) => path.join(rootPath, skillName, 'SKILL.md')).find((file) => fs.existsSync(file));
      input.push({ type: 'skill', name: skillName, path: skillPath });
    }
    const started = await this._startNativeTurn({ threadId, input, model: route.model.id, ...(route.reasoningEffort ? { effort: route.reasoningEffort } : {}), approvalPolicy: 'never', ...(outputSchema ? { outputSchema } : {}) });
    run.turnId = resultId(started, 'turn');
    const abort = () => this.interrupt({ runId }).catch(() => {});
    abortSignal?.addEventListener?.('abort', abort, { once: true });
    try { await terminal; return { text: run.text, items: clone(run.items), threadId, turnId: run.turnId }; }
    finally { abortSignal?.removeEventListener?.('abort', abort); await this.archiveThread(threadId).catch(() => {}); }
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
    return [...this.activeRuns.values()].find((item) => (turnId && item.turnId === turnId) || (threadId && item.threadId === threadId));
  }

  _handleServerRequest(method, params = {}, message = {}) {
    if (!['item/fileChange/requestApproval', 'applyPatchApproval'].includes(String(method || ''))) {
      return { decision: 'decline' };
    }
    const run = this._runForProtocolParams(params);
    if (!run?.workspace) return { decision: 'decline' };
    const itemId = String(params.itemId || params.callId || message.id || crypto.randomUUID());
    const confirmationId = `${run.runId}:native:${itemId}`;
    const cached = run.nativeFileItems.get(itemId) || null;
    let nativeChanges;
    try { nativeChanges = validateNativeFileChanges(run.workspace.root, cached?.changes || params.fileChanges); }
    catch { return { decision: 'decline' }; }
    return new Promise((resolve) => {
      this.pendingConfirmations.set(confirmationId, { kind: 'native-file-change', run, itemId, resolve });
      this.emit('event', {
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
    });
  }

  async _commitNativeWorkspace(run) {
    if (!run.workspace || !run.entry) return null;
    const changes = await collectNativeNovelChanges(run.workspace);
    if (!changes.length) return null;
    if (run.nativeApprovalsAccepted < 1) throw new Error('检测到未经原生 fileChange 批准的小说镜像修改');
    const prepared = await prepareChanges(run.entry, { reason: 'Codex 原生 apply_patch（用户已批准 fileChange）', changes });
    return applyPrepared(run.entry, prepared);
  }

  async _onNotification(message) {
    const params = message?.params || {};
    const threadId = params.threadId || params.thread_id || params.thread?.id;
    const turnId = params.turnId || params.turn_id || params.turn?.id;
    const run = [...this.activeRuns.values()].find((item) => (turnId && item.turnId === turnId) || (threadId && item.threadId === threadId));
    if (!run) return;
    if (message?.method === 'item/fileChange/patchUpdated') {
      const itemId = String(params.itemId || '');
      if (itemId) run.nativeFileItems.set(itemId, { ...(run.nativeFileItems.get(itemId) || {}), ...clone(params) });
    }
    if (message?.method === 'item/started' && params.item?.type === 'fileChange' && params.item?.id) {
      run.nativeFileItems.set(String(params.item.id), clone(params.item));
    }
    let event = projectNotification(message, run);
    if (!event) return;
    if (event.type === 'text_delta') run.text += event.delta;
    if (event.type === 'item_started' || event.type === 'item_completed') run.items.push(event.item);
    if (event.type === 'turn_completed') {
      try { await this._commitNativeWorkspace(run); }
      catch (error) { event = { ...event, type: 'turn_failed', error: error.message || String(error) }; }
    }
    if (event.type === 'turn_completed' && run.persistence === 'chat' && run.conversationId) {
      const assistant = {
        id: `codex-${run.turnId}`,
        parentId: run.userMessageId || null,
        role: 'assistant',
        text: run.text,
        timestamp: Date.now(),
        edited: false,
        toolCalls: run.items.filter((item) => /tool|mcp/iu.test(String(item?.type || ''))),
        codexTurnId: run.turnId,
      };
      await chatHistory.ensureRuntimeMessage(run.conversationId, assistant, run.userMessageId);
    }
    this.emit('event', event);
    if (['turn_completed', 'turn_failed', 'turn_interrupted'].includes(event.type)) this._finishRun(run.runId);
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
    if (run.conversationId) this.threadRuns.delete(run.conversationId);
  }

  _failAll(error) {
    for (const run of this.activeRuns.values()) this.emit('event', { type: 'turn_failed', runId: run.runId, conversationId: run.conversationId, error: error?.message || 'Codex App Server stopped' });
    this.activeRuns.clear();
    this.threadRuns.clear();
    this.pendingConfirmations.clear();
  }

  async dispose() {
    await this.processManager?.stop();
    await this.providerBridge?.close();
    this.processManager = null;
    this.providerBridge = null;
  }
}

module.exports = { BUILTIN_SKILLS, CodexSessionService, additionalContext, inputItem, modelCatalogForRoute, projectNotification, validateNativeFileChanges };
