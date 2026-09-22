'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
async function main() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mana-chat-contract-'));
  process.env.MANA_USER_DATA_ROOT = path.join(tmp, 'data');
  const novels = require('../src/main/store/novels');
  const history = require('../src/main/store/chatHistory');
  const modelConfig = require('../src/main/modelConfig');
  const { CodexSessionService } = require('../src/main/codex-runtime/codexSessionService');
  const a = await novels.createNovel({ title: '甲', dir: path.join(tmp, 'a') });
  const b = await novels.createNovel({ title: '乙', dir: path.join(tmp, 'b') });
  const t = await history.createThread({ title: '甲对话', novelId: a.id });
  modelConfig.activeRoute = async () => ({ connection: { kind: 'api' }, model: { id: 'fixture', verification: { tools: 'ok' } } });
  const service = new CodexSessionService();
  let calls = 0;
  service.processManager = { workspacesDirectory: path.join(tmp, 'workspaces'), request: async () => ({}), stop: async () => {} };
  service._ensureProcess = async () => service.processManager;
  service._bindConversation = async () => 'native-thread';
  service._startNativeTurn = async () => { calls++; return { turn: { id: 'native-turn-' + calls } }; };
  await assert.rejects(service.startTurn({ runId: 'wrong', persistence: 'chat', conversationId: t.id, novelId: b.id, userMessageId: 'wrong-user', text: '改写' }), e => e.code === 'conversation_project_mismatch');
  assert.equal(calls, 0);
  const payload = { runId: 'first', persistence: 'chat', conversationId: t.id, novelId: a.id, userMessageId: 'user-1', text: '读取人物卡' };
  const [one, duplicate] = await Promise.all([service.startTurn(payload), service.startTurn(payload)]);
  assert.equal(one.runId, duplicate.runId);
  assert.equal(calls, 1);
  assert.equal((await history.getThread(t.id)).messages.filter(m => m.id === 'user-1').length, 1);
  assert.ok(service.activeRuns.get('first').workspace, 'project chat must mount tools without a Skill');
  await assert.rejects(history.deleteThread(t.id), /进行|运行|启动/u);
  await assert.rejects(history.updateThreadNovelId(t.id, b.id), /进行|运行|启动/u);
  await history.enforceQuota(1);
  assert.ok(await history.getThread(t.id), 'quota must retain the active conversation');
  await assert.rejects(service.startTurn({ ...payload, text: '不同内容' }), e => e.code === 'run_identity_conflict');
  await assert.rejects(service.startTurn({ ...payload, runId: 'other', userMessageId: 'user-2' }), e => e.code === 'chat_turn_active');
  const state = await service.getConversationState({ conversationId: t.id });
  assert.equal(state.run.runId, 'first');
  await service._onNotification({ method: 'item/agentMessage/delta', params: { threadId: 'native-thread', turnId: one.turnId, delta: '保留这段文字' } });
  await service._onNotification({ method: 'turn/completed', params: { threadId: 'native-thread', turn: { id: one.turnId, status: 'interrupted' } } });
  const stored = (await history.getThread(t.id)).messages.find(m => m.role === 'assistant');
  assert.equal(stored.text, '保留这段文字');
  assert.equal(stored.execution.status, 'interrupted');
  assert.equal((await service.getRunState({ runId: 'first' })).status, 'interrupted');
  assert.equal(service.threadRuns.has(t.id), false);
  const savedUser = history.ensureUserMessage;
  history.ensureUserMessage = async () => { throw new Error('模拟消息落盘失败'); };
  await assert.rejects(service.startTurn({ ...payload, runId: 'save-failure', userMessageId: 'save-failure' }), /落盘失败/u);
  assert.equal(calls, 1, 'message failure must not call the model');
  assert.equal(service.threadRuns.has(t.id), false);
  history.ensureUserMessage = savedUser;

  const nativeStart = service._startNativeTurn;
  service._startNativeTurn = async () => { throw new Error('模拟模型启动失败'); };
  await assert.rejects(service.startTurn({ ...payload, runId: 'start-failure', userMessageId: 'retry-user' }), /启动失败/u);
  assert.equal(service.threadRuns.has(t.id), false);
  service._startNativeTurn = nativeStart;
  const retry = await service.startTurn({ ...payload, runId: 'retry', userMessageId: 'retry-user' });
  assert.equal((await history.getThread(t.id)).messages.filter(m => m.id === 'retry-user').length, 1);
  const storeRun = history.saveRunMessage;
  let failTerminalOnce = true;
  history.saveRunMessage = async (...args) => {
    if (failTerminalOnce && args[1].execution.status === 'completed') { failTerminalOnce = false; throw new Error('模拟终态落盘失败'); }
    return storeRun(...args);
  };
  const event = { type: 'turn_completed', runId: 'retry', conversationId: t.id };
  const retryRun = service.activeRuns.get('retry');
  await service._finalizeRun(retryRun, event);
  assert.equal((await service.getRunState({ runId: 'retry' })).status, 'finalizing');
  clearTimeout(service.checkpointTimers.get('retry'));
  service.checkpointTimers.delete('retry');
  retryRun.finalizing = null;
  await service._finalizeRun(retryRun, event);
  assert.equal((await service.getRunState({ runId: 'retry' })).status, 'completed');
  assert.equal(calls, 2, 'retry finalization must not rerun the model');
  assert.equal((await history.getThread(t.id)).messages.filter(m => m.runtimeTaskRunId === 'retry').length, 1);
  history.saveRunMessage = storeRun;

  const novelData = require('../src/main/store/novelData');
  await novelData.writeChapterWithMeta(a.dir, 'chapter-scope.md', '甲乙丙\n', {}, { baseContent: '' });
  const context = await service.getResourceContext({ novelId: a.id, resourceRef: 'chapter:chapter-scope.md' });
  await assert.rejects(service.startTurn({ ...payload, runId: 'stale-scope', userMessageId: 'stale-user',
    editScope: { mode: 'selection', resourceRef: 'chapter:chapter-scope.md', baseHash: 'old-version', start: 0, end: 1 } }), /版本/u);
  assert.equal(calls, 2);
  const scoped = await service.startTurn({ ...payload, runId: 'scope', userMessageId: 'scope-user',
    editScope: { mode: 'insertion', ...context, start: 1, end: 1 } });
  assert.deepEqual(service.activeRuns.get('scope').selectionState.range, { start: 1, end: 1 });
  assert.deepEqual(service.activeRuns.get('scope').taskConstraints.allowedWriteResourceRefs, ['chapter:chapter-scope.md']);
  await service._finalizeRun(service.activeRuns.get('scope'), { type: 'turn_interrupted', runId: scoped.runId, conversationId: t.id });

  modelConfig.activeRoute = async () => ({ connection: { kind: 'api' }, model: { id: 'text-only', verification: { tools: 'failed' } } });
  const plain = await service.startTurn({ ...payload, runId: 'plain', userMessageId: 'plain-user' });
  assert.equal(service.activeRuns.get('plain').workspace, null);
  assert.equal((await service.getRunState({ runId: plain.runId })).capability, 'text-only');
  await service._finalizeRun(service.activeRuns.get('plain'), { type: 'turn_completed', runId: plain.runId, conversationId: t.id });

  const { mergeRunState, committedSections } = await import('../src/components/chatRunState.mjs');
  const newer = { runId: 'new', startedAt: '2026-09-22', version: 4 };
  assert.equal(mergeRunState(newer, { ...newer, version: 3 }), newer);
  assert.equal(mergeRunState(newer, { runId: 'old', startedAt: '2026-09-21', version: 99 }), newer);
  assert.deepEqual(committedSections([{ resourceRef: 'character:a' }, { resourceRef: 'world:lore' }]), ['characters', 'world']);
  const editedHistoryMessage = (await history.getThread(t.id)).messages.find(m => m.runtimeTaskRunId === 'plain');
  await history.editMessage(t.id, editedHistoryMessage.id, '用户事后修正的历史文字');
  await service.dispose();
  const journal = require('../src/main/store/chatRuns');
  await journal.save({ schemaVersion: 1, runId: 'crashed', conversationId: t.id, novelId: a.id, persistence: 'chat',
    userMessageId: 'plain-user', messageStored: true, status: 'waiting-approval', version: 5,
    startedAt: new Date().toISOString(), text: '崩溃前检查点', items: [], savedResources: [], confirmation: { confirmationId: 'expired' } });
  const recovered = new CodexSessionService();
  const crashState = await recovered.getRunState({ runId: 'crashed' });
  assert.equal(crashState.status, 'interrupted');
  assert.equal(crashState.confirmation, null);
  assert.equal((await history.getThread(t.id)).messages.find(m => m.id === editedHistoryMessage.id).text, '用户事后修正的历史文字', 'recovery must not overwrite edited terminal history');
  assert.equal(mergeRunState({ ...crashState, generation: 0, version: 9999, status: 'waiting-approval' }, crashState).status, 'interrupted', 'recovery supersedes unpersisted pre-crash events');
  assert.equal((await history.getThread(t.id)).messages.find(m => m.runtimeTaskRunId === 'crashed').text, '崩溃前检查点');
  await assert.rejects(recovered.resolveConfirmation({ runId: 'crashed', confirmationId: 'expired', accept: true }), /过期|不存在|失效/u);
  await recovered.dispose();
  console.log('chat-chain-contract: ok');
}
main().catch(e => { console.error(e); process.exitCode = 1; });
