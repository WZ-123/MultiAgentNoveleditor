'use strict';
const chatRuns = require('../store/chatRuns');
const chatHistory = require('../store/chatHistory');
const { normalizeTaskConstraints } = require('./taskLedger');
const { contractError } = require('./contracts');

async function prepareTaskContinuation(payload) {
  const explicitlyContinuing = /^\s*继续(?:未完成任务|补足字数)(?:[，,。\s：:]|$)/u.test(String(payload.text || ''));
  if (!payload.continueFromRunId && !explicitlyContinuing) return { ...payload, continuation: null };
  const history = await chatHistory.getThread(String(payload.conversationId || ''));
  if (!history || String(history.novelId || '') !== String(payload.novelId || '')) throw contractError('继续任务必须属于当前小说和对话', 'continuation_mismatch');
  const branch = chatHistory.getBranch(history);
  const sourceId = payload.continueFromRunId || branch.findLast(message => message.runtimeTaskRunId)?.runtimeTaskRunId;
  const source = sourceId ? await chatRuns.get(String(sourceId)) : null;
  if (!source || source.conversationId !== payload.conversationId || String(source.novelId || '') !== String(payload.novelId || '')
    || !branch.some(message => message.runtimeTaskRunId === source.runId)
    || !['completed', 'failed', 'interrupted'].includes(source.status)) throw contractError('未找到当前分支可继续的任务', 'continuation_mismatch');
  if (!source.taskResult || source.taskResult.goalVerified || source.taskResult.goalStatus === 'unverified') throw contractError('该任务没有可继续的未完成目标', 'continuation_unavailable');
  if (source.editScope?.mode && source.editScope.mode !== 'unrestricted') throw contractError('限定范围任务需要重新选择当前选区后发送', 'continuation_scope_required');
  const constraints = normalizeTaskConstraints(source.taskResult.constraints || source.taskConstraints);
  const requested = normalizeTaskConstraints(payload.taskConstraints);
  if (requested.minBodyCjk != null || requested.maxBodyCjk != null) {
    constraints.minBodyCjk = requested.minBodyCjk;
    constraints.maxBodyCjk = requested.maxBodyCjk;
  }
  const saved = [...(source.taskResult.reusedSavedResources || []), ...(source.savedResources || [])];
  return { ...payload, taskId: source.taskId || source.userMessageId, taskConstraints: constraints,
    continuation: { sourceRunId: source.runId, savedResources: [...new Map(saved.map(resource => [resource.resourceRef, resource])).values()],
      memoryBaselines: source.memoryBaselines || null,
      taskRequestText:source.taskRequestText || source.requestText || branch.find(message=>message.id===source.userMessageId)?.text || '',
      reviewFindings: source.reviewFindings || [],
      unmet: source.taskResult.objective?.unmet || [], checks: source.taskResult.checks || {} } };
}

module.exports = { prepareTaskContinuation };
