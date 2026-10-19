'use strict';

// Focused service regression tests, runnable even in the audit's partial checkout.
// Load the REAL CodexSessionService and chatRunLifecycle implementation. Only the
// missing Electron/store/domain modules and the App Server transport are stubbed
// with Module._load. No service/lifecycle method or implementation is copied.
// Native-diff authorization/evidence functions return fixed valid fixtures; these
// tests target cancellation ordering, not the separately tested policy itself.
// These tests do not claim real sidecar, filesystem-store, provider, or UI coverage.
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const Module = require('node:module');
const path = require('node:path');
const { test } = require('node:test');

const serviceFile = path.resolve(process.cwd(), 'src/main/codex-runtime/codexSessionService.js');
const lifecycleFile = path.resolve(process.cwd(), 'src/main/codex-runtime/chatRunLifecycle.js');
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
const route = {
  connection: { id: 'subscription', kind: 'codexSubscription', templateId: 'codex-subscription', name: 'Test' },
  model: { id: 'test-model', capabilities: {} },
  fingerprint: 'test-route', modelProvider: 'openai',
};

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function harness() {
  const h = { calls: [], trace: [], hooks: {}, managers: [], clients: [], responses: [], savedRecords: [], savedMessages: [] };
  h.count = stage => h.calls.filter(call => call.stage === stage).length;
  h.touch = async (stage, payload) => {
    h.calls.push({ stage, payload: clone(payload) });
    h.trace.push(`${stage}:start`);
    await h.hooks[stage]?.(payload);
    h.trace.push(`${stage}:done`);
  };
  h.failOnce = stage => {
    let failed = false;
    h.hooks[stage] = async () => {
      if (!failed) { failed = true; throw new Error(`injected ${stage} failure`); }
    };
  };
  h.pauseOnce = stage => {
    const entered = deferred();
    const release = deferred();
    let paused = false;
    h.hooks[stage] = async () => {
      if (paused) return;
      paused = true;
      entered.resolve();
      await release.promise;
    };
    return { entered: entered.promise, release: release.resolve };
  };
  class Client {
    constructor() {
      this.closed = false;
      this.calls = [];
      this.skills = [{ name: 'mana-fiction-writing', enabled: false }, { name: 'unmanaged-skill', enabled: true }];
      h.clients.push(this);
    }
    async request(method, params) {
      this.calls.push({ method, params: clone(params) });
      await h.touch(`rpc:${method}`, params);
      if (method === 'skills/list') return { data: [{ skills: clone(this.skills) }] };
      if (method === 'skills/config/write') this.skills.find(skill => skill.name === params.name).enabled = params.enabled;
      if (method === 'thread/start') return { thread: { id: 'persisted-thread' } };
      return {};
    }
    count(method) { return this.calls.filter(call => call.method === method).length; }
  }
  class ProcessManager extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.client = new Client();
      this.runDirectory = '/test-runtime/readonly-cwd';
      this.startCalls = 0;
      h.managers.push(this);
    }
    async start() { this.startCalls++; return this.client; }
    async stop() { this.client.closed = true; }
    async request(method, params) { return this.client.request(method, params); }
    replaceClient() { this.client.closed = true; this.client = new Client(); return this.client; }
  }
  class TaskLedger {
    async record(runId, type, data) { await h.touch('ledger', { runId, type, data }); }
    async finish(runId, status, data) { await h.touch('ledger-finish', { runId, status, data }); }
  }
  const unexpected = name => () => { throw new Error(`Unexpected out-of-scope dependency: ${name}`); };
  const stubs = {
    electron: { app: { isPackaged: false } },
    '../modelConfig': {},
    '../modelConfig/providerTemplates': { templateById: unexpected('templateById') },
    '../store/chatHistory': {
      setBranchMutationGuard() {},
      getBranch(history) { h.calls.push({ stage: 'history-branch' }); return history.messages || []; },
      async updateCodexBinding(...args) { await h.touch('history-binding', args); },
      async saveRunMessage(conversationId, message) {
        await h.touch('history-checkpoint', { conversationId, message });
        h.savedMessages.push(clone(message));
      },
    },
    '../store/chatRuns': {
      async save(record) { await h.touch('checkpoint', record); h.savedRecords.push(clone(record)); },
    },
    '../store/skills': {
      async listSkills() { await h.touch('skill-store'); return [{ name: 'mana-fiction-writing', enabled: true }]; },
    },
    '../store/novels': { getNovelById: unexpected('getNovelById') },
    '../store/paths': { paths: () => ({ root: '/test-user-data' }) },
    '../mcp/novelResources': {},
    '../mcp/mutationService': {},
    './processManager': { CodexProcessManager: ProcessManager },
    './deepseekNoReasoningBridge': { createDeepSeekNoReasoningBridge: unexpected('createDeepSeekNoReasoningBridge') },
    './nativeNovelWorkspace': {
      resourceRefFromRelativePath(relative) {
        assert.equal(relative, 'chapters/chapter-001.md');
        return 'chapter:001';
      },
    },
    './runtimeManifest': { developmentCacheRoot: () => '/test-runtime-cache' },
    './taskLedger': { TaskLedger, normalizeTaskConstraints: value => value || {} },
    './taskCompletion': { evaluateTaskResult: async () => ({ execution: {}, goalStatus: 'unverified' }) },
    './taskContinuation': {},
    './reviewLedger': {},
    './writingAuthorization': {
      async getAuthorization(entry) { await h.touch('authorization', entry); return h.authorization || { granted: false, version: 1 }; },
    },
    './writingProgress': { async saveProgress(progress) { await h.touch('progress', progress); } },
    './nativeChangePolicy': {
      evidenceForNativeChanges: () => [{ resourceRef: 'chapter:001', sourceHash: 'before', nextHash: 'after' }],
      assertSelectionChange: selection => selection,
      nativeChangeFingerprint: () => 'fixture-native-fingerprint',
      isAuthorizedProseAppend: () => true,
    },
  };
  // The override exists only while requiring these two source modules. Node core
  // modules and the real lifecycle mixin still load normally. Unknown imports
  // are not silently mocked, so a dependency change cannot hide a load failure.
  const originalLoad = Module._load;
  delete require.cache[serviceFile];
  delete require.cache[lifecycleFile];
  Module._load = function load(request, parent, isMain) {
    if ([serviceFile, lifecycleFile].includes(parent?.filename) && Object.hasOwn(stubs, request)) return stubs[request];
    return originalLoad.call(this, request, parent, isMain);
  };
  try { h.Service = require(serviceFile).CodexSessionService; }
  finally { Module._load = originalLoad; }
  h.service = new h.Service();
  return h;
}

