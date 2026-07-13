import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Send, Bot, User, AlertCircle, Square, RotateCcw, Wrench, Brain,
  Plus, MessageSquare, Trash2, Edit3, Undo2, Check, X, ChevronLeft,
  ChevronRight, MoreVertical, Save, Wifi, WifiOff, ChevronDown, ChevronUp, Users, ListTree
} from 'lucide-react';
import { appendToolUseMessage, applyToolResultMessage } from '@/components/chatToolState.mjs';
import { buildQuickFeedbackPayload } from '@/components/chatFeedbackPayload.mjs';
import { parseToolResultMeta } from '@/components/chatToolResultMeta.mjs';
import { getRecentRendererLogs, installRecentRendererLogCapture } from '@/components/recentRendererLogs.mjs';
import { buildChapterChangePreview } from '@/components/changePreview.mjs';
import { ChatMarkdown } from '@/components/ChatMarkdown.jsx';

function roleplayTypeLabel(type) {
  const labels = {
    session_start: '启动',
    scene_start: '场景',
    actor_proposal: '角色提案',
    director_decision: '导演仲裁',
    plan_ready: '规划完成',
  };
  return labels[type] || type || '事件';
}

function roleplayRiskClass(riskLevel) {
  if (riskLevel === 'high') return 'border-amber-400/30 bg-amber-500/10 text-amber-100';
  if (riskLevel === 'medium') return 'border-sky-400/25 bg-sky-500/10 text-sky-100';
  return 'border-white/10 bg-white/[0.04] text-gray-200';
}

function roleplayCandidatePreview(list) {
  return (Array.isArray(list) ? list : [])
    .map((item) => item?.text || item?.intent || '')
    .filter(Boolean)
    .slice(0, 2);
}

