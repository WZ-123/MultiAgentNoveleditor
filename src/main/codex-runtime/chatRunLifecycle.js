'use strict';
const chatRuns = require('../store/chatRuns');
const chatHistory = require('../store/chatHistory');
const { clone } = require('./contracts');
const TERMINAL = new Set(['completed', 'failed', 'interrupted']);

module.exports = {
  async _recoverRuns() {
    if (!this.recoveryPromise) this.recoveryPromise = (async () => {
      for (const record of await chatRuns.list()) {
        const history = record.persistence === 'chat' ? await chatHistory.getThread(record.conversationId) : null;
        if (record.persistence === 'chat' && !history?.messages?.some(item => item.id === record.userMessageId)) record.messageStored = false;
        if (!TERMINAL.has(record.status)) {
          record.status = 'interrupted';
          record.error = '上次运行已停止，恢复到最后保存的检查点';
          record.confirmation = null;
          record.generation = Number(record.generation || 0) + 1;
          record.version++;
          record.updatedAt = new Date().toISOString();
          // Retain host commit evidence, never replay an old approval or patch.
          if (record.taskResult) record.taskResult.modelTurnCompleted = false;
          await this._persistRecord(record);
        } else if (record.messageStored) {
          // The journal may have reached disk just before the history write failed.
          // Do not rewrite old history or overwrite a user's later history edits.
          const message = history?.messages.find(item => item.runtimeTaskRunId === record.runId);
          if (!message || message.isStreaming || Number(message.execution?.version || 0) < record.version) await this._persistRecord(record);
        }
        if (!this.runRecords.has(record.runId)) this.runRecords.set(record.runId, record);
      }
    })();
    return this.recoveryPromise;
  },
  _captureRun(runId) {
    const record = this.runRecords.get(runId);
    const run = this.activeRuns.get(runId);
    if (!record) return null;
    if (run) Object.assign(record, {
      threadId: run.threadId, turnId: run.turnId, text: run.text || '', items: clone(run.items || []),
      savedResources: clone(run.committedResources || []), progress: clone(run.progress || null),
    });
    record.updatedAt = new Date().toISOString();
    return record;
  },
  _emitEvent(event) {
    const record = event.runId && this._captureRun(event.runId);
    if (record) {
      record.version++;
      if (event.type === 'confirmation_requested') {
        record.status = 'waiting-approval'; record.confirmation = clone(event);
      } else if (event.type === 'turn_started' && record.status === 'starting') record.status = 'running';
      event = { ...event, novelId: record.novelId, version: record.version, runState: clone(record) };
    }
    return this.emit('event', event);
  },
  async _persistRecord(record) {
    const snapshot = clone(record);
    await chatRuns.save(snapshot);
    if (snapshot.persistence === 'chat' && snapshot.messageStored) {
      await chatHistory.saveRunMessage(snapshot.conversationId, {
        id: `run-message-${snapshot.runId}`, parentId: snapshot.userMessageId,
        runtimeTaskRunId: snapshot.runId, role: 'assistant', text: snapshot.text || '',
        timestamp: Date.parse(snapshot.startedAt), codexTurnId: snapshot.turnId || null,
        isStreaming: !TERMINAL.has(snapshot.status), toolCalls: snapshot.items || [],
        execution: { status: snapshot.status, version: snapshot.version, error: snapshot.error || null,
          savedResources: snapshot.savedResources || [], taskResult: snapshot.taskResult || null },
      });
    }
  },
  async _checkpointRun(runId) {
    const record = this._captureRun(runId);
    if (record) await this._persistRecord(record);
  },
  _scheduleCheckpoint(runId) {
    if (this.checkpointTimers.has(runId)) return;
    const timer = setTimeout(() => {
      this.checkpointTimers.delete(runId);
      this._checkpointRun(runId).catch(error => {
        const record = this.runRecords.get(runId);
        if (record) record.checkpointError = error.message;
        this._emitEvent({ type: 'checkpoint_failed', runId, conversationId: record?.conversationId, error: error.message });
      });
    }, 2000);
    timer.unref?.();
    this.checkpointTimers.set(runId, timer);
  },
  async getRunState({ runId } = {}) {
    await this._recoverRuns();
    return clone(this._captureRun(String(runId)) || null);
  },
  async getConversationState({ conversationId } = {}) {
    await this._recoverRuns();
    const history = await chatHistory.getThread(String(conversationId));
    if (!history) throw new Error('对话不存在');
    const active = this.threadRuns.get(String(conversationId));
    const run = active ? this._captureRun(active) : [...this.runRecords.values()]
      .filter(item => item.conversationId === conversationId && String(item.novelId || '') === String(history.novelId || ''))
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
    return { conversationId, novelId: history.novelId, run: clone(run || null) };
  },
  async _finalizeRun(run, event) {
    if (run.finalizing) return run.finalizing;
    const finish = async () => {
      const record = this._captureRun(run.runId);
      const terminal = event.type === 'turn_completed' ? 'completed' : event.type === 'turn_interrupted' ? 'interrupted' : 'failed';
      const taskResult = await this._evaluateTaskResult(run, terminal === 'completed');
      if (record) {
        record.status = 'finalizing'; record.confirmation = null; record.error = event.error || null;
        record.taskResult = taskResult; record.version++;
      }
      await this._updateProgress(run, { phase: terminal === 'completed' ? (taskResult.goalVerified ? 'completed' : 'goal-incomplete') : terminal,
        goalStatus: terminal === 'completed' ? (taskResult.goalVerified ? 'completed' : 'incomplete') : terminal });
      await this.ledger.finish(run.runId, terminal === 'completed' ? 'model_turn_completed' : terminal, {
        threadId: run.threadId, turnId: run.turnId, taskResult, failure: event.failure || null, usage: event.usage || null,
      });
      if (record) {
        this._captureRun(run.runId);
        record.status = terminal; record.version++; record.confirmation = null;
        delete record.checkpointError;
        await this._persistRecord(record);
      }
      this._finishRun(run.runId);
      this._emitEvent({ ...event, taskResult });
    };
    const finishing = finish().catch(error => {
      const record = this._captureRun(run.runId);
      if (record) { record.status = 'finalizing'; record.checkpointError = error.message; }
      this._emitEvent({ type: 'checkpoint_failed', runId: run.runId, conversationId: run.conversationId, error: '结果保存失败，正在重试：' + error.message });
      clearTimeout(this.checkpointTimers.get(run.runId));
      const timer = setTimeout(() => { this.checkpointTimers.delete(run.runId); run.finalizing = null; this._finalizeRun(run, event); }, 2000);
      timer.unref?.();
      this.checkpointTimers.set(run.runId, timer);
    });
    Object.defineProperty(run, 'finalizing', { value: finishing, writable: true, configurable: true, enumerable: false });
    return run.finalizing;
  },
};