function pendingApproval(h) {
  const run = {
    runId: 'run-1', conversationId: 'conversation-1', threadId: 'thread-1', turnId: 'turn-1',
    entry: { id: 'novel-1' }, progress: { startedAtMs: Date.now(), phase: 'waiting-approval' },
    approvedFileItems: new Map(), userRejectedFileItems: new Set(), committedResources: [], items: [],
  };
  const pending = {
    kind: 'native-file-change', run, itemId: 'item-1',
    nativeChanges: [{ resourceRef: 'chapter:001' }], fingerprint: 'patch-fingerprint',
    evidence: { sourceHash: 'before', nextHash: 'after' }, nextSelectionState: { baseHash: 'after' },
    resolve(answer) { h.responses.push(answer); h.trace.push(`response:${answer.decision}`); },
  };
  h.service.activeRuns.set(run.runId, run);
  h.service.pendingConfirmations.set('confirmation-1', pending);
  h.service.runRecords.set(run.runId, {
    runId: run.runId, conversationId: run.conversationId, novelId: run.entry.id,
    status: 'waiting-approval', confirmation: { confirmationId: 'confirmation-1' }, version: 1,
    persistence: 'chat', messageStored: true, userMessageId: 'user-1', startedAt: new Date().toISOString(),
  });
  return { run, pending, answer: { confirmationId: 'confirmation-1', runId: run.runId, accept: true } };
}