function RoleplayTimelineCard({ events, isLive, expanded, onToggle }) {
  const safeEvents = Array.isArray(events) ? events.filter(Boolean) : [];
  if (!safeEvents.length) return null;
  const latest = safeEvents[safeEvents.length - 1] || {};
  const sceneCount = safeEvents.filter((event) => event.type === 'scene_start').length;
  const actorCount = safeEvents.filter((event) => event.type === 'actor_proposal').length;
  const directorCount = safeEvents.filter((event) => event.type === 'director_decision').length;
  const hasHighRisk = safeEvents.some((event) => event.riskLevel === 'high');
  const visibleEvents = expanded ? safeEvents : safeEvents.slice(-5);

  return (
    <div className={`rounded-2xl border p-3 text-sm ${hasHighRisk ? 'border-amber-500/25 bg-amber-500/10' : 'border-sky-500/20 bg-sky-500/10'}`}>
      <div className="mb-2 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-xs font-bold text-sky-100">
            <Users size={13} className="text-sky-300" />
            <span>角色驱动写作</span>
            {isLive && <span className="h-1.5 w-1.5 rounded-full bg-sky-300 animate-pulse" />}
          </div>
          <div className="mt-1 text-[11px] leading-relaxed text-gray-300">
            {latest.summary || latest.title || '正在整理角色反应与导演仲裁。'}
          </div>
        </div>
        <button
          type="button"
          className="shrink-0 rounded-lg px-2 py-1 text-[10px] text-sky-200 hover:bg-sky-500/10"
          onClick={onToggle}
        >
          {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
        </button>
      </div>

      <div className="mb-2 flex flex-wrap gap-1.5 text-[10px]">
        <span className="rounded-full bg-black/20 px-2 py-0.5 text-gray-300">{sceneCount} 场景</span>
        <span className="rounded-full bg-black/20 px-2 py-0.5 text-gray-300">{actorCount} 角色提案</span>
        <span className="rounded-full bg-black/20 px-2 py-0.5 text-gray-300">{directorCount} 次仲裁</span>
        {hasHighRisk && <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-amber-200">等待决策</span>}
      </div>

      <div className="space-y-2">
        {visibleEvents.map((event) => {
          const details = event.details || {};
          const actorName = event.actor?.name || details.characterName || details.characterId || '';
          const speech = roleplayCandidatePreview(details.speechCandidates);
          const actions = roleplayCandidatePreview(details.actionCandidates);
          const beats = Array.isArray(details.approvedBeats) ? details.approvedBeats.slice(0, 3) : [];
          const risks = Array.isArray(details.remainingRisks) ? details.remainingRisks.slice(0, 2) : [];
          return (
            <div key={event.eventId || `${event.type}-${event.ts}`} className={`rounded-xl border px-2.5 py-2 ${roleplayRiskClass(event.riskLevel)}`}>
              <div className="mb-1 flex items-center justify-between gap-2">
                <div className="min-w-0 text-[11px] font-semibold">
                  {roleplayTypeLabel(event.type)}{actorName ? ` · ${actorName}` : ''}
                </div>
                {event.riskLevel && event.riskLevel !== 'none' && (
                  <span className="shrink-0 rounded-full bg-black/20 px-1.5 py-0.5 text-[9px] uppercase">{event.riskLevel}</span>
                )}
              </div>
              <div className="text-[11px] leading-relaxed text-current/90">
                {event.summary || event.title || '角色驱动事件'}
              </div>
              {details.currentObjective && (
                <div className="mt-1 text-[10px] text-current/70">目标：{details.currentObjective}</div>
              )}
              {speech.length > 0 && (
                <div className="mt-1 text-[10px] text-current/80">台词：{speech.join(' / ')}</div>
              )}
              {actions.length > 0 && (
                <div className="mt-1 text-[10px] text-current/80">动作：{actions.join(' / ')}</div>
              )}
              {beats.length > 0 && (
                <div className="mt-1 space-y-0.5 text-[10px] text-current/80">
                  {beats.map((beat, index) => (
                    <div key={`${event.eventId}-beat-${index}`}>采纳：{beat.content || beat.type}</div>
                  ))}
                </div>
              )}
              {risks.length > 0 && (
                <div className="mt-1 space-y-0.5 text-[10px] text-amber-100">
                  {risks.map((risk, index) => (
                    <div key={`${event.eventId}-risk-${index}`}>风险：{typeof risk === 'string' ? risk : (risk.note || risk.type || '')}</div>
                  ))}
                </div>
              )}
              {expanded && (
                <pre className="mt-2 max-h-48 overflow-auto rounded-lg bg-black/25 p-2 text-[10px] text-gray-300 whitespace-pre-wrap">
                  {JSON.stringify(event, null, 2)}
                </pre>
              )}
            </div>
          );
        })}
      </div>
      {!expanded && safeEvents.length > visibleEvents.length && (
        <div className="mt-2 text-[10px] text-gray-400">另有 {safeEvents.length - visibleEvents.length} 条过程记录，可展开查看。</div>
      )}
    </div>
  );
}

function HarnessContextCard({ trace, expanded, onToggle }) {
  if (!trace || typeof trace !== 'object') return null;
  const sources = Array.isArray(trace.sourceRefs) ? trace.sourceRefs : [];
  const diagnostics = Array.isArray(trace.diagnostics) ? trace.diagnostics : [];
  const stages = Array.isArray(trace.stages) ? trace.stages : [];
  const trimmed = Array.isArray(trace.trimmed) ? trace.trimmed : [];
  const blocking = diagnostics.filter((item) => item?.severity === 'blocking').length;
  const warning = diagnostics.filter((item) => item?.severity !== 'blocking').length;
  const riskLevel = trace.riskProfile?.level || 'low';
  const modelCalls = Array.isArray(trace.modelCalls) ? trace.modelCalls : [];
  const totalTokens = Number(trace.usage?.totalTokens) || 0;
  const stateVerifications = Array.isArray(trace.stateVerifications) ? trace.stateVerifications : [];
  const stateWarnings = stateVerifications.filter((item) => item?.status === 'warning' || item?.status === 'blocking').length;
  const coverage = trace.criticalSourceCoverage || {};
  const sourceTypes = sources.reduce((counts, item) => {
    const type = item?.type || 'unknown';
    counts[type] = (counts[type] || 0) + 1;
    return counts;
  }, {});
  return (
    <div data-testid="harness-context-card" className={`rounded border p-3 text-xs ${blocking ? 'border-amber-500/30 bg-amber-500/10' : 'border-emerald-500/20 bg-emerald-500/[0.07]'}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 font-semibold text-emerald-100">
            <ListTree size={13} className="text-emerald-300" />
            <span>写作上下文</span>
          </div>
          <div className="mt-1 text-[11px] text-gray-400">
            {trace.harnessMode === 'legacy' ? '兼容流程' : '自适应流程'} · {trace.contextDepth || 'auto'} · {trace.sceneGeneration || 'auto'}
          </div>
        </div>
        <button
          type="button"
          className="shrink-0 rounded p-1 text-emerald-200 hover:bg-emerald-500/10"
          onClick={onToggle}
          title={expanded ? '收起写作上下文' : '展开写作上下文'}
        >
          {expanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
        </button>
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5 text-[10px] text-gray-300">
        <span className="rounded bg-black/20 px-2 py-0.5">{sources.length} 个来源</span>
        <span className="rounded bg-black/20 px-2 py-0.5">{trace.cacheHit ? '缓存命中' : '实时编译'}</span>
        <span className={`rounded px-2 py-0.5 ${riskLevel === 'high' ? 'bg-rose-500/10 text-rose-200' : riskLevel === 'medium' ? 'bg-amber-500/10 text-amber-200' : 'bg-black/20'}`}>风险 {riskLevel}</span>
        {modelCalls.length > 0 && <span className="rounded bg-black/20 px-2 py-0.5">{modelCalls.length} 次模型调用</span>}
        {totalTokens > 0 && <span className="rounded bg-black/20 px-2 py-0.5">{totalTokens.toLocaleString()} tokens{trace.usage?.estimated ? '（估算）' : ''}</span>}
        {warning > 0 && <span className="rounded bg-amber-500/10 px-2 py-0.5 text-amber-200">{warning} 条提示</span>}
        {blocking > 0 && <span className="rounded bg-rose-500/10 px-2 py-0.5 text-rose-200">{blocking} 条阻塞</span>}
        {trimmed.length > 0 && <span className="rounded bg-sky-500/10 px-2 py-0.5 text-sky-200">{trimmed.length} 项裁剪</span>}
      </div>
      {expanded && (
        <div className="mt-3 space-y-2 text-[11px] leading-relaxed text-gray-300">
          {Object.keys(sourceTypes).length > 0 && (
            <div>来源：{Object.entries(sourceTypes).map(([type, count]) => `${type} ${count}`).join(' · ')}</div>
          )}
          {stages.length > 0 && (
            <div>阶段：{stages.map((stage) => `${stage.name} ${Math.round(stage.durationMs || 0)}ms`).join(' · ')}</div>
          )}
          <div>校验：{trace.verificationLevel || 'auto'} · 状态快照 {trace.stateSnapshot?.status || 'missing'} · 状态复核 {stateVerifications.length} 次{stateWarnings ? `，${stateWarnings} 次有提示` : ''}</div>
          {Number.isFinite(Number(coverage.required)) && Number(coverage.required) > 0 && (
            <div>关键来源：使用 {coverage.used || 0}/{coverage.required} · 已验证 {coverage.verified || 0}/{coverage.required}</div>
          )}
          {Array.isArray(trace.riskProfile?.reasons) && trace.riskProfile.reasons.length > 0 && (
            <div>风险依据：{trace.riskProfile.reasons.join('、')}</div>
          )}
          {diagnostics.slice(0, 6).map((item, index) => (
            <div key={`${item.code || 'diagnostic'}-${index}`} className={item.severity === 'blocking' ? 'text-rose-200' : 'text-amber-100'}>
              {item.message || item.code}
            </div>
          ))}
          {trimmed.length > 0 && <div>裁剪：{trimmed.join('、')}</div>}
          {trace.fallbackReason && <div className="text-amber-100">回退：{trace.fallbackReason}</div>}
        </div>
      )}
    </div>
  );
}

function executionStatusLabel(status) {
  const labels = {
    running: '执行中',
    awaiting_confirmation: '等待确认',
    blocked: '已阻塞',
    completed: '已完成',
    failed: '失败',
    cancelled: '已取消',
  };
  return labels[status] || status || '执行中';
}

function ExecutionTraceCard({ trace, thinking, roleplayEvents, toolDetails = [], restoredChanges = {}, buildChangeKey, onRestore, decisionPanel = null, expanded, onToggle }) {
  if (!trace || typeof trace !== 'object') return null;
  const stages = Array.isArray(trace.stages) ? trace.stages : [];
  const tools = Array.isArray(trace.tools) ? trace.tools : [];
  const sources = Array.isArray(trace.context?.sources) ? trace.context.sources : [];
  const checks = Array.isArray(trace.verification?.checks) ? trace.verification.checks : [];
  const decisions = Array.isArray(trace.decisions) ? trace.decisions : [];
  const process = Array.isArray(trace.processSummary) ? trace.processSummary : [];
  const totalTokens = Number(trace.usage?.totalTokens) || 0;
  const startedAt = trace.startedAt ? new Date(trace.startedAt).getTime() : 0;
  const completedAt = trace.completedAt ? new Date(trace.completedAt).getTime() : Date.now();
  const durationMs = startedAt ? Math.max(0, completedAt - startedAt) : stages.reduce((sum, stage) => sum + (Number(stage?.durationMs) || 0), 0);
  const blockingCount = Number(trace.verification?.blockingCount) || 0;
  const tone = trace.status === 'blocked' || trace.status === 'failed'
    ? 'border-amber-500/30 bg-amber-500/10'
    : trace.status === 'completed'
      ? 'border-emerald-500/25 bg-emerald-500/[0.07]'
      : 'border-sky-500/25 bg-sky-500/10';
  return (
    <div data-testid="execution-trace-card" data-trace-status={trace.status || 'running'} className={`min-w-0 max-w-full overflow-hidden rounded-2xl border p-3 text-xs ${tone}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 font-semibold text-sky-100">
            <ListTree size={13} className="text-sky-300" />
            <span>执行过程</span>
            {trace.status === 'running' && <span className="h-1.5 w-1.5 rounded-full bg-sky-300 animate-pulse" />}
          </div>
          <div className="mt-1 text-[11px] text-gray-400">
            {executionStatusLabel(trace.status)} · {trace.runtime?.path || 'runtime'} · {trace.runtime?.intent || 'general'}
          </div>
        </div>
        <button type="button" className="shrink-0 rounded p-1 text-sky-200 hover:bg-sky-500/10" onClick={onToggle} title={expanded ? '收起执行过程' : '展开执行过程'}>
          {expanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
        </button>
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5 text-[10px] text-gray-300">
        <span className="rounded bg-black/20 px-2 py-0.5">{tools.length} 次工具</span>
        <span className="rounded bg-black/20 px-2 py-0.5">{sources.length} 个来源</span>
        <span className={`rounded px-2 py-0.5 ${blockingCount ? 'bg-rose-500/15 text-rose-200' : 'bg-black/20'}`}>校验 {blockingCount ? `${blockingCount} 阻塞` : trace.verification?.status || 'pending'}</span>
        {durationMs > 0 && <span className="rounded bg-black/20 px-2 py-0.5">{durationMs >= 1000 ? `${(durationMs / 1000).toFixed(1)}s` : `${durationMs}ms`}</span>}
        {totalTokens > 0 && <span className="rounded bg-black/20 px-2 py-0.5">{totalTokens.toLocaleString()} tokens</span>}
      </div>
      {expanded && (
        <div className="mt-3 space-y-3 text-[11px] leading-relaxed text-gray-300">
          <section>
            <div className="mb-1 font-semibold text-gray-200">过程</div>
            {stages.length > 0 && <div className="mb-2 flex flex-wrap gap-1">{stages.slice(-12).map((stage) => <span key={stage.id} className="rounded bg-black/20 px-2 py-0.5">{stage.label} · {stage.status}</span>)}</div>}
            <div className="space-y-1">
              {(process.length ? process : stages.map((stage) => stage.summary || stage.label)).slice(-12).map((item, index) => (
                <div key={`process-${index}`} className="rounded-lg bg-black/15 px-2 py-1">{item}</div>
              ))}
            </div>
            {thinking && (
              <details className="mt-2 rounded-lg border border-violet-400/15 bg-violet-950/20 p-2">
                <summary className="cursor-pointer text-violet-200">模型思考（原始输出，可能不完整）</summary>
                <div className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-words text-violet-100/80">{thinking}</div>
              </details>
            )}
            {Array.isArray(roleplayEvents) && roleplayEvents.length > 0 && (
              <div className="mt-2 rounded-lg bg-black/15 px-2 py-1">角色驱动：{roleplayEvents.length} 条过程记录 · {roleplayEvents[roleplayEvents.length - 1]?.summary || '规划已更新'}</div>
            )}
          </section>
          <section className="min-w-0"><div className="mb-1 font-semibold text-gray-200">来源</div>{sources.length > 0 ? <div className="flex min-w-0 flex-wrap gap-1">{sources.slice(0, 16).map((source, index) => <span key={`${source.sourceRef}-${index}`} className="max-w-full break-all rounded bg-black/20 px-2 py-0.5">{source.kind || 'context'} · {source.sourceRef}</span>)}</div> : <div className="text-gray-500">本轮未使用外部来源。</div>}</section>
          {tools.length > 0 ? (
            <section>
              <div className="mb-1 font-semibold text-gray-200">工具</div>
              <div className="space-y-1">
                {tools.map((tool) => {
                  const detail = toolDetails.find((item) => item.toolUseId === tool.id);
                  const meta = detail?.status === 'done' && !detail?.isError ? parseToolResultMeta(detail.result || '') : null;
                  const changedFiles = meta?.changedFiles || [];
                  return (
                    <div key={tool.id} className={`rounded-lg px-2 py-1 ${tool.isError || detail?.isError ? 'bg-rose-500/10 text-rose-200' : 'bg-black/15'}`}>
                      <div className="break-all font-medium">{tool.name} · {tool.status}{tool.execution ? ` · ${tool.execution}` : ''}{tool.cached ? ' · 缓存' : ''}{tool.modelContentTrimmed ? ' · 已裁剪' : ''}</div>
                      {tool.resultSummary && <div className="mt-0.5 text-gray-400">{tool.resultSummary}</div>}
                      {detail && (
                        <details className="mt-1 rounded bg-black/15 px-2 py-1">
                          <summary className="cursor-pointer text-sky-200">查看结果详情</summary>
                          {detail.input && <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-words text-gray-400">{JSON.stringify(detail.input, null, 2)}</pre>}
                          {detail.result && <pre className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap break-words text-gray-300">{String(detail.result)}</pre>}
                        </details>
                      )}
                      {changedFiles.length > 0 && (
                        <div className="mt-2 space-y-1">
                          {changedFiles.map((file, index) => {
                            const preview = buildChapterChangePreview(file.beforeContent, file.afterContent);
                            const changeKey = buildChangeKey?.(detail.id, file) || `${detail.id}-${index}`;
                            return (
                              <div key={changeKey} className="rounded bg-black/20 px-2 py-1">
                                <div className="flex items-center justify-between gap-2">
                                  <span>{file.label || file.chapterName} · {preview.summary}</span>
                                  {onRestore && <button type="button" className="rounded border border-white/10 px-2 py-0.5 text-[10px]" disabled={!!restoredChanges[changeKey]} onClick={() => onRestore(detail.id, file)}>{restoredChanges[changeKey] ? '已撤销' : '撤销'}</button>}
                                </div>
                                {(preview.beforeSnippet || preview.afterSnippet) && <div className="mt-1 text-gray-400">{preview.beforeSnippet && `原：${preview.beforeSnippet}`}{preview.beforeSnippet && preview.afterSnippet ? ' · ' : ''}{preview.afterSnippet && `新：${preview.afterSnippet}`}</div>}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>
          ) : <section><div className="mb-1 font-semibold text-gray-200">工具</div><div className="text-gray-500">本轮未调用工具。</div></section>}
          <section><div className="mb-1 font-semibold text-gray-200">验证</div>{checks.length > 0 ? <div className="space-y-1">{checks.map((check, index) => <div key={`${check.constraintId}-${index}`} className={`rounded-lg px-2 py-1 ${check.severity === 'blocking' && check.status !== 'satisfied' ? 'bg-rose-500/10 text-rose-200' : 'bg-black/15'}`}>{check.constraintId} · {check.status}{check.summary ? ` · ${check.summary}` : ''}</div>)}</div> : <div className="text-gray-500">{trace.verification?.status === 'not_required' ? '本轮无需章节严格验证。' : `状态：${trace.verification?.status || 'pending'}`}</div>}</section>
          <section><div className="mb-1 font-semibold text-gray-200">决策</div>{decisions.length > 0 ? <div className="space-y-1">{decisions.map((decision, index) => <div key={`${decision.kind}-${index}`} className="rounded-lg bg-black/15 px-2 py-1">{decision.status} · {decision.summary || decision.kind}</div>)}</div> : <div className="text-gray-500">本轮没有待处理决策。</div>}{decisionPanel && <div className="mt-2">{decisionPanel}</div>}</section>
        </div>
      )}
    </div>
  );
}

export function AiChatPanel({ editorContext, onReplaceSelectedText, onReplaceTextNearCursor, onInsertTextAtCursor, onBeforeSendMessage }) {
  const mana = typeof window !== 'undefined' ? window.mana : null;

  function expandThreadBranch(branch) {
    const expanded = [];
    for (const m of branch || []) {
      expanded.push({
        id: m.id,
        role: m.role,
        text: m.text,
        timestamp: m.timestamp,
        edited: m.edited,
        toolCalls: m.toolCalls,
        roleplayEvents: Array.isArray(m.roleplayEvents) ? m.roleplayEvents : [],
        harnessTrace: m.harnessTrace || null,
        executionTrace: m.executionTrace || null,
        isStreaming: false,
      });
      if (m.role === 'assistant' && Array.isArray(m.toolCalls)) {
        m.toolCalls.forEach((toolCall, index) => {
          expanded.push({
            id: `${m.id}-tool-${toolCall.id || index}`,
            toolUseId: toolCall.id || null,
            role: 'tool',
            name: toolCall.name,
            input: toolCall.input,
            status: toolCall.status || 'done',
            result: toolCall.result || '',
            isError: !!toolCall.isError,
            cached: toolCall.cached === true,
            cacheKey: toolCall.cacheKey || '',
            sourceRef: toolCall.sourceRef || '',
            modelContentTrimmed: toolCall.modelContentTrimmed === true,
            originalLength: Number(toolCall.originalLength) || 0,
            modelLength: Number(toolCall.modelLength) || 0,
            timestamp: (m.timestamp || Date.now()) + index,
          });
        });
      }
    }
    return expanded;
  }

  // ---- Thread management ----
  const [threads, setThreads] = useState([]);
  const [activeThreadId, setActiveThreadId] = useState(null);
  const [showSidebar, setShowSidebar] = useState(true);
  const [isCompact, setIsCompact] = useState(false);
  const [roleplayChatVisibility, setRoleplayChatVisibility] = useState('compact');

  // ---- Message state ----
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState('');
  const [thinkingText, setThinkingText] = useState('');
  const [showThinking, setShowThinking] = useState(false);
  const [thinkingByTraceId, setThinkingByTraceId] = useState({});
  const [liveExecutionState, setLiveExecutionState] = useState(null);
  const [expandedExecution, setExpandedExecution] = useState({});
  const [progressItems, setProgressItems] = useState([]);
  const [liveRoleplayEvents, setLiveRoleplayEvents] = useState([]);
  const [autoFollow, setAutoFollow] = useState(true);
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);

  // ---- Editing ----
  const [editingId, setEditingId] = useState(null);
  const [editText, setEditText] = useState('');

  // ---- Session (chat agent runtime) ----
  const [sessionId, setSessionId] = useState(null);
  const offEventRef = useRef(null);
  const shellRef = useRef(null);
  const containerRef = useRef(null);
  const activeExecutionTraceIdRef = useRef('');

  // ---- Online/offline ----
  const [isOnline, setIsOnline] = useState(navigator.onLine);

  // ---- Tool result expand/collapse ----
  const [expandedResults, setExpandedResults] = useState({});
  const [expandedChanges, setExpandedChanges] = useState({});
  const [expandedRoleplay, setExpandedRoleplay] = useState({});
  const [expandedHarness, setExpandedHarness] = useState({});
  const [restoredChanges, setRestoredChanges] = useState({});

  // ---- Write chapter confirmation ----
  const [pendingWriteChapter, setPendingWriteChapter] = useState(null);
  const [pendingCharacterProfileDecision, setPendingCharacterProfileDecision] = useState(null);
  const [pendingCharacterProfilePatch, setPendingCharacterProfilePatch] = useState(null);
  const [pendingRoleplayRiskDecision, setPendingRoleplayRiskDecision] = useState(null);
  const [rejectReason, setRejectReason] = useState('');
  const [showFeedbackModal, setShowFeedbackModal] = useState(false);
  const [feedbackTitle, setFeedbackTitle] = useState('');
  const [feedbackDescription, setFeedbackDescription] = useState('');
  const [feedbackIncludeLogs, setFeedbackIncludeLogs] = useState(true);
  const [feedbackIncludeScreenshot, setFeedbackIncludeScreenshot] = useState(false);
  const [feedbackSubmitting, setFeedbackSubmitting] = useState(false);
  const [feedbackNotice, setFeedbackNotice] = useState(null);

  // ---- Refs for values that change independently (avoid stale closures) ----
  const onReplaceRef = useRef(onReplaceSelectedText);
  const onReplaceNearCursorRef = useRef(onReplaceTextNearCursor);
  const onInsertRef = useRef(onInsertTextAtCursor);
  const editorContextRef = useRef(editorContext);
  const handleEventRef = useRef(null);
  const handleRemoteThreadEventRef = useRef(null);
  const sessionIdRef = useRef(sessionId);
  const activeThreadIdRef = useRef(activeThreadId);
  const liveRoleplayEventsRef = useRef([]);
  const currentNovelIdRef = useRef(null);
  const wasCompactRef = useRef(false);
  useEffect(() => { onReplaceRef.current = onReplaceSelectedText; }, [onReplaceSelectedText]);
  useEffect(() => { onReplaceNearCursorRef.current = onReplaceTextNearCursor; }, [onReplaceTextNearCursor]);
  useEffect(() => { onInsertRef.current = onInsertTextAtCursor; }, [onInsertTextAtCursor]);
  useEffect(() => { editorContextRef.current = editorContext; }, [editorContext]);
  useEffect(() => { sessionIdRef.current = sessionId; }, [sessionId]);
  useEffect(() => { activeThreadIdRef.current = activeThreadId; }, [activeThreadId]);

  function resetLiveRoleplayEvents() {
    liveRoleplayEventsRef.current = [];
    setLiveRoleplayEvents([]);
  }

  function appendLiveRoleplayEvent(event) {
    if (!event || typeof event !== 'object') return;
    const next = [...liveRoleplayEventsRef.current, event].slice(-80);
    liveRoleplayEventsRef.current = next;
    setLiveRoleplayEvents(next);
  }

  useEffect(() => {
    const shell = shellRef.current;
    if (!shell) return undefined;
    const updateCompact = () => {
      const width = shell.getBoundingClientRect().width;
      const nextCompact = width > 0 && width <= 680;
      setIsCompact(nextCompact);
      if (nextCompact && !wasCompactRef.current) {
        setShowSidebar(false);
      }
      wasCompactRef.current = nextCompact;
    };
    updateCompact();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', updateCompact);
      return () => window.removeEventListener('resize', updateCompact);
    }
    const observer = new ResizeObserver(updateCompact);
    observer.observe(shell);
    return () => observer.disconnect();
  }, []);

  // ====== Load threads on mount ======
  useEffect(() => {
    installRecentRendererLogCapture();
    loadThreads(currentNovelId);
    mana?.config?.getApp?.()
      .then((cfg) => setRoleplayChatVisibility(cfg?.writing?.roleplayChatVisibility || 'compact'))
      .catch(() => {});
    const onOnline = () => setIsOnline(true);
    const onOffline = () => setIsOnline(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ====== Auto-switch threads when novel changes ======
  const currentNovelId = editorContext?.novelId || null;
  useEffect(() => { currentNovelIdRef.current = currentNovelId; }, [currentNovelId]);

  const reloadActiveThread = useCallback(async (threadId = activeThreadIdRef.current) => {
    if (!threadId || !mana?.chatHistory) return;
    try {
      const thread = await mana.chatHistory.getThread(threadId);
      if (thread?.branch) {
        setMessages(expandThreadBranch(thread.branch));
      }
    } catch (err) {
      console.error('[AiChatPanel] reloadActiveThread failed', err);
    }
  }, [mana]);

  useEffect(() => {
    if (!mana?.chatHistory) return;
    if (status !== 'idle') return;
    if (!currentNovelId && (activeThreadId || sessionId)) {
      return;
    }
    let cancelled = false;
    const run = async () => {
      const list = await mana.chatHistory.listThreads(currentNovelId);
      if (cancelled) return;
      setThreads(list || []);
      // If active thread belongs to current novel, keep it; otherwise switch to first available
      const activeBelongs = activeThreadId && list?.some((t) => t.id === activeThreadId);
      if (!activeBelongs) {
        // Active novel state can briefly flicker to null while the app refreshes
        // workspace context. Do not clear the current conversation during that gap,
        // even if the last turn has just finished and status is already idle.
        if (!currentNovelId && (sessionId || activeThreadId)) {
          return;
        }
        if (list?.length > 0) {
          switchThread(list[0].id);
        } else {
          // No threads for this novel — close current session and clear UI
          if (sessionId && mana?.chatAgent) {
            try { await mana.chatAgent.closeSession(sessionId); } catch { /* ignore */ }
          }
          setActiveThreadId(null);
          setMessages([]);
          setError('');
          setThinkingText('');
          setEditingId(null);
          setPendingWriteChapter(null);
          setPendingCharacterProfileDecision(null);
          setPendingCharacterProfilePatch(null);
          setPendingRoleplayRiskDecision(null);
          resetLiveRoleplayEvents();
          setSessionId(null);
          sessionIdRef.current = null;
        }
      }
    };
    run();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentNovelId, status]);

  // ====== Sync editorContext to backend session when it changes ======
  const prevCtxRef = useRef(null);
  useEffect(() => {
    if (!sessionId || !mana?.chatAgent?.updateContext) return;
    const ctxStr = JSON.stringify(editorContext);
    if (prevCtxRef.current === ctxStr) return;
    prevCtxRef.current = ctxStr;
    mana.chatAgent.updateContext(sessionId, editorContext).catch(() => {});
  }, [sessionId, editorContext, mana]);

  // ====== Reload thread on screen unlock / visibility change ======
  // When the computer wakes from sleep, the renderer's in-memory state may
  // be stale. Reload the persisted thread from chat history to catch any
  // AI responses that were saved by the main process during sleep.
  useEffect(() => {
    const onVisibilityChange = async () => {
      if (document.visibilityState !== 'visible' || !activeThreadId || !mana?.chatHistory) return;
      try {
        await reloadActiveThread(activeThreadId);
      } catch (err) {
        console.error('[AiChatPanel] resume reload failed', err);
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, [activeThreadId, mana, reloadActiveThread]);

  async function loadThreads(novelId) {
    if (!mana?.chatHistory) return;
    try {
      const list = await mana.chatHistory.listThreads(novelId);
      setThreads(list || []);
    } catch (err) {
      console.error('[AiChatPanel] loadThreads failed', err);
    }
  }

  // ====== Create / switch thread ======
  async function createThread() {
    if (!mana?.chatHistory) return;
    if (isBusy) {
      setError('AI 正在回复中，请先停止生成或等待完成后再新建对话。');
      return;
    }
    try {
      const t = await mana.chatHistory.createThread({
        title: '新对话',
        novelId: editorContext?.novelId || null,
      });
      setThreads((prev) => [t, ...prev]);
      await switchThread(t.id);
    } catch (err) {
      setError(err?.message || String(err));
    }
  }

  async function switchThread(threadId) {
    if (threadId === activeThreadId) {
      if (isCompact) {
        setShowSidebar(false);
      }
      return;
    }
    if (isBusy) {
      setError('AI 正在回复中，请先停止生成或等待完成后再切换对话。');
      return;
    }
    // Close old session
    if (sessionId && mana?.chatAgent) {
      try { await mana.chatAgent.closeSession(sessionId); } catch { /* ignore */ }
    }
    setActiveThreadId(threadId);
    activeThreadIdRef.current = threadId;
    setMessages([]);
    setError('');
    setThinkingText('');
    setEditingId(null);
    setPendingWriteChapter(null);
    setPendingCharacterProfileDecision(null);
    setPendingCharacterProfilePatch(null);
    setPendingRoleplayRiskDecision(null);
    resetLiveRoleplayEvents();
    if (isCompact) {
      setShowSidebar(false);
    }

    if (!threadId || !mana?.chatHistory) return;

    let localMsgs = [];

    try {
      const thread = await mana.chatHistory.getThread(threadId);
      if (thread?.branch) {
        localMsgs = expandThreadBranch(thread.branch);
        setMessages(localMsgs);
      }
    } catch (err) {
      console.error('[AiChatPanel] switchThread failed', err);
    }

    // Create new chat agent session for this thread
    if (mana?.chatAgent?.createSession) {
      try {
        const r = await mana.chatAgent.createSession({ editorContext, messages: localMsgs, threadId });
        sessionIdRef.current = r.sessionId;
        setSessionId(r.sessionId);
      } catch (err) {
        setError(err?.message || String(err));
      }
    }
  }

  async function deleteThread(e, threadId) {
    e?.stopPropagation?.();
    if (!mana?.chatHistory) return;
    if (threadId === activeThreadId && isBusy) {
      setError('AI 正在回复中，请先停止生成或等待完成后再删除当前对话。');
      return;
    }
    const ok = window.confirm('确定要删除这个对话吗？');
    if (!ok) return;
    try {
      await mana.chatHistory.deleteThread(threadId);
      const remainingThreads = threads.filter((t) => t.id !== threadId);
      setThreads(remainingThreads);
      if (activeThreadId === threadId) {
        if (sessionId && mana?.chatAgent) {
          try { await mana.chatAgent.closeSession(sessionId); } catch { /* ignore */ }
        }
        setSessionId(null);
        sessionIdRef.current = null;
        setActiveThreadId(null);
        setMessages([]);
        setError('');
        setThinkingText('');
        setEditingId(null);
        setPendingRoleplayRiskDecision(null);
        resetLiveRoleplayEvents();
        if (remainingThreads.length > 0) {
          await switchThread(remainingThreads[0].id);
        }
      }
    } catch (err) {
      setError(err?.message || String(err));
    }
  }

  async function renameThread(threadId, currentTitle) {
    if (!mana?.chatHistory) return;
    const newTitle = await window.mana.prompt.show('重命名对话:', currentTitle);
    if (newTitle == null || newTitle.trim() === '') return;
    try {
      await mana.chatHistory.renameThread(threadId, newTitle.trim());
      setThreads((prev) =>
        prev.map((t) => (t.id === threadId ? { ...t, title: newTitle.trim() } : t))
      );
    } catch (err) {
      setError(err?.message || String(err));
    }
  }

  function ensureChatEventSubscription() {
    if (!mana?.chatAgent?.onEvent || offEventRef.current) return;
    const off = mana.chatAgent.onEvent((payload) => {
      if (!payload) return;
      if (payload.sessionId === sessionIdRef.current) {
        handleEventRef.current?.(payload);
        return;
      }
      if (payload.threadId && payload.threadId === activeThreadIdRef.current) {
        handleRemoteThreadEventRef.current?.(payload);
      }
    });
    offEventRef.current = off;
  }

  const offHistoryEventRef = useRef(null);

  function ensureChatHistoryEventSubscription() {
    if (!mana?.runtime?.on || offHistoryEventRef.current) return;
    const off = mana.runtime.on('chatHistory:changed', async (payload) => {
      if (!payload?.threadId) return;
      const novelMatches = payload.novelId === currentNovelIdRef.current || (!payload.novelId && !currentNovelIdRef.current);
      if (novelMatches) {
        await loadThreads(currentNovelIdRef.current);
      }
      if (payload.type === 'create' && novelMatches && !activeThreadIdRef.current) {
        await switchThread(payload.threadId);
        return;
      }
      if (payload.type === 'delete' && payload.threadId === activeThreadIdRef.current) {
        setActiveThreadId(null);
        activeThreadIdRef.current = null;
        setMessages([]);
        setStatus('idle');
        setThinkingText('');
        setPendingRoleplayRiskDecision(null);
        resetLiveRoleplayEvents();
        return;
      }
      if (payload.threadId === activeThreadIdRef.current) {
        await reloadActiveThread(payload.threadId);
      }
    });
    offHistoryEventRef.current = off;
  }

  // ====== Chat agent events ======
  useEffect(() => {
    ensureChatEventSubscription();
    ensureChatHistoryEventSubscription();
    return () => {
      try { offEventRef.current?.(); } catch { /* ignore */ }
      offEventRef.current = null;
      try { offHistoryEventRef.current?.(); } catch { /* ignore */ }
      offHistoryEventRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mana, reloadActiveThread]);

  // ====== Persist messages to backend ======
  async function persistMessage(message, threadIdOverride) {
    const tid = threadIdOverride || activeThreadId;
    if (!tid || !mana?.chatHistory) return;
    try {
      await mana.chatHistory.appendMessage(tid, message);
    } catch (err) {
      console.error('[AiChatPanel] persistMessage failed', err);
    }
  }

  const handleEvent = useCallback((ev) => {
    switch (ev.kind) {
      case 'turn_start':
        setStatus('thinking');
        setThinkingText('');
        setProgressItems([]);
        resetLiveRoleplayEvents();
        setAutoFollow(true);
        setShowJumpToBottom(false);
        setShowSidebar(false);
        setError('');
        break;
      case 'text_delta':
        setStatus('streaming');
        setMessages((prev) => {
          const delta = typeof ev.data?.delta === 'string' ? ev.data.delta
            : ev.data?.delta != null ? String(ev.data.delta)
            : '';
          if (!delta) return prev;
          const last = prev[prev.length - 1];
          if (last && last.role === 'assistant' && last.isStreaming) {
            const next = [...prev];
            next[next.length - 1] = { ...last, text: last.text + delta };
            return next;
          }
          const newMsg = {
            id: `msg-${Date.now()}`,
            role: 'assistant',
            text: delta,
            timestamp: Date.now(),
            isStreaming: true,
            edited: false,
            toolCalls: null,
          };
          return [...prev, newMsg];
        });
        break;
      case 'thinking_delta':
        setThinkingText((t) => t + (ev.data.delta || ''));
        if (activeExecutionTraceIdRef.current) {
          const traceId = activeExecutionTraceIdRef.current;
          setThinkingByTraceId((prev) => ({ ...prev, [traceId]: (prev[traceId] || '') + (ev.data?.delta || '') }));
        }
        break;
      case 'execution_trace_update': {
        const update = ev.data || {};
        if (!update.traceId || !update.trace) break;
        activeExecutionTraceIdRef.current = update.traceId;
        setLiveExecutionState((current) => {
          if (current?.traceId === update.traceId && Number(current.revision) >= Number(update.revision)) return current;
          return { traceId: update.traceId, revision: Number(update.revision) || 0, trace: update.trace };
        });
        break;
      }
      case 'progress':
        setStatus((current) => (current === 'idle' ? 'thinking' : current));
        setProgressItems((prev) => {
          const text = typeof ev.data?.message === 'string' ? ev.data.message.trim() : '';
          if (!text) return prev;
          return [
            ...prev.slice(-11),
            {
              id: `${Date.now()}-${prev.length}`,
              text,
              stage: ev.data?.stage || '',
              timestamp: Date.now(),
            },
          ];
        });
        break;
      case 'roleplay_event':
        setStatus((current) => (current === 'idle' ? 'thinking' : current));
        appendLiveRoleplayEvent(ev.data);
        break;
      case 'tool_use': {
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last && last.role === 'assistant' && last.isStreaming) {
            const next = [...prev];
            next[next.length - 1] = { ...last, isStreaming: false };
            return appendToolUseMessage(next, ev.data, Date.now());
          }
          return appendToolUseMessage(prev, ev.data, Date.now());
        });
        break;
      }
      case 'tool_result':
        setMessages((prev) => applyToolResultMessage(prev, ev.data, Date.now()));
        break;
      case 'frontend_action':
        handleFrontendAction(ev.data);
        break;
      case 'turn_done': {
        setStatus('idle');
        const doneText = ev.data?.text || '';
        const harnessTrace = ev.data?.harnessTrace || null;
        const executionTrace = ev.data?.executionTrace || null;
        const roleplayEvents = Array.isArray(ev.data?.roleplayEvents) && ev.data.roleplayEvents.length
          ? ev.data.roleplayEvents
          : liveRoleplayEventsRef.current;
        setMessages((prev) => {
          const next = [...prev];
          const last = next[next.length - 1];
          if (last && last.role === 'assistant' && last.isStreaming) {
            if (doneText && (!last.text || doneText.length > last.text.length)) {
              next[next.length - 1] = { ...last, text: doneText, isStreaming: false, roleplayEvents, harnessTrace, executionTrace };
            } else {
              next[next.length - 1] = { ...last, isStreaming: false, roleplayEvents, harnessTrace, executionTrace };
            }
          } else if (doneText) {
            // 去重：visibilitychange 重新加载后，消息可能已在历史中
            const alreadyExists = prev.some(
              (m) => m.role === 'assistant' && !m.isStreaming && m.text === doneText
            );
            if (!alreadyExists) {
              next.push({
                id: `msg-${Date.now()}`,
                role: 'assistant',
                text: doneText,
                isStreaming: false,
                timestamp: Date.now(),
                edited: false,
                toolCalls: null,
                roleplayEvents,
                harnessTrace,
                executionTrace,
              });
            }
          } else if (roleplayEvents.length || executionTrace) {
            next.push({
              id: `msg-${Date.now()}`,
              role: 'assistant',
              text: '',
              isStreaming: false,
              timestamp: Date.now(),
              edited: false,
              toolCalls: null,
              roleplayEvents,
              harnessTrace,
              executionTrace,
            });
          }
          return next;
        });
        setLiveExecutionState(null);
        // 主进程 await 持久化 turn_done，渲染进程不再重复写
        break;
      }
      case 'error': {
        let finalizedMsg = null;
        setStatus('idle');
        setError(ev.data.message || 'Unknown error');
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last && last.role === 'assistant' && last.isStreaming) {
            const next = [...prev];
            next[next.length - 1] = { ...last, isStreaming: false };
            finalizedMsg = next[next.length - 1];
            return next;
          }
          return prev;
        });
        if (finalizedMsg) persistMessage(finalizedMsg);
        break;
      }
      case 'awaiting_write_chapter_confirmation':
        setPendingWriteChapter(ev.data || null);
        setRejectReason('');
        break;
      case 'write_chapter_resolved':
        if (!ev.data?.keepPending) {
          setPendingWriteChapter(null);
          setRejectReason('');
        }
        break;
      case 'awaiting_character_profile_decision':
        setPendingCharacterProfileDecision(ev.data || null);
        setPendingCharacterProfilePatch(null);
        break;
      case 'awaiting_character_profile_patch_confirmation':
        setPendingCharacterProfilePatch(ev.data || null);
        break;
      case 'character_profile_gate_resolved':
        setPendingCharacterProfileDecision(null);
        setPendingCharacterProfilePatch(null);
        break;
      case 'character_profile_patch_resolved':
        setPendingCharacterProfilePatch(null);
        break;
      case 'awaiting_roleplay_risk_decision':
        setPendingRoleplayRiskDecision(ev.data || null);
        break;
      case 'roleplay_risk_resolved':
        setPendingRoleplayRiskDecision(null);
        break;
      default:
        break;
    }
  }, [activeThreadId, sessionId]);

  const handleRemoteThreadEvent = useCallback((ev) => {
    switch (ev.kind) {
      case 'turn_start':
        setStatus('thinking');
        setThinkingText('');
        setProgressItems([]);
        resetLiveRoleplayEvents();
        setAutoFollow(true);
        setShowJumpToBottom(false);
        setError('');
        break;
      case 'text_delta':
        setStatus('streaming');
        setMessages((prev) => {
          const delta = typeof ev.data?.delta === 'string' ? ev.data.delta
            : ev.data?.delta != null ? String(ev.data.delta)
            : '';
          if (!delta) return prev;
          const last = prev[prev.length - 1];
          if (last && last.role === 'assistant' && last.isStreaming) {
            const next = [...prev];
            next[next.length - 1] = { ...last, text: last.text + delta };
            return next;
          }
          return [
            ...prev,
            {
              id: `remote-msg-${Date.now()}`,
              role: 'assistant',
              text: delta,
              timestamp: Date.now(),
              isStreaming: true,
              edited: false,
              toolCalls: null,
            },
          ];
        });
        break;
      case 'thinking_delta':
        setThinkingText((t) => t + (ev.data?.delta || ''));
        if (activeExecutionTraceIdRef.current) {
          const traceId = activeExecutionTraceIdRef.current;
          setThinkingByTraceId((prev) => ({ ...prev, [traceId]: (prev[traceId] || '') + (ev.data?.delta || '') }));
        }
        break;
      case 'execution_trace_update': {
        const update = ev.data || {};
        if (!update.traceId || !update.trace) break;
        activeExecutionTraceIdRef.current = update.traceId;
        setLiveExecutionState((current) => {
          if (current?.traceId === update.traceId && Number(current.revision) >= Number(update.revision)) return current;
          return { traceId: update.traceId, revision: Number(update.revision) || 0, trace: update.trace };
        });
        break;
      }
      case 'progress':
        setStatus((current) => (current === 'idle' ? 'thinking' : current));
        setProgressItems((prev) => {
          const text = typeof ev.data?.message === 'string' ? ev.data.message.trim() : '';
          if (!text) return prev;
          return [
            ...prev.slice(-11),
            {
              id: `remote-${Date.now()}-${prev.length}`,
              text,
              stage: ev.data?.stage || '',
              timestamp: Date.now(),
            },
          ];
        });
        break;
      case 'roleplay_event':
        setStatus((current) => (current === 'idle' ? 'thinking' : current));
        appendLiveRoleplayEvent(ev.data);
        break;
      case 'tool_use':
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last && last.role === 'assistant' && last.isStreaming) {
            const next = [...prev];
            next[next.length - 1] = { ...last, isStreaming: false };
            return appendToolUseMessage(next, ev.data, Date.now());
          }
          return appendToolUseMessage(prev, ev.data, Date.now());
        });
        break;
      case 'tool_result':
        setMessages((prev) => applyToolResultMessage(prev, ev.data, Date.now()));
        break;
      case 'turn_done':
        setStatus('idle');
        setLiveExecutionState(null);
        reloadActiveThread(ev.threadId).catch(() => {});
        break;
      case 'error':
        setStatus('idle');
        setError(ev.data?.message || 'Unknown error');
        reloadActiveThread(ev.threadId).catch(() => {});
        break;
      case 'awaiting_write_chapter_confirmation':
        setPendingWriteChapter(ev.data || null);
        setRejectReason('');
        break;
      case 'write_chapter_resolved':
        if (!ev.data?.keepPending) {
          setPendingWriteChapter(null);
          setRejectReason('');
        }
        break;
      case 'awaiting_character_profile_decision':
        setPendingCharacterProfileDecision(ev.data || null);
        setPendingCharacterProfilePatch(null);
        break;
      case 'awaiting_character_profile_patch_confirmation':
        setPendingCharacterProfilePatch(ev.data || null);
        break;
      case 'character_profile_gate_resolved':
        setPendingCharacterProfileDecision(null);
        setPendingCharacterProfilePatch(null);
        break;
      case 'character_profile_patch_resolved':
        setPendingCharacterProfilePatch(null);
        break;
      case 'awaiting_roleplay_risk_decision':
        setPendingRoleplayRiskDecision(ev.data || null);
        break;
      case 'roleplay_risk_resolved':
        setPendingRoleplayRiskDecision(null);
        break;
      default:
        break;
    }
  }, [reloadActiveThread]);

  // Keep handleEventRef.current up-to-date for the subscription useEffect
  handleEventRef.current = handleEvent;
  handleRemoteThreadEventRef.current = handleRemoteThreadEvent;

  const handleFrontendAction = useCallback(async (data) => {
    const { actionId, name, input: actionInput } = data;
    let result = '';
    let isError = false;
    try {
      if (name === 'replace_selected_text' && onReplaceRef.current) {
        result = await onReplaceRef.current(actionInput.replacement || '', actionInput) || 'Text replaced successfully';
      } else if (name === 'replace_text_near_cursor' && onReplaceNearCursorRef.current) {
        result = await onReplaceNearCursorRef.current(actionInput.targetText || '', actionInput.replacement || '', actionInput) || 'Text replaced near cursor successfully';
      } else if (name === 'insert_text_at_cursor' && onInsertRef.current) {
        result = await onInsertRef.current(actionInput.text || '', actionInput) || 'Text inserted successfully';
      } else if (name === 'get_full_editor_content') {
        result = editorContextRef.current?.content || '';
      } else {
        result = `Unsupported frontend action: ${name}`;
        isError = true;
      }
    } catch (err) {
      result = `Frontend action failed: ${err?.message || String(err)}`;
      isError = true;
    }
    if (!isError && typeof result === 'string' && result.startsWith('Frontend action failed:')) {
      isError = true;
    }
    const currentSessionId = sessionIdRef.current;
    if (mana?.chatAgent?.resolveAction && currentSessionId) {
      mana.chatAgent.resolveAction(currentSessionId, actionId, { text: result, isError }).catch(() => {});
    }
  }, [mana]);

  // ====== Send message ======
  const sendMessage = useCallback(async () => {
    const rawInput = typeof input === 'string' ? input : String(input ?? '');
    const trimmed = rawInput.trim();
    if (!trimmed) return;

    if (typeof onBeforeSendMessage === 'function') {
      try {
        await onBeforeSendMessage();
      } catch (err) {
        setError(err?.message || String(err));
        setStatus('idle');
        return;
      }
    }

    // Ensure we have an active thread
    let currentThreadId = activeThreadId;
    let currentSessionId = sessionId;
    if (!currentThreadId) {
      if (!mana?.chatHistory) return;
      try {
        const t = await mana.chatHistory.createThread({
          title: trimmed.slice(0, 30) || '新对话',
          novelId: editorContext?.novelId || null,
        });
        setThreads((prev) => [t, ...prev]);
        currentThreadId = t.id;
        setActiveThreadId(t.id);
        activeThreadIdRef.current = t.id;
        // Create session
        if (mana?.chatAgent?.createSession) {
          const r = await mana.chatAgent.createSession({ editorContext, messages: [], threadId: currentThreadId });
          sessionIdRef.current = r.sessionId;
          setSessionId(r.sessionId);
          currentSessionId = r.sessionId;
        }
      } catch (err) {
        setError(err?.message || String(err));
        return;
      }
    }

    if (!currentSessionId || status !== 'idle') return;

    setError('');
    setInput('');
    setShowSidebar(false);

    const userMsg = {
      id: `msg-${Date.now()}`,
      role: 'user',
      text: trimmed,
      timestamp: Date.now(),
      edited: false,
      toolCalls: null,
      isStreaming: false,
    };
    setMessages((prev) => [...prev, userMsg]);
    await persistMessage(userMsg, currentThreadId);

    try {
      ensureChatEventSubscription();
      await mana.chatAgent.sendMessage(currentSessionId, trimmed);
    } catch (err) {
      const msg = err?.message || String(err);
      setError(msg);
      setStatus('idle');
    }
  }, [input, activeThreadId, sessionId, status, mana, editorContext, onBeforeSendMessage]);

  const cancelGeneration = useCallback(() => {
    if (sessionId && mana?.chatAgent?.cancel) {
      mana.chatAgent.cancel(sessionId).catch(() => {});
    }
    setStatus('idle');
  }, [sessionId, mana]);

  const handleKeyDown = useCallback(
    (e) => {
      if (e.key !== 'Enter' || e.isComposing) return;
      const isMac = navigator.platform.toLowerCase().includes('mac');
      const modifier = isMac ? e.metaKey : e.ctrlKey;
      if (modifier) {
        e.preventDefault();
        sendMessage();
      }
    },
    [sendMessage]
  );

  // ====== Edit message ======
  function startEdit(msg) {
    if (msg.role !== 'assistant') return;
    setEditingId(msg.id);
    setEditText(msg.text);
  }

  async function saveEdit(msgId) {
    if (!activeThreadId || !mana?.chatHistory) return;
    const text = editText.trim();
    if (!text) return;
    try {
      await mana.chatHistory.editMessage(activeThreadId, msgId, text);
      setMessages((prev) =>
        prev.map((m) => (m.id === msgId ? { ...m, text, edited: true, editedAt: new Date().toISOString() } : m))
      );
    } catch (err) {
      setError(err?.message || String(err));
    }
    setEditingId(null);
    setEditText('');
  }

  function cancelEdit() {
    setEditingId(null);
    setEditText('');
  }

  // ====== Revert to node ======
  async function revertToNode(msgId) {
    if (!activeThreadId || !mana?.chatHistory) return;
    const ok = window.confirm('确定要回退到这句对话之前吗？这句及之后的消息将被删除。');
    if (!ok) return;
    let localMsgs = [];
    try {
      setError('');
      const thread = await mana.chatHistory.revertToNode(activeThreadId, msgId);
      if (thread?.branch) {
        localMsgs = expandThreadBranch(thread.branch);
        setMessages(localMsgs);
      }
      // Also close and recreate agent session
      if (sessionId && mana?.chatAgent) {
        try { await mana.chatAgent.closeSession(sessionId); } catch { /* ignore */ }
      }
      if (mana?.chatAgent?.createSession) {
        const r = await mana.chatAgent.createSession({ editorContext, messages: localMsgs, threadId: activeThreadId });
        sessionIdRef.current = r.sessionId;
        setSessionId(r.sessionId);
      }
      setStatus('idle');
      setThinkingText('');
    } catch (err) {
      setError(err?.message || String(err));
    }
  }

  // ====== Auto-scroll ======
  const handleMessageScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const nearBottom = distanceFromBottom <= 80;
    setAutoFollow(nearBottom);
    setShowJumpToBottom(!nearBottom);
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || !autoFollow) return;
    // Delay scroll until browser has finished layout so scrollHeight is accurate
    const raf = requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
      setShowJumpToBottom(false);
    });
    return () => cancelAnimationFrame(raf);
  }, [messages, thinkingText, progressItems, autoFollow]);

  const jumpToBottom = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    setAutoFollow(true);
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
      setShowJumpToBottom(false);
    });
  }, []);

  const isBusy = status === 'thinking' || status === 'streaming';
  const activeThread = threads.find((t) => t.id === activeThreadId);

  function openFeedbackModal() {
    setFeedbackTitle(activeThread?.title ? `AI 聊天反馈：${activeThread.title}` : 'AI 聊天问题反馈');
    setFeedbackDescription('');
    setFeedbackIncludeLogs(true);
    setFeedbackIncludeScreenshot(false);
    setShowFeedbackModal(true);
  }

  function closeFeedbackModal() {
    if (feedbackSubmitting) return;
    setShowFeedbackModal(false);
  }

  async function submitQuickFeedback() {
    if (!mana?.feedback?.submit) {
      setError('当前环境未启用反馈提交功能');
      return;
    }

    const issueTitle = (feedbackTitle || '').trim() || 'AI 聊天问题反馈';
    const actualBehavior = (feedbackDescription || '').trim();
    setFeedbackSubmitting(true);
    try {
      let runtimeDriver = '';
      let model = '';
      let providerType = '';
      try {
        const active = await mana.runtime?.getActiveDriver?.();
        runtimeDriver = active?.id || active || '';
      } catch {}
      try {
        const [target] = await mana.modelConfig?.resolvePreview?.({
          driverId: runtimeDriver || 'direct-api',
          systemTask: 'chat',
        });
        model = target?.modelId || '';
        providerType = target?.providerId || runtimeDriver || '';
      } catch {}

      const payload = buildQuickFeedbackPayload({
        issueTitle,
        actualBehavior,
        expectedBehavior: '',
        reproductionSteps: [],
        reproMode: 'unknown',
        severity: 'medium',
        includeLogs: feedbackIncludeLogs,
        currentNovelId: editorContextRef.current?.novelId || editorContext?.novelId || '',
        editorContext: editorContextRef.current || editorContext,
        activeThread,
        sessionId,
        messages,
        status,
        uiError: error,
        runtimeDriver,
        providerType,
        model,
        recentRendererLogs: getRecentRendererLogs(20),
        includeScreenshot: feedbackIncludeScreenshot,
      });

      const result = await mana.feedback.submit(payload, {
        includeScreenshot: feedbackIncludeScreenshot,
      });
      const parts = [];
      if (feedbackIncludeLogs) parts.push('含聊天上下文');
      if (feedbackIncludeScreenshot) parts.push('截图');
      const scope = parts.length ? `（${parts.join('、')}）` : '（仅意见）';
      setFeedbackNotice({
        type: 'success',
        text: `反馈已保存${scope}。ID: ${result.feedbackId}`,
      });
      setShowFeedbackModal(false);
    } catch (err) {
      const msg = err?.message || String(err);
      setFeedbackNotice({ type: 'error', text: `网络异常，反馈失败：${msg}` });
      setError(msg);
    } finally {
      setFeedbackSubmitting(false);
    }
  }

  function countLineChanges(beforeContent, afterContent) {
    const beforeLines = String(beforeContent || '').split(/\r?\n/);
    const afterLines = String(afterContent || '').split(/\r?\n/);
    const max = Math.max(beforeLines.length, afterLines.length);
    let added = 0;
    let removed = 0;
    for (let index = 0; index < max; index += 1) {
      const beforeLine = beforeLines[index];
      const afterLine = afterLines[index];
      if (beforeLine === afterLine) continue;
      if (beforeLine !== undefined) removed += 1;
      if (afterLine !== undefined) added += 1;
    }
    return { added, removed };
  }

  function buildChangeKey(messageId, file) {
    return `${messageId}:${file?.novelId || ''}:${file?.chapterName || ''}`;
  }

  async function restoreChangedFile(messageId, file) {
    if (!file?.novelId || !file?.chapterName || !mana?.novel) return;
    const ok = window.confirm(`确定撤销对 ${file.label || file.chapterName} 的本次修改吗？`);
    if (!ok) return;
    const key = buildChangeKey(messageId, file);
    try {
      setError('');
      if (file.restoreMode === 'delete') {
        await mana.novel.deleteChapter(file.novelId, file.chapterName);
      } else {
        await mana.novel.saveChapter(
          file.novelId,
          file.chapterName,
          file.beforeContent || '',
          file.beforeMetadata || undefined
        );
      }
      setRestoredChanges((prev) => ({ ...prev, [key]: true }));
    } catch (err) {
      setError(err?.message || String(err));
    }
  }

  function profileFieldLabel(field) {
    const labels = {
      personality: '性格',
      speechStyle: '语言风格',
      appearance: '外貌',
      relationships: '关系',
      storyArc: '角色弧线',
      characterMemory: '角色记忆',
    };
    return labels[field] || field;
  }

  function profilePatchPreview(patch) {
    try {
      return JSON.stringify(patch || {}, null, 2);
    } catch {
      return String(patch || '');
    }
  }

  function roleplayRiskPreview(decision) {
    const scenes = Array.isArray(decision?.riskyScenes) ? decision.riskyScenes : [];
    if (!scenes.length) return '导演发现角色反应可能偏离大纲，等待你选择下一步。';
    return scenes.slice(0, 3).map((scene, index) => {
      const risks = Array.isArray(scene.remainingRisks) ? scene.remainingRisks : [];
      const riskText = risks.map((risk) => typeof risk === 'string' ? risk : (risk?.note || risk?.type || '')).filter(Boolean).slice(0, 2).join('；');
      return `${index + 1}. ${scene.title || scene.sceneId || '未命名场景'}：${riskText || scene.outlineCompliance || '存在大纲风险'}`;
    }).join('\n');
  }

  function isRoleplayExpanded(key) {
    if (Object.prototype.hasOwnProperty.call(expandedRoleplay, key)) {
      return !!expandedRoleplay[key];
    }
    return roleplayChatVisibility === 'detailed';
  }

  const latestExecutionMessage = [...messages].reverse().find((message) => message.role === 'assistant' && message.executionTrace) || null;
  const hasPendingExecutionDecision = !!(
    pendingWriteChapter
    || pendingRoleplayRiskDecision
    || pendingCharacterProfileDecision
    || pendingCharacterProfilePatch
  );
  const hasInlineDecisionTrace = hasPendingExecutionDecision && !!(liveExecutionState?.trace || latestExecutionMessage?.executionTrace);

  function renderExecutionDecisionPanel() {
    if (pendingWriteChapter) {
      return (
        <div data-testid="chapter-mutation-decision" className="rounded-xl border border-amber-500/25 bg-amber-500/10 p-2.5 text-[11px]">
          <div className="font-semibold text-amber-200">章节变更确认 · {pendingWriteChapter.title || pendingWriteChapter.name || '未命名章节'}</div>
          <div className={pendingWriteChapter.verificationStatus === 'passed' ? 'mt-1 text-emerald-200' : 'mt-1 text-rose-200'}>严格验证：{pendingWriteChapter.verificationStatus === 'passed' ? '已通过，可以确认提交。' : '未通过，草稿已保留但禁止写入。'}</div>
          {pendingWriteChapter.contentPreview && <details className="mt-1 rounded bg-black/20 px-2 py-1"><summary className="cursor-pointer text-gray-300">查看变更正文预览</summary><pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap text-gray-400">{pendingWriteChapter.contentPreview}</pre></details>}
          {Array.isArray(pendingWriteChapter.blockingIssues) && pendingWriteChapter.blockingIssues.slice(0, 4).map((issue, index) => <div key={`inline-blocking-${index}`} className="mt-1 text-rose-200">- {issue}</div>)}
          <div className="mt-2 flex flex-wrap gap-1.5">
            <button type="button" className="rounded bg-emerald-600 px-2.5 py-1 font-semibold text-white disabled:opacity-40" disabled={pendingWriteChapter.verificationStatus !== 'passed'} onClick={() => setInput('确认写入这一章')}>确认写入</button>
            {pendingWriteChapter.warning && pendingWriteChapter.verificationStatus === 'passed' && <button type="button" className="rounded bg-amber-700 px-2.5 py-1 text-white" onClick={() => setInput('覆盖写入')}>覆盖写入</button>}
            <button type="button" className="rounded bg-gray-600 px-2.5 py-1 text-gray-100" onClick={() => setInput('拒绝写入')}>拒绝</button>
            <button type="button" className="rounded bg-rose-800/70 px-2.5 py-1 text-rose-100" onClick={() => setInput('拒绝写入，理由是：')}>拒绝并说明</button>
          </div>
        </div>
      );
    }
    if (pendingRoleplayRiskDecision) {
      return (
        <div className="rounded-xl border border-amber-500/25 bg-amber-500/10 p-2.5 text-[11px]">
          <div className="font-semibold text-amber-200">角色与大纲存在张力</div>
          <div className="mt-1 text-gray-300">{pendingRoleplayRiskDecision.title || pendingRoleplayRiskDecision.chapterRef || '当前章节'} 已暂停：{roleplayRiskPreview(pendingRoleplayRiskDecision)}</div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <button type="button" className="rounded bg-emerald-600 px-2.5 py-1 font-semibold text-white" onClick={() => setInput('保大纲继续')}>保大纲继续</button>
            <button type="button" className="rounded bg-sky-700 px-2.5 py-1 text-white" onClick={() => setInput('按角色方向调整大纲建议')}>调整大纲建议</button>
            <button type="button" className="rounded bg-gray-600 px-2.5 py-1 text-gray-100" onClick={() => setInput('跳过角色驱动继续')}>跳过角色驱动</button>
            <button type="button" className="rounded bg-rose-800/70 px-2.5 py-1 text-rose-100" onClick={() => setInput('取消本轮')}>取消本轮</button>
          </div>
        </div>
      );
    }
    if (pendingCharacterProfilePatch) {
      return (
        <div className="rounded-xl border border-cyan-500/20 bg-cyan-500/10 p-2.5 text-[11px]">
          <div className="font-semibold text-cyan-200">角色资料补全建议</div>
          <div className="mt-1 text-gray-300">角色卡 {(pendingCharacterProfilePatch.characterPatches || []).length} 项，记忆 {(pendingCharacterProfilePatch.memoryPatches || []).length} 项。</div>
          <div className="mt-2 flex flex-wrap gap-1.5"><button type="button" className="rounded bg-emerald-600 px-2.5 py-1 text-white" onClick={() => setInput('确认应用角色资料补全')}>确认应用</button><button type="button" className="rounded bg-rose-800/70 px-2.5 py-1 text-rose-100" onClick={() => setInput('拒绝角色资料补全')}>拒绝</button><button type="button" className="rounded bg-gray-600 px-2.5 py-1 text-gray-100" onClick={() => setInput('忽略角色资料不足并继续写')}>忽略继续</button></div>
        </div>
      );
    }
    if (pendingCharacterProfileDecision) {
      return (
        <div className="rounded-xl border border-sky-500/20 bg-sky-500/10 p-2.5 text-[11px]">
          <div className="font-semibold text-sky-200">角色资料不足</div>
          <div className="mt-1 text-gray-300">{(pendingCharacterProfileDecision.missingCharacters || []).map((item) => item.name || item.id).filter(Boolean).slice(0, 6).join('、') || '关键角色资料需要补全。'}</div>
          <div className="mt-2 flex flex-wrap gap-1.5"><button type="button" className="rounded bg-sky-600 px-2.5 py-1 text-white" onClick={() => setInput('自动补全角色资料')}>自动补全</button><button type="button" className="rounded bg-gray-600 px-2.5 py-1 text-gray-100" onClick={() => setInput('忽略角色资料不足并继续写')}>忽略继续</button></div>
        </div>
      );
    }
    return null;
  }

  return (
      <div
        ref={shellRef}
        className="mana-chat-shell flex h-full text-[13px]"
        data-testid="chat-shell"
        data-compact={isCompact ? 'true' : 'false'}
        data-compact-sidebar={isCompact && showSidebar ? 'true' : 'false'}
      >
      {/* Sidebar — thread list */}
      {showSidebar && (
        <div className="mana-chat-sidebar w-64 border-r border-white/10 flex flex-col shrink-0">
          <div className="h-12 border-b border-white/10 flex items-center px-3 justify-between shrink-0">
            <div>
              <div className="text-xs font-bold text-gray-200">对话历史</div>
              <div className="text-[10px] text-gray-500">写作链路与审查记录</div>
            </div>
            <button
              type="button"
              className="rounded-lg border border-white/10 bg-white/5 text-gray-300 hover:text-white hover:bg-white/10 p-1.5"
              onClick={createThread}
              title="新建对话"
            >
              <Plus size={14} />
            </button>
          </div>
          <div className="mana-chat-scroll flex-1 overflow-y-auto p-2">
            {threads.length === 0 && (
              <div className="rounded-xl border border-dashed border-white/10 px-3 py-4 text-xs text-gray-500">暂无对话</div>
            )}
            {threads.map((t) => (
              <div
                key={t.id}
                className={`mana-chat-thread-item group mb-1 flex items-center gap-2 rounded-xl px-3 py-2.5 cursor-pointer text-xs ${
                  t.id === activeThreadId ? 'mana-chat-thread-item-active text-white' : 'text-gray-300'
                }`}
                onClick={() => switchThread(t.id)}
              >
                <MessageSquare size={13} className="shrink-0 text-sky-300/80" />
                <span className="flex-1 truncate">{t.title}</span>
                <div className="hidden group-hover:flex items-center gap-1">
                  <button
                    type="button"
                    className="text-gray-400 hover:text-white p-0.5"
                    onClick={(e) => { e.stopPropagation(); renameThread(t.id, t.title); }}
                    title="重命名"
                  >
                    <Edit3 size={10} />
                  </button>
                  <button
                    type="button"
                    className="text-gray-400 hover:text-rose-400 p-0.5"
                    onClick={(e) => deleteThread(e, t.id)}
                    title="删除"
                  >
                    <Trash2 size={10} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Main chat area */}
      <div className={`relative flex-1 flex-col h-full min-w-0 ${isCompact && showSidebar ? 'hidden' : 'flex'}`}>
        {/* Toolbar */}
        <div className="mana-chat-toolbar h-12 flex items-center px-3 justify-between shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <button
              type="button"
              className="rounded-lg text-gray-400 hover:text-white hover:bg-white/10 p-1.5"
              onClick={() => setShowSidebar((v) => !v)}
              title={showSidebar ? '隐藏侧边栏' : '返回对话列表'}
              aria-label={showSidebar ? '隐藏侧边栏' : '返回对话列表'}
            >
              {showSidebar ? <ChevronLeft size={14} /> : <ChevronRight size={14} />}
            </button>
            <div className="min-w-0">
              <div className="text-sm font-semibold text-gray-100 truncate">{activeThread?.title || 'AI 助手'}</div>
              <div className="text-[10px] text-gray-500 truncate">{isBusy ? '正在执行写作任务' : '准备协作'}</div>
            </div>
            {activeThread?.edited && (
              <span className="text-[9px] text-gray-500">(已编辑)</span>
            )}
          </div>
          <div className="flex items-center gap-1">
            {!isOnline && (
              <span className="text-amber-400 text-[10px] flex items-center gap-0.5 mr-2">
                <WifiOff size={10} /> 离线
              </span>
            )}
            {thinkingText && (
              <button
                type="button"
                className="rounded-lg text-gray-500 hover:text-gray-300 hover:bg-white/10 text-[10px] px-1.5 py-1"
                onClick={() => setShowThinking((v) => !v)}
                title="显示/隐藏思维链"
              >
                <Brain size={12} />
              </button>
            )}
            <button
              type="button"
              className="rounded-lg text-gray-500 hover:text-gray-300 hover:bg-white/10 text-[10px] px-1.5 py-1 disabled:opacity-40"
              onClick={createThread}
              title="新建对话"
              disabled={isBusy}
            >
              <Plus size={12} />
            </button>
            {activeThreadId && (
              <button
                type="button"
                className="rounded-lg text-gray-500 hover:text-rose-400 hover:bg-rose-500/10 text-[10px] px-1.5 py-1 disabled:opacity-40"
                onClick={() => deleteThread({ stopPropagation: () => {} }, activeThreadId)}
                title="删除当前对话"
                disabled={isBusy}
              >
                <Trash2 size={12} />
              </button>
            )}
            <button
              type="button"
              className="rounded-lg text-emerald-400 hover:text-emerald-200 hover:bg-emerald-500/10 text-[10px] px-2 py-1 flex items-center gap-1"
              onClick={openFeedbackModal}
              title="反馈 AI 聊天问题"
              aria-label="一键反馈问题"
            >
              <AlertCircle size={12} />
              <span>一键反馈问题</span>
            </button>
          </div>
        </div>

        {/* Messages */}
        <div
          ref={containerRef}
          className="mana-chat-scroll flex-1 overflow-y-auto overflow-x-hidden px-4 py-5 space-y-4"
          data-testid="chat-message-scroll"
          onScroll={handleMessageScroll}
        >
          {messages.length === 0 && (
            <div className="flex gap-3 max-w-3xl">
              <div className="mana-chat-avatar mana-chat-avatar-bot">
                <Bot size={14} className="text-white" />
              </div>
              <div className="mana-chat-bubble mana-chat-bubble-assistant p-4 max-w-[min(42rem,88%)] text-sm text-gray-200">
                <div className="mb-1 text-xs font-semibold text-sky-200">AI 写作助手</div>
                <div className="mana-chat-prose">打开一篇文档后，我可以帮你读大纲、审查 AI 味、修改文本，或者调用专业子代理完成复杂任务。</div>
              </div>
            </div>
          )}

          {messages.map((m, idx) => {
            if (m.role === 'tool') {
              let coveredByExecutionTrace = Array.isArray(liveExecutionState?.trace?.tools)
                && liveExecutionState.trace.tools.some((tool) => tool.id === m.toolUseId);
              for (let cursor = idx + 1; cursor < messages.length; cursor += 1) {
                const candidate = messages[cursor];
                if (candidate?.role === 'user') break;
                if (candidate?.role === 'assistant'
                  && Array.isArray(candidate.executionTrace?.tools)
                  && candidate.executionTrace.tools.some((tool) => tool.id === m.toolUseId)) {
                  coveredByExecutionTrace = true;
                  break;
                }
              }
              if (coveredByExecutionTrace) return null;
              const resultMeta = m.status === 'done' && !m.isError ? parseToolResultMeta(m.result || '') : null;
              const rawResultText = typeof m.result === 'string' ? m.result : '';
              const resultPreviewText = resultMeta?.summary || rawResultText;
              const changedFiles = resultMeta?.changedFiles || [];
              const changedSummary = changedFiles.reduce(
                (acc, file) => {
                  const diff = countLineChanges(file.beforeContent, file.afterContent);
                  return { added: acc.added + diff.added, removed: acc.removed + diff.removed };
                },
                { added: 0, removed: 0 }
              );
              const changesOpen = !!expandedChanges[m.id];
              return (
                <div key={m.id || idx} className="flex gap-3 min-w-0 max-w-4xl">
                  <div className="mana-chat-avatar mana-chat-avatar-tool">
                    <Wrench size={12} className="text-white" />
                  </div>
                  <div className="mana-chat-bubble mana-chat-bubble-tool p-3 max-w-[min(46rem,88%)] min-w-0 break-words text-sm">
                    <div className="flex items-center gap-2 text-amber-300 text-xs font-semibold mb-2">
                      <span className={`h-2 w-2 rounded-full ${m.status === 'running' ? 'bg-amber-300 animate-pulse' : m.isError ? 'bg-rose-400' : 'bg-emerald-400'}`} />
                      {m.status === 'running' ? `调用: ${m.name}...` : `调用: ${m.name}`}
                    </div>
                    {(m.cached || m.modelContentTrimmed || m.sourceRef) && (
                      <div className="mb-2 flex flex-wrap gap-1 text-[9px] text-gray-400">
                        {m.cached && <span className="rounded bg-sky-500/10 px-1.5 py-0.5 text-sky-200">缓存命中</span>}
                        {m.modelContentTrimmed && <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-amber-200">模型上下文已裁剪 {m.modelLength}/{m.originalLength}</span>}
                        {m.sourceRef && <span className="rounded bg-black/20 px-1.5 py-0.5">{m.sourceRef}</span>}
                      </div>
                    )}
                    {m.input && expandedResults[m.id] && (
                      <pre className="rounded-lg bg-black/25 p-2 text-gray-400 text-[11px] overflow-x-hidden whitespace-pre-wrap break-words max-h-32 overflow-y-auto">
                        {JSON.stringify(m.input, null, 2)}
                      </pre>
                    )}
                    {m.status === 'done' && (
                      <div>
                        {expandedResults[m.id] ? (
                          <pre className="mt-2 rounded-lg bg-black/25 p-2 text-[11px] text-green-300 overflow-x-hidden whitespace-pre-wrap break-words max-h-60 overflow-y-auto">
                            {m.result}
                          </pre>
                        ) : (
                          <div className={`mt-1 rounded-lg px-2 py-1.5 text-[11px] leading-relaxed ${m.isError ? 'bg-rose-500/10 text-rose-300' : 'bg-emerald-500/10 text-emerald-300'}`}>
                            {m.isError
                              ? `错误: ${rawResultText.slice(0, 180)}`
                              : `结果预览: ${resultPreviewText.slice(0, 180)}${rawResultText.length > 180 ? '…（完整内容请点「查看详情」）' : ''}`}
                          </div>
                        )}
                        {(m.input || rawResultText.length > 180) && (
                          <button
                            type="button"
                            className="mt-2 rounded-md px-2 py-1 text-[10px] text-sky-300 hover:bg-sky-500/10 hover:text-sky-200"
                            onClick={() => setExpandedResults(prev => ({ ...prev, [m.id]: !prev[m.id] }))}
                          >
                            {expandedResults[m.id] ? '折叠' : '查看详情'}
                          </button>
                        )}
                        {changedFiles.length > 0 && (
                          <div className="mt-3 border border-white/10 bg-black/20 rounded-xl overflow-hidden">
                            <div className="flex items-center justify-between gap-2 px-2 py-1.5">
                              <div className="min-w-0">
                                <div className="text-xs font-semibold text-gray-200">
                                  已编辑 {changedFiles.length} 个章节
                                </div>
                                <div className="text-[10px] text-gray-400">
                                  <span className="text-green-400">+{changedSummary.added}</span>
                                  <span className="mx-1"> </span>
                                  <span className="text-rose-400">-{changedSummary.removed}</span>
                                </div>
                              </div>
                              <div className="flex items-center gap-1 shrink-0">
                                <button
                                  type="button"
                                  className="text-[10px] px-2 py-1 rounded border border-vscode-panel-border text-gray-200 hover:bg-vscode-active-item"
                                  onClick={() => setExpandedChanges((prev) => ({ ...prev, [m.id]: !prev[m.id] }))}
                                >
                                  {changesOpen ? '收起' : '查看变更'}
                                </button>
                                {changedFiles.length === 1 && (
                                  <button
                                    type="button"
                                    className="text-[10px] px-2 py-1 rounded border border-vscode-panel-border text-gray-200 hover:bg-vscode-active-item"
                                    disabled={!!restoredChanges[buildChangeKey(m.id, changedFiles[0])]}
                                    onClick={() => restoreChangedFile(m.id, changedFiles[0])}
                                  >
                                    {restoredChanges[buildChangeKey(m.id, changedFiles[0])] ? '已撤销' : '撤销'}
                                  </button>
                                )}
                              </div>
                            </div>
                            {changesOpen && (
                              <div className="border-t border-vscode-panel-border">
                                {changedFiles.map((file) => {
                                  const changeKey = buildChangeKey(m.id, file);
                                  const changePreview = buildChapterChangePreview(file.beforeContent, file.afterContent);
                                  return (
                                    <div key={changeKey} className="border-b last:border-b-0 border-vscode-panel-border">
                                      <div className="flex items-center justify-between gap-2 px-2 py-1 bg-vscode-active-item/60">
                                        <div className="text-[11px] text-gray-200 truncate">
                                          {file.chapterName || file.label}
                                        </div>
                                        {changedFiles.length > 1 && (
                                          <button
                                            type="button"
                                            className="text-[10px] px-2 py-0.5 rounded border border-vscode-panel-border text-gray-200 hover:bg-vscode-sidebar"
                                            disabled={!!restoredChanges[changeKey]}
                                            onClick={() => restoreChangedFile(m.id, file)}
                                          >
                                            {restoredChanges[changeKey] ? '已撤销' : '撤销'}
                                          </button>
                                        )}
                                      </div>
                                      <div className="px-2 py-2 text-[10px] leading-relaxed">
                                        <div className="mb-1 text-gray-300">变更内容：{changePreview.summary}</div>
                                        {(changePreview.beforeSnippet || changePreview.afterSnippet) && (
                                          <div className="grid grid-cols-1 gap-1">
                                            {changePreview.beforeSnippet && (
                                              <div className="rounded bg-rose-500/5 px-2 py-1 text-gray-400">
                                                <span className="text-rose-300">原片段：</span>
                                                <span className="whitespace-pre-wrap break-words">{changePreview.beforeSnippet}</span>
                                              </div>
                                            )}
                                            {changePreview.afterSnippet && (
                                              <div className="rounded bg-emerald-500/5 px-2 py-1 text-gray-300">
                                                <span className="text-green-300">新片段：</span>
                                                <span className="whitespace-pre-wrap break-words">{changePreview.afterSnippet}</span>
                                              </div>
                                            )}
                                          </div>
                                        )}
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              );
            }

            const isEditing = editingId === m.id;

            return (
              <div key={m.id || idx} className={`flex w-full gap-3 min-w-0 ${m.role === 'user' ? 'flex-row-reverse' : ''}`}>
                <div
                  className={`mana-chat-avatar ${
                    m.role === 'user' ? 'mana-chat-avatar-user' : 'mana-chat-avatar-bot'
                  }`}
                >
                  {m.role === 'user' ? (
                    <User size={14} className="text-white" />
                  ) : (
                    <Bot size={14} className="text-white" />
                  )}
                </div>
                <div className={`mana-chat-bubble group relative px-4 py-3 text-sm min-w-0 break-words mana-chat-prose ${
                  isEditing
                    ? 'w-[95%]'
                    : 'max-w-[calc(100%_-_2.5rem)] sm:max-w-[min(48rem,88%)]'
                } ${
                  m.role === 'user'
                    ? 'mana-chat-bubble-user text-gray-100'
                    : 'mana-chat-bubble-assistant text-gray-200'
                }`}>
                  {isEditing ? (
                    <div className="flex flex-col gap-2">
                      <textarea
                        className="bg-black/20 border border-white/10 rounded-xl p-3 text-sm text-gray-200 w-full resize-y min-h-[200px] outline-none focus:border-sky-400/50"
                        rows={Math.min(20, editText.split("\\n").length + 3)}
                        value={editText}
                        onChange={(e) => setEditText(e.target.value)}
                        autoFocus
                      />
                      <div className="flex gap-2 justify-end">
                        <button
                          className="text-[10px] px-2 py-0.5 bg-green-800 text-green-200 rounded hover:bg-green-700"
                          onClick={() => saveEdit(m.id)}
                        >
                          <Check size={10} className="inline mr-0.5" />保存
                        </button>
                        <button
                          className="text-[10px] px-2 py-0.5 bg-gray-700 text-gray-300 rounded hover:bg-gray-600"
                          onClick={cancelEdit}
                        >
                          <X size={10} className="inline mr-0.5" />取消
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      {m.role === 'assistant' && m.executionTrace && (
                        <div className={(String(m.text ?? '').trim() || (Array.isArray(m.roleplayEvents) && m.roleplayEvents.length > 0)) ? 'mb-3' : ''}>
                          <ExecutionTraceCard
                            trace={m.executionTrace}
                            thinking={thinkingByTraceId[m.executionTrace.traceId] || ''}
                            roleplayEvents={m.roleplayEvents}
                            toolDetails={messages.filter((item) => item.role === 'tool' && m.executionTrace.tools?.some((tool) => tool.id === item.toolUseId))}
                            restoredChanges={restoredChanges}
                            buildChangeKey={buildChangeKey}
                            onRestore={restoreChangedFile}
                            decisionPanel={latestExecutionMessage?.id === m.id ? renderExecutionDecisionPanel() : null}
                            expanded={latestExecutionMessage?.id === m.id && hasPendingExecutionDecision
                              ? expandedExecution[m.id] !== false
                              : !!expandedExecution[m.id]}
                            onToggle={() => setExpandedExecution((prev) => ({ ...prev, [m.id]: !prev[m.id] }))}
                          />
                        </div>
                      )}
                      {m.role === 'assistant' && !m.executionTrace && m.harnessTrace && (
                        <div className={(String(m.text ?? '').trim() || (Array.isArray(m.roleplayEvents) && m.roleplayEvents.length > 0)) ? 'mb-3' : ''}>
                          <HarnessContextCard
                            trace={m.harnessTrace}
                            expanded={!!expandedHarness[m.id]}
                            onToggle={() => setExpandedHarness((prev) => ({ ...prev, [m.id]: !prev[m.id] }))}
                          />
                        </div>
                      )}
                      {m.role === 'assistant' && !m.executionTrace && Array.isArray(m.roleplayEvents) && m.roleplayEvents.length > 0 && (
                        <div className={String(m.text ?? '').trim() ? 'mb-3' : ''}>
                          <RoleplayTimelineCard
                            events={m.roleplayEvents}
                            isLive={false}
                            expanded={isRoleplayExpanded(m.id)}
                            onToggle={() => setExpandedRoleplay((prev) => ({ ...prev, [m.id]: !isRoleplayExpanded(m.id) }))}
                          />
                        </div>
                      )}
                      {m.role === 'assistant' ? (
                        <ChatMarkdown content={m.text} />
                      ) : (
                        <div className="whitespace-pre-wrap">{String(m.text ?? '')}</div>
                      )}
                      {m.isStreaming && (
                        <span className="inline-block w-1.5 h-3 bg-blue-400 ml-0.5 animate-pulse" />
                      )}
                      {m.edited && (
                        <span className="text-[9px] text-gray-500 ml-1">(已编辑)</span>
                      )}
                      {/* Action buttons for assistant messages */}
                      {m.role === 'assistant' && !m.isStreaming && (
                        <div className="mana-chat-actionbar absolute -right-1 -top-2 hidden group-hover:flex items-center gap-0.5 rounded-lg px-1 py-0.5">
                          <button
                            type="button"
                            className="text-gray-400 hover:text-white p-0.5"
                            onClick={() => startEdit(m)}
                            title="编辑"
                          >
                            <Edit3 size={10} />
                          </button>
                          <button
                            type="button"
                            className="text-gray-400 hover:text-amber-400 p-0.5"
                            onClick={() => revertToNode(m.id)}
                            title="回退到此句之前"
                          >
                            <Undo2 size={10} />
                          </button>
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>
            );
          })}

          {liveExecutionState?.trace && isBusy && (
            <div className="flex w-full min-w-0 gap-3 max-w-4xl">
              <div className="mana-chat-avatar mana-chat-avatar-bot">
                <ListTree size={12} className="text-white" />
              </div>
              <div className="mana-chat-bubble min-w-0 max-w-[calc(100%_-_2.5rem)] sm:max-w-[min(46rem,88%)] p-0 bg-transparent border-none shadow-none">
                <ExecutionTraceCard
                  trace={liveExecutionState.trace}
                  thinking={thinkingByTraceId[liveExecutionState.traceId] || ''}
                  roleplayEvents={liveRoleplayEvents}
                  toolDetails={messages.filter((item) => item.role === 'tool' && liveExecutionState.trace.tools?.some((tool) => tool.id === item.toolUseId))}
                  restoredChanges={restoredChanges}
                  buildChangeKey={buildChangeKey}
                  onRestore={restoreChangedFile}
                  decisionPanel={renderExecutionDecisionPanel()}
                  expanded={expandedExecution.__live !== false}
                  onToggle={() => setExpandedExecution((prev) => ({ ...prev, __live: prev.__live === false }))}
                />
              </div>
            </div>
          )}

          {liveRoleplayEvents.length > 0 && isBusy && !liveExecutionState?.trace && (
            <div className="flex gap-3 max-w-4xl">
              <div className="mana-chat-avatar mana-chat-avatar-bot">
                <Users size={12} className="text-white" />
              </div>
              <div className="mana-chat-bubble p-0 max-w-[min(46rem,88%)] bg-transparent border-none shadow-none">
                <RoleplayTimelineCard
                  events={liveRoleplayEvents}
                  isLive
                  expanded={isRoleplayExpanded('__live')}
                  onToggle={() => setExpandedRoleplay((prev) => ({ ...prev, __live: !isRoleplayExpanded('__live') }))}
                />
              </div>
            </div>
          )}

          {progressItems.length > 0 && isBusy && !liveExecutionState?.trace && (
            <div className="flex gap-3 max-w-4xl">
              <div className="mana-chat-avatar mana-chat-avatar-bot">
                <Brain size={12} className="text-white" />
              </div>
              <div className="mana-chat-bubble border-sky-400/20 bg-sky-950/35 p-3 max-w-[min(46rem,88%)] text-sm text-sky-100">
                <div className="mb-2 flex items-center gap-2 text-[11px] font-semibold text-sky-300">
                  <span className="h-2 w-2 rounded-full bg-sky-300 animate-pulse" />
                  自动执行中
                </div>
                <div className="space-y-1.5">
                  {progressItems.map((item, index) => (
                    <div key={item.id} className={`rounded-lg px-2 py-1 ${index === progressItems.length - 1 ? 'bg-sky-400/10 text-sky-50' : 'text-sky-200/70'}`}>
                      {item.text}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {isBusy && !messages.some((m) => m.isStreaming) && (
            <div className="flex gap-3">
              <div className="mana-chat-avatar mana-chat-avatar-bot">
                <Bot size={14} className="text-white" />
              </div>
              <div className="mana-chat-bubble mana-chat-bubble-assistant px-4 py-3 text-sm text-gray-400">
                <span className="inline-block w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce mr-0.5" />
                <span className="inline-block w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce mr-0.5 [animation-delay:0.1s]" />
                <span className="inline-block w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce [animation-delay:0.2s]" />
              </div>
            </div>
          )}

          {showThinking && thinkingText && !liveExecutionState?.trace && (
            <div className="flex gap-3 max-w-4xl">
              <div className="mana-chat-avatar bg-gradient-to-br from-violet-600 to-fuchsia-500">
                <Brain size={12} className="text-white" />
              </div>
              <div className="mana-chat-bubble bg-violet-950/30 p-3 max-w-[min(46rem,88%)] text-sm text-purple-200 italic">
                {thinkingText}
              </div>
            </div>
          )}
        </div>

        {showJumpToBottom && (
          <button
            type="button"
            className="absolute bottom-28 right-5 z-20 rounded-full border border-sky-400/25 bg-slate-950/80 px-3 py-1.5 text-[11px] font-semibold text-sky-200 shadow-[0_12px_32px_rgba(0,0,0,0.35)] backdrop-blur hover:bg-sky-950/80 hover:text-white"
            title="回到底部"
            onClick={jumpToBottom}
          >
            回到底部
          </button>
        )}

        {/* Error */}
        {error && (
          <div className="px-3 py-1.5 border-t border-rose-500/30 bg-rose-500/10 flex items-center gap-1.5 text-[11px] text-rose-300">
            <AlertCircle size={12} />
            <span className="flex-1">{error}</span>
            <button className="text-rose-400 hover:text-rose-200" onClick={() => setError('')}>
              清除
            </button>
          </div>
        )}

        {/* Roleplay Risk Decision Card */}
        {pendingRoleplayRiskDecision && !hasInlineDecisionTrace && (
          <div className="mx-3 mb-2 rounded-2xl border border-amber-500/25 bg-amber-500/10 px-4 py-3 shadow-2xl shadow-black/20 shrink-0">
            <div className="flex items-center gap-1.5 mb-2">
              <AlertCircle size={12} className="text-amber-300" />
              <span className="text-xs font-bold text-amber-200">角色与大纲存在张力</span>
            </div>
            <div className="mb-2 text-xs text-gray-300">
              {pendingRoleplayRiskDecision.title || pendingRoleplayRiskDecision.chapterRef || '当前章节'} 的角色驱动规划已暂停，等待你选择下一步。
            </div>
            <pre className="mb-3 max-h-32 overflow-auto rounded bg-black/25 p-2 text-[11px] text-amber-50/90 whitespace-pre-wrap">
              {roleplayRiskPreview(pendingRoleplayRiskDecision)}
            </pre>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="px-3 py-1.5 text-xs font-semibold rounded bg-emerald-600 text-white hover:bg-emerald-500"
                onClick={() => setInput('保大纲继续')}
              >
                保大纲继续
              </button>
              <button
                type="button"
                className="px-3 py-1.5 text-xs rounded bg-sky-700 text-sky-50 hover:bg-sky-600"
                onClick={() => setInput('按角色方向调整大纲建议')}
              >
                调整大纲建议
              </button>
              <button
                type="button"
                className="px-3 py-1.5 text-xs rounded bg-gray-600 text-gray-200 hover:bg-gray-500"
                onClick={() => setInput('跳过角色驱动继续')}
              >
                跳过角色驱动
              </button>
              <button
                type="button"
                className="px-3 py-1.5 text-xs rounded bg-rose-800/60 text-rose-200 hover:bg-rose-700/60"
                onClick={() => setInput('取消本轮')}
              >
                取消本轮
              </button>
            </div>
          </div>
        )}

        {/* Character Profile Gate Card */}
        {pendingCharacterProfileDecision && !hasInlineDecisionTrace && (
          <div className="mx-3 mb-2 rounded-2xl border border-sky-500/20 bg-sky-500/10 px-4 py-3 shadow-2xl shadow-black/20 shrink-0">
            <div className="flex items-center gap-1.5 mb-2">
              <Brain size={12} className="text-sky-300" />
              <span className="text-xs font-bold text-sky-200">角色资料不足</span>
            </div>
            <div className="space-y-1.5 mb-3 text-xs text-gray-300">
              {(pendingCharacterProfileDecision.missingCharacters || []).slice(0, 6).map((item) => {
                const fields = [
                  ...((item.missingFields || []).map((field) => `${profileFieldLabel(field)}缺失`)),
                  ...((item.weakFields || []).map((field) => `${profileFieldLabel(field)}过弱`)),
                ];
                return (
                  <div key={item.id || item.name} className="flex gap-2">
                    <span className="text-sky-200 shrink-0">{item.name || item.id}</span>
                    <span className="text-gray-400">{fields.join('、') || '资料不足'}</span>
                  </div>
                );
              })}
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="px-3 py-1.5 text-xs font-semibold rounded bg-sky-600 text-white hover:bg-sky-500"
                onClick={() => setInput('自动补全角色资料')}
              >
                自动补全
              </button>
              <button
                type="button"
                className="px-3 py-1.5 text-xs rounded bg-gray-600 text-gray-200 hover:bg-gray-500"
                onClick={() => setInput('忽略角色资料不足并继续写')}
              >
                忽略继续
              </button>
            </div>
          </div>
        )}

        {/* Character Profile Patch Card */}
        {pendingCharacterProfilePatch && !hasInlineDecisionTrace && (
          <div className="mx-3 mb-2 rounded-2xl border border-cyan-500/20 bg-cyan-500/10 px-4 py-3 shadow-2xl shadow-black/20 shrink-0">
            <div className="flex items-center gap-1.5 mb-2">
              <Wrench size={12} className="text-cyan-300" />
              <span className="text-xs font-bold text-cyan-200">角色资料补全建议</span>
            </div>
            <div className="mb-2 text-xs text-gray-300">
              角色卡 patch：{(pendingCharacterProfilePatch.characterPatches || []).length} 个，记忆 patch：{(pendingCharacterProfilePatch.memoryPatches || []).length} 个
            </div>
            <pre className="mb-3 text-[11px] bg-black/30 rounded p-2 max-h-40 overflow-auto text-gray-300 whitespace-pre-wrap">
              {profilePatchPreview({
                characterPatches: pendingCharacterProfilePatch.characterPatches || [],
                memoryPatches: pendingCharacterProfilePatch.memoryPatches || [],
                notes: pendingCharacterProfilePatch.notes || [],
              })}
            </pre>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="px-3 py-1.5 text-xs font-semibold rounded bg-emerald-600 text-white hover:bg-emerald-500"
                onClick={() => setInput('确认应用角色资料补全')}
              >
                确认应用
              </button>
              <button
                type="button"
                className="px-3 py-1.5 text-xs rounded bg-rose-800/60 text-rose-200 hover:bg-rose-700/60"
                onClick={() => setInput('拒绝角色资料补全')}
              >
                拒绝
              </button>
              <button
                type="button"
                className="px-3 py-1.5 text-xs rounded bg-gray-600 text-gray-200 hover:bg-gray-500"
                onClick={() => setInput('忽略角色资料不足并继续写')}
              >
                忽略继续
              </button>
            </div>
          </div>
        )}

        {/* Write Chapter Confirmation Card */}
        {pendingWriteChapter && !hasInlineDecisionTrace && (
          <div data-testid="chapter-mutation-decision" className="mx-3 mb-2 max-h-[42vh] overflow-auto rounded-2xl border border-amber-500/20 bg-amber-500/10 px-4 py-3 shadow-lg shadow-black/10 shrink-0">
            <div className="flex items-center gap-1.5 mb-2">
              <AlertCircle size={12} className="text-amber-400" />
              <span className="text-xs font-bold text-amber-300">章节变更确认</span>
            </div>
            <div className="text-xs text-gray-300 mb-2">
              AI 请求提交严格验证后的章节变更：
              <span className="text-amber-200 font-medium ml-1">
                {pendingWriteChapter.title || pendingWriteChapter.name || '未命名章节'}
              </span>
              {pendingWriteChapter.contentLength > 0 && (
                <span className="text-gray-500 ml-1">
                  ({pendingWriteChapter.contentLength} 字)
                </span>
              )}
            </div>
            {pendingWriteChapter.contentPreview && (
              <pre className="mb-3 text-[11px] bg-black/30 rounded p-2 max-h-24 overflow-hidden text-gray-400 whitespace-pre-wrap">
                {pendingWriteChapter.contentPreview}
                {pendingWriteChapter.contentLength > 500 && '...'}
              </pre>
            )}
            {pendingWriteChapter.warning && (
              <div className="mb-3 text-[11px] text-amber-100 bg-amber-900/30 border border-amber-500/30 rounded p-2">
                {pendingWriteChapter.warning}
              </div>
            )}
            <div className={`mb-3 rounded p-2 text-[11px] ${pendingWriteChapter.verificationStatus === 'passed' ? 'bg-emerald-500/10 text-emerald-200' : 'border border-rose-500/20 bg-rose-500/10 text-rose-200'}`}>
              严格验证：{pendingWriteChapter.verificationStatus === 'passed' ? '已通过，可以确认提交。' : '未通过，草稿已保留但禁止写入。'}
              {Array.isArray(pendingWriteChapter.blockingIssues) && pendingWriteChapter.blockingIssues.slice(0, 4).map((issue, index) => (
                <div key={`blocking-${index}`} className="mt-1">- {issue}</div>
              ))}
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="px-3 py-1.5 text-xs font-semibold rounded bg-emerald-600 text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-40"
                disabled={pendingWriteChapter.verificationStatus !== 'passed'}
                onClick={() => {
                  setInput('确认写入这一章');
                }}
              >
                确认写入
              </button>
              {pendingWriteChapter.warning && pendingWriteChapter.verificationStatus === 'passed' && (
                <button
                  type="button"
                  className="px-3 py-1.5 text-xs font-semibold rounded bg-amber-700 text-white hover:bg-amber-600"
                  onClick={() => setInput('覆盖写入')}
                >
                  覆盖写入
                </button>
              )}
              <button
                type="button"
                className="px-3 py-1.5 text-xs rounded bg-gray-600 text-gray-200 hover:bg-gray-500"
                onClick={() => {
                  setInput('拒绝写入');
                }}
              >
                拒绝
              </button>
              <button
                type="button"
                className="px-3 py-1.5 text-xs rounded bg-rose-800/60 text-rose-200 hover:bg-rose-700/60"
                onClick={() => setRejectReason(rejectReason ? '' : ' ')}
              >
                拒绝并说明理由
              </button>
            </div>
            {rejectReason !== '' && (
              <div className="mt-3 flex flex-col gap-2">
                <textarea
                  className="bg-vscode-sidebar border border-vscode-panel-border rounded p-2 text-xs text-gray-200 w-full resize-y min-h-[60px]"
                  placeholder="请说明拒绝理由..."
                  value={rejectReason === ' ' ? '' : rejectReason}
                  onChange={(e) => setRejectReason(e.target.value)}
                  autoFocus
                />
                <div className="flex gap-2 justify-end">
                  <button
                    type="button"
                    className="px-2 py-1 text-[10px] rounded bg-gray-600 text-gray-200 hover:bg-gray-500"
                    onClick={() => setRejectReason('')}
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    className="px-2 py-1 text-[10px] rounded bg-rose-700 text-rose-100 hover:bg-rose-600"
                    onClick={() => {
                      const reason = (rejectReason === ' ' ? '' : rejectReason).trim();
                      setInput(reason ? `拒绝写入，理由是：${reason}` : '拒绝写入');
                      setRejectReason('');
                    }}
                  >
                    发送拒绝
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Input */}
        <div className="mana-chat-input-wrap p-3 shrink-0">
          {feedbackNotice && (
            <div className={`mb-2 rounded border px-2 py-1.5 text-[11px] ${feedbackNotice.type === 'error' ? 'border-rose-500/30 bg-rose-500/10 text-rose-300' : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200'}`}>
              <div className="flex items-center gap-1.5">
                <AlertCircle size={12} />
                <span className="flex-1">{feedbackNotice.text}</span>
                <button
                  type="button"
                  className="text-current/80 hover:text-current"
                  onClick={() => setFeedbackNotice(null)}
                >
                  清除
                </button>
              </div>
            </div>
          )}
          <div className="mana-chat-composer flex items-end gap-2 px-3 py-2" data-testid="chat-composer">
            <textarea
              placeholder="向 AI 提问…"
              rows={3}
              className="mana-chat-scroll min-h-[4.5rem] max-h-40 w-full resize-none bg-transparent border-none outline-none flex-1 text-sm leading-6 text-gray-200 placeholder-gray-500 overflow-y-auto"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={isBusy}
            />
            {isBusy ? (
              <button
                className="h-9 w-9 rounded-xl border border-rose-500/20 bg-rose-500/10 text-rose-300 hover:bg-rose-500/20 flex items-center justify-center"
                onClick={cancelGeneration}
                title="停止生成"
              >
                <Square size={16} />
              </button>
            ) : (
              <button
                className="mana-chat-send disabled:opacity-40"
                onClick={sendMessage}
                disabled={!input.trim()}
              >
                <Send size={16} />
              </button>
            )}
          </div>
        </div>
      </div>

      {showFeedbackModal && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60"
          role="dialog"
          aria-modal="true"
          onClick={(e) => { if (e.target === e.currentTarget) closeFeedbackModal(); }}
        >
          <div className="mx-4 w-full max-w-lg rounded border border-vscode-panel-border bg-vscode-sidebar shadow-xl">
            <div className="border-b border-vscode-panel-border/60 px-4 py-3">
              <div className="text-sm font-semibold text-emerald-300">提交快速反馈</div>
            </div>
            <div className="space-y-3 px-4 py-3 text-sm text-gray-300">
              <div className="rounded border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-[12px] text-amber-100">
                本次反馈可用于改善软件表现。你可以选择允许附带必要的聊天信息与上下文，或仅提交意见，不上传日志与聊天片段。
              </div>

              <div>
                <label className="mb-1 block text-xs text-gray-400">反馈标题</label>
                <input
                  type="text"
                  className="w-full rounded border border-vscode-panel-border bg-vscode-bg/60 px-3 py-2 text-sm text-gray-200 outline-none focus:border-emerald-500"
                  value={feedbackTitle}
                  onChange={(e) => setFeedbackTitle(e.target.value)}
                  placeholder="例如：AI 改错了选中的句子"
                />
              </div>

              <div>
                <label className="mb-1 block text-xs text-gray-400">问题描述（可选，但建议填写）</label>
                <textarea
                  rows={4}
                  className="w-full rounded border border-vscode-panel-border bg-vscode-bg/60 px-3 py-2 text-sm text-gray-200 outline-none focus:border-emerald-500"
                  value={feedbackDescription}
                  onChange={(e) => setFeedbackDescription(e.target.value)}
                  placeholder="简单描述你刚遇到的问题，例如：我明明只选中一句，但 AI 改了整段。"
                />
              </div>

              <div className="space-y-2">
                <div className="text-xs text-gray-400">上传方式</div>
                <button
                  type="button"
                  className={`w-full rounded border px-3 py-2 text-left text-sm ${feedbackIncludeLogs ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-100' : 'border-vscode-panel-border bg-vscode-bg/40 text-gray-300 hover:bg-vscode-active-item'}`}
                  onClick={() => setFeedbackIncludeLogs(true)}
                >
                  <div className="font-medium">允许上传必要聊天信息与上下文</div>
                  <div className="mt-1 text-[11px] opacity-80">会附带当前线程摘要、最近工具调用、最近错误信息、当前编辑上下文，以及最近渲染器/主进程日志摘要，便于快速复现问题。</div>
                </button>
                <button
                  type="button"
                  className={`w-full rounded border px-3 py-2 text-left text-sm ${!feedbackIncludeLogs ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-100' : 'border-vscode-panel-border bg-vscode-bg/40 text-gray-300 hover:bg-vscode-active-item'}`}
                  onClick={() => setFeedbackIncludeLogs(false)}
                >
                  <div className="font-medium">仅反馈意见</div>
                  <div className="mt-1 text-[11px] opacity-80">只提交你填写的标题与描述，不附带聊天记录片段、变更摘要和错误上下文。</div>
                </button>
              </div>

              <label className="flex items-start gap-2 rounded border border-vscode-panel-border bg-vscode-bg/40 px-3 py-2 text-sm text-gray-300">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={feedbackIncludeScreenshot}
                  onChange={(e) => setFeedbackIncludeScreenshot(e.target.checked)}
                />
                <span>
                  <span className="font-medium text-gray-200">附带当前窗口截图</span>
                  <span className="mt-1 block text-[11px] opacity-80">用于复现布局错乱、卡片显示异常、弹窗阻塞等纯 UI 问题。截图会和反馈一起保存到本地反馈箱。</span>
                </span>
              </label>
            </div>
            <div className="flex justify-end gap-2 border-t border-vscode-panel-border/60 px-4 py-3">
              <button
                type="button"
                className="rounded border border-vscode-panel-border bg-vscode-bg/60 px-3 py-1.5 text-xs text-gray-200 hover:bg-vscode-active-item"
                onClick={closeFeedbackModal}
                disabled={feedbackSubmitting}
              >
                取消
              </button>
              <button
                type="button"
                className="rounded bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-60"
                onClick={submitQuickFeedback}
                disabled={feedbackSubmitting}
              >
                {feedbackSubmitting ? '正在保存反馈…' : '提交一键反馈'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
