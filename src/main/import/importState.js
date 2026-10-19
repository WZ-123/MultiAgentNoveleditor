'use strict';
// The sole business-state reducer. Executors own bytes, never transitions.
const { randomUUID } = require('node:crypto');
const TERMINAL = new Set(['completed', 'cancelled']);
const ALLOWED = {
  restartSource: ['picked', 'parsed'], parsed: ['picked'], staged: ['parsed'], legacyReview: ['staged'], beginAnalysis: ['staged'],
  analysisStarted: ['analyzing'], analysisComplete: ['analyzing'], analysisLost: ['analyzing'],
  restartAnalysis: ['staged', 'analyzing', 'review', 'failed', 'interrupted'],
  mergePrepared: ['review', 'merging'], mergeChanged: ['merging'], beginPromotion: ['review', 'promoting'],
  reviewChanged: ['review'],
  decideCommit: ['review', 'merging', 'promoting', 'completed'], recover: ['failed', 'interrupted', 'recovery_required'],
};
function error(message, code = 'invalid_import_state', retryable = false) { return Object.assign(new Error(message), { code, retryable }); }
function guard(run, command, options = {}) {
  if (!run) throw error('import run is missing');
  if (options.expectedRevision != null && run.revision !== options.expectedRevision) throw error('导入状态已变化，请重新读取', 'stale_import_operation', true);
  if (options.token && run.work?.token !== options.token) throw error('旧导入工作结果已失效', 'stale_import_operation', true);
  if (options.decisionId && run.commitDecision?.id !== options.decisionId) throw error('旧提交结果已失效', 'stale_import_operation', true);
  if (ALLOWED[command] && !ALLOWED[command].includes(run.state)) throw error(`不能从 ${run.state} 执行 ${command}（允许 ${ALLOWED[command].join(', ')}）`);
  if (['mergePrepared', 'mergeChanged', 'reviewChanged', 'beginAnalysis', 'restartAnalysis'].includes(command) && run.commitDecision) throw error('提交决定已持久化，请恢复原次提交');
}
function transition(run, state, checkpoint) {
  const now = new Date().toISOString(), prior = run.phases.at(-1);
  if (prior && !prior.completedAt) prior.completedAt = now;
  run.state = state; run.error = null; run.retryable = false;
  run.phases.push({ phase: state, revision: run.revision + 1, inputFingerprint: run.inputFingerprint || '', checkpoint: structuredClone(checkpoint || {}), startedAt: now, completedAt: TERMINAL.has(state) || ['failed', 'interrupted'].includes(state) ? now : null });
  if (checkpoint) run.checkpoints.push({ phase: state, at: now, ...structuredClone(checkpoint) });
}
function apply(current, command, p = {}) {
  const r = structuredClone(current);
  switch (command) {
    case 'adoptLegacy':
      if (r.schemaVersion >= 2) return current;
      r.generation ||= 1; r.work = null;
      if (p.operation && ['committing', 'committed'].includes(p.operation.state) && p.mergeDecision) throw error('旧导入存在冲突的提交身份', 'recovery_required', true);
      if (p.operation && ['committing', 'committed'].includes(p.operation.state)) {
        r.commitDecision = { id: p.operation.operationId, kind: 'promotion', operation: p.operation, decidedAt: p.operation.result?.receipt?.committedAt };
        if (r.state !== 'completed') transition(r, 'promoting', { adoptedLegacyDecision: true });
      } else if (p.mergeDecision) {
        r.commitDecision = p.mergeDecision; r.mergeTargetDir = p.mergeDecision.targetDir; r.targetNovelId = p.mergeDecision.novelId; r.mergeSessionId = p.mergeDecision.sessionId;
        r.result = { id: r.targetNovelId, receipt: p.mergeDecision.receipt };
        transition(r, 'completed', { mergeReceipt: p.mergeDecision.receipt, adoptedLegacyDecision: true });
      } else if (p.operation?.state === 'cancelled' && r.state !== 'completed') transition(r, 'cancelled', { adoptedLegacyCancellation: true });
      break;
    case 'restartSource': r.generation = (r.generation || 0) + 1; r.work = { ...p, generation: r.generation }; break;
    case 'parsed': r.parsed = p.parsed; delete r.request; r.inputFingerprint = p.fingerprint || ''; transition(r, 'parsed', { chapterCount: p.parsed.chapters.length, fingerprint: r.inputFingerprint }); break;
    case 'staged': r.importId = p.importId; delete r.parsed; r.work = null; transition(r, 'staged', { importId: r.importId, chapterCount: p.chapterCount }); break;
    case 'legacyReview': transition(r, 'review', { compatibilityForward: 'explicit-promotion' }); break;
    case 'beginAnalysis': r.generation = (r.generation || 0) + 1; r.work = { ...p, kind: 'analyze', generation: r.generation }; transition(r, 'analyzing'); break;
    case 'analysisStarted': r.analysis = p; break;
    case 'analysisComplete': r.analysisResult = p; r.work = null; transition(r, 'review', { analysis: p }); break;
    case 'analysisLost': r.work = null; transition(r, 'interrupted'); r.error = { code: 'provider_state_lost', message: '原分析所有者已结束，可从检查点恢复', phase: 'analyzing' }; r.retryable = true; break;
    case 'restartAnalysis': r.work = null; r.generation = (r.generation || 0) + 1; transition(r, 'staged', { explicitAnalysisRestart: true }); break;
    case 'mergePrepared':
      if (r.targetNovelId && r.targetNovelId !== p.novelId) throw error('import merge target mismatch', 'import_target_mismatch');
      if (r.mergeTargetDir && r.mergeTargetDir !== p.targetDir) throw error('已有合并目标目录不能静默重定', 'import_target_mismatch');
      r.targetNovelId = p.novelId; r.mergeTargetDir = p.targetDir; r.mergeSessionId = p.sessionId; r.mergeSummary = p.summary; transition(r, 'merging', { mergeSessionId: p.sessionId }); break;
    case 'mergeChanged': r.mergeSummary = p.summary; r.error = p.error || null; r.retryable = !!p.error; break;
    case 'reviewChanged': break;
    case 'beginPromotion':
      if (r.state === 'promoting') {
        if (p.target && JSON.stringify(p.target) !== JSON.stringify(r.target)) throw error('提升目标已绑定，请恢复原次导入', 'import_target_mismatch');
        return current;
      }
      if (p.target) r.target = p.target;
      r.generation = (r.generation || 0) + 1; r.work = { kind: 'promote', token: randomUUID(), generation: r.generation };
      transition(r, 'merging', { conflicts: 0, mergeRequired: false }); transition(r, 'promoting'); break;
    case 'decideCommit':
      if (r.commitDecision) {
        const signature = (d) => JSON.stringify([d.id, d.kind, d.sessionId, d.novelId, d.importId, d.targetDir, d.plan?.id, d.plan?.changes?.map(({ relative, beforeHash, after }) => ({ relative, beforeHash, after })), d.operation?.targetDir, d.operation?.manifestHash, d.operation?.result]);
        if (signature(r.commitDecision) !== signature(p)) throw error('提交身份与持久决定不一致', 'recovery_required', true);
        return current;
      }
      if (p.kind === 'merge') {
        if (p.novelId !== r.targetNovelId || p.importId !== r.importId || r.mergeTargetDir && r.mergeTargetDir !== p.targetDir) throw error('合并提交目标与运行身份不一致', 'import_target_mismatch');
        r.mergeTargetDir = p.targetDir;
      }
      r.commitDecision = { ...p, decidedAt: new Date().toISOString() };
      if (r.state !== 'promoting') transition(r, 'promoting', { promotionRequired: p.kind === 'promotion' }); break;
    case 'completed':
      if (r.state === 'completed') return current;
      if (!r.commitDecision || r.commitDecision.id !== p.decisionId) throw error('完成结果缺少对应提交决定', 'recovery_required', true);
      r.result = p.result; r.work = null; transition(r, 'completed', p.mergeReceipt ? { mergeReceipt: p.mergeReceipt } : { promotion: p.result }); break;
    case 'cancel':
      if (r.commitDecision || r.state === 'completed') { r.cancelOutcome = 'already_committed'; break; }
      if (r.state === 'cancelled') return current;
      r.generation = (r.generation || 0) + 1; r.work = null; transition(r, 'cancelled', { cancelled: true }); break;
    case 'recover': {
      const next = r.commitDecision ? 'promoting' : r.mergeSessionId ? 'merging' : r.checkpoints.some((c) => c.phase === 'review') ? 'review' : r.importId ? 'staged' : r.parsed ? 'parsed' : 'picked';
      r.work = null; transition(r, next, { resumedFrom: r.error?.phase || r.state }); break;
    }
    case 'fail': {
      if (TERMINAL.has(r.state)) return current;
      const e = p.error, phase = r.state;
      if (['unresolved_conflicts', 'stale_import_review'].includes(e.code) && !r.commitDecision) { r.error = { code: e.code, message: e.message, phase }; r.retryable = true; break; }
      if ((e.code === 'cancelled' || e.name === 'AbortError') && !r.commitDecision) return apply(r, 'cancel');
      transition(r, r.commitDecision || e.retryable === true ? 'interrupted' : 'failed');
      r.error = { code: e.code || 'import_failed', message: e.message, phase }; r.retryable = !!r.commitDecision || e.retryable !== false; break;
    }
    default: throw error(`unknown import command: ${command}`);
  }
  r.schemaVersion = 2; r.revision = (r.revision || 0) + 1; r.updatedAt = new Date().toISOString(); return r;
}
function snapshot(r) {
  const allowedActions = TERMINAL.has(r.state) ? [] : r.commitDecision ? ['resume', 'cancel'] : ['failed', 'interrupted', 'recovery_required'].includes(r.state) ? (r.retryable ? ['resume', 'cancel'] : ['cancel']) : ['cancel', ...(['review', 'merging'].includes(r.state) ? ['resolveConflict', 'finalize'] : ['resume'])];
  return structuredClone({ ...r, allowedActions });
}
module.exports = { guard, apply, snapshot, TERMINAL, error };