function assertUnanswered(h, run, pending) {
  assert.equal(h.service.pendingConfirmations.get('confirmation-1'), pending);
  assert.equal(run.approvedFileItems.size, 0);
  assert.equal(run.userRejectedFileItems.size, 0);
  assert.deepEqual(h.responses, []);
}

function assertBootstrap(client) {
  assert.equal(client.count('skills/extraRoots/set'), 1);
  assert.equal(client.count('skills/list'), 2);
  assert.equal(client.count('skills/config/write'), 2);
  assert.deepEqual(client.skills, [{ name: 'mana-fiction-writing', enabled: true }, { name: 'unmanaged-skill', enabled: false }]);
  const roots = client.calls.find(call => call.method === 'skills/extraRoots/set').params.extraRoots;
  assert.match(roots[0], /resources[\/]codex-skills$/);
  assert.equal(roots[1], path.join('/test-user-data', 'codex-home', 'skills'));
}


test('current explicit approval persists the commit barrier before answering and retains prior pending commits', async () => {
  const h = harness(); const {run,answer} = pendingApproval(h);
  run.pendingNativeCommits = ['older-item']; run.preparationStage = {phase:'prepared',revision:7};
  h.hooks.checkpoint = async record => {
    assert.deepEqual(record.pendingNativeCommits,['older-item','item-1']);
    assert.equal(run.approvedFileItems.size,0); assert.equal(h.responses.length,0);
  };
  await h.service.resolveConfirmation(answer);
  assert.deepEqual(run.pendingNativeCommits,['older-item','item-1']);
  assert.deepEqual(run.preparationStage,{phase:'prepared',revision:7});
});
test('current decline rolls back preparation stage on checkpoint failure, then persists the rejection on retry', async () => {
  const h = harness(); const {run,answer} = pendingApproval(h);
  run.pendingNativeCommits = ['older-item']; run.preparationStage = {phase:'prepared',revision:7};
  h.failOnce('checkpoint');
  await assert.rejects(h.service.resolveConfirmation({...answer,accept:false}),/injected/);
  assert.deepEqual(run.preparationStage,{phase:'prepared',revision:7});
  assert.deepEqual(run.pendingNativeCommits,['older-item']);
  await h.service.resolveConfirmation({...answer,accept:false});
  assert.deepEqual(run.preparationStage,{phase:'rejected',revision:8});
  assert.deepEqual(h.savedRecords.at(-1).preparationStage,run.preparationStage);
  assert.deepEqual(run.pendingNativeCommits,['older-item']);
});
for (const action of ['interrupt','exit']) {
  test('current '+action+' during automatic approval checkpoint never installs a late approval', async () => {
    const h = harness(); await h.service._ensureProcess(route); const {run}=pendingApproval(h);
    h.service.pendingConfirmations.clear();
    Object.assign(run,{workspace:{root:'/test-workspace'},nativeFileItems:new Map(),taskConstraints:{allowedWriteResourceRefs:[]},selectionState:null});
    h.authorization={granted:true,version:1};const gate=h.pauseOnce('checkpoint');
    const attempt=h.service._handleServerRequest('item/fileChange/requestApproval',{
      threadId:run.threadId,turnId:run.turnId,itemId:'native-item',
      fileChanges:[{path:'chapters/chapter-001.md',kind:{type:'update'},diff:'fixture diff'}]
    });
    await gate.entered;
    assert.equal(run.approvedFileItems.size,0);
    assert.deepEqual(h.calls.findLast(call=>call.stage==='checkpoint').payload.pendingNativeCommits,['native-item']);
    if(action==='interrupt')await h.service.interrupt({runId:run.runId});
    else {h.service.processManager.client.closed=true;h.service.processManager.emit('exit',new Error('simulated exit'));}
    gate.release();assert.deepEqual(await attempt,{decision:'cancel'});
    assert.equal(run.approvedFileItems.size,0);
  });
}
