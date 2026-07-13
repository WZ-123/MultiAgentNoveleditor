'use strict';

const { randomUUID } = require('node:crypto');

const TRACE_STATUS = new Set([
  'running',
  'awaiting_confirmation',
  'blocked',
  'completed',
  'failed',
  'cancelled',
]);

function text(value, max = 240) {
  let raw = '';
  if (typeof value === 'string') raw = value;
  else if (value == null) raw = '';
  else {
    try { raw = JSON.stringify(value); } catch { raw = String(value); }
  }
  const compact = raw.replace(/\s+/gu, ' ').trim();
  return compact.length > max ? `${compact.slice(0, Math.max(0, max - 1))}…` : compact;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function safeList(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function toolSummary(value) {
  if (!value || typeof value !== 'object') return text(value, 320);
  const redacted = {};
  for (const [key, item] of Object.entries(value)) {
    if (/content|replacement|text|before|after|chapter|prompt|input/iu.test(key) && typeof item === 'string') {
      redacted[key] = `[${item.length} chars]`;
    } else if (typeof item === 'string') {
      redacted[key] = text(item, 80);
    } else if (item == null || typeof item === 'number' || typeof item === 'boolean') {
      redacted[key] = item;
    } else if (Array.isArray(item)) {
      redacted[key] = `[${item.length} items]`;
    } else {
      redacted[key] = '[object]';
    }
  }
  return text(redacted, 320);
}

function normalizeCheck(item, index = 0) {
  const rawStatus = String(item?.status || '');
  const status = rawStatus === 'verified' ? 'satisfied'
    : rawStatus === 'blocking' ? 'violated'
      : rawStatus === 'warning' ? 'unclear'
        : ['satisfied', 'violated', 'unclear', 'passed', 'failed'].includes(rawStatus)
          ? rawStatus
          : 'unclear';
  const discrepancies = safeList(item?.discrepancies);
  const blocking = item?.severity === 'blocking'
    || rawStatus === 'blocking'
    || discrepancies.some((entry) => entry?.severity === 'blocking');
  return {
    constraintId: text(item?.constraintId || item?.id || `check-${index + 1}`, 120),
    status,
    severity: blocking ? 'blocking' : 'advisory',
    sourceRefs: safeList(item?.sourceRefs).map((source) => text(source?.ref || source?.sourceRef || source, 180)).filter(Boolean),
    evidenceParagraphIds: safeList(item?.evidenceParagraphIds || item?.paragraphIds).map((id) => text(id, 60)).filter(Boolean),
    summary: text(item?.summary || item?.message || item?.note || discrepancies[0]?.summary || '', 360),
  };
}

function createExecutionTrace({ driverId = '', path = '', intent = '', toolPolicy = null } = {}) {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    traceId: randomUUID(),
    status: 'running',
    runtime: {
      driverId: text(driverId, 100),
      path: text(path, 100),
      intent: text(intent, 100),
      toolPolicy: toolPolicy && typeof toolPolicy === 'object' ? clone(toolPolicy) : null,
    },
    stages: [],
    context: { sources: [], manifests: [], trimmed: [], cached: [], omitted: [] },
    tools: [],
    verification: {
      policy: 'strict',
      status: 'pending',
      checks: [],
      blockingCount: 0,
      warningCount: 0,
    },
    modelCalls: [],
    usage: {},
    fallbacks: [],
    decisions: [],
    processSummary: [],
    startedAt: now,
    completedAt: '',
  };
}

function createExecutionTraceAccumulator(options = {}) {
  let trace = createExecutionTrace(options);
  let revision = 0;
  const onUpdate = typeof options.onUpdate === 'function' ? options.onUpdate : null;

  function emit() {
    revision += 1;
    const snapshot = clone(trace);
    try { onUpdate?.({ traceId: trace.traceId, revision, trace: snapshot }); } catch { /* trace UI is best effort */ }
    return snapshot;
  }

  function upsertStage(kind, patch = {}) {
    const id = text(patch.id || kind || `stage-${trace.stages.length + 1}`, 120);
    const index = trace.stages.findIndex((stage) => stage.id === id);
    const now = new Date().toISOString();
    const current = index >= 0 ? trace.stages[index] : {
      id,
      kind: text(kind || patch.kind || 'process', 80),
      label: text(patch.label || kind || '执行阶段', 160),
      status: 'running',
      startedAt: patch.startedAt || now,
      completedAt: '',
      durationMs: 0,
      summary: '',
    };
    const next = {
      ...current,
      ...patch,
      id,
      kind: text(patch.kind || current.kind, 80),
      label: text(patch.label || current.label, 160),
      summary: text(patch.summary || current.summary, 360),
    };
    if (['completed', 'failed', 'blocked', 'cancelled'].includes(next.status) && !next.completedAt) {
      next.completedAt = now;
    }
    if (next.startedAt && next.completedAt && (!Number.isFinite(Number(next.durationMs)) || Number(next.durationMs) <= 0)) {
      next.durationMs = Math.max(0, new Date(next.completedAt).getTime() - new Date(next.startedAt).getTime());
    }
    if (index >= 0) trace.stages[index] = next;
    else trace.stages.push(next);
    return emit();
  }

  function upsertTool(data = {}) {
    const id = text(data.id || data.toolUseId || `tool-${trace.tools.length + 1}`, 160);
    const index = trace.tools.findIndex((tool) => tool.id === id);
    const inputSummary = data.input !== undefined ? toolSummary(data.input) : '';
    const priorAttempt = index < 0
      ? trace.tools.slice().reverse().find((tool) => tool.name === text(data.name || 'unknown', 120) && tool.inputSummary === inputSummary && tool.isError)
      : null;
    const current = index >= 0 ? trace.tools[index] : {
      id,
      name: text(data.name || 'unknown', 120),
      execution: text(data.execution || 'mcp', 40),
      effect: text(data.effect || 'unknown', 40),
      status: 'running',
      inputSummary: '',
      resultSummary: '',
      isError: false,
      retryCount: 0,
      cached: false,
      sourceRef: '',
      modelContentTrimmed: false,
      durationMs: 0,
      checkpointId: '',
      startedAt: Date.now(),
    };
    const next = {
      ...current,
      name: text(data.name || current.name, 120),
      execution: text(data.execution || current.execution, 40),
      effect: text(data.effect || current.effect, 40),
      status: text(data.status || current.status, 40),
      inputSummary: data.input !== undefined ? inputSummary : current.inputSummary,
      resultSummary: data.result !== undefined || data.text !== undefined
        ? text(data.result ?? data.text, 320)
        : current.resultSummary,
      isError: data.isError === true,
      retryCount: Number.isFinite(Number(data.retryCount))
        ? Number(data.retryCount)
        : priorAttempt
          ? Number(priorAttempt.retryCount || 0) + 1
          : current.retryCount,
      cached: data.cached === true,
      sourceRef: text(data.sourceRef || current.sourceRef, 180),
      modelContentTrimmed: data.modelContentTrimmed === true,
      durationMs: Number.isFinite(Number(data.durationMs))
        ? Number(data.durationMs)
        : data.status === 'done' || data.status === 'failed'
          ? Math.max(0, Date.now() - Number(current.startedAt || Date.now()))
          : current.durationMs,
      checkpointId: text(data.checkpointId || current.checkpointId, 160),
    };
    if (index >= 0) trace.tools[index] = next;
    else trace.tools.push(next);
    return emit();
  }

  return {
    get traceId() { return trace.traceId; },
    snapshot: () => clone(trace),
    emit,
    setRuntime(patch = {}) {
      trace.runtime = { ...trace.runtime, ...patch };
      if (patch.intent) trace.runtime.intent = text(patch.intent, 100);
      if (patch.driverId) trace.runtime.driverId = text(patch.driverId, 100);
      if (patch.path) trace.runtime.path = text(patch.path, 100);
      return emit();
    },
    addProcess(summary) {
      const value = text(summary, 360);
      if (value && trace.processSummary[trace.processSummary.length - 1] !== value) {
        trace.processSummary.push(value);
        if (trace.processSummary.length > 24) trace.processSummary.shift();
      }
      return emit();
    },
    upsertStage,
    setContextManifest(manifest = {}) {
      const normalized = clone(manifest || {});
      trace.context.manifests.push(normalized);
      if (trace.context.manifests.length > 16) trace.context.manifests.shift();
      trace.context.sources = safeList(normalized.included).map((item) => ({
        sourceRef: text(item?.sourceRef || item?.ref || '', 180),
        kind: text(item?.kind || item?.type || 'context', 80),
      })).filter((item) => item.sourceRef);
      trace.context.trimmed = safeList(normalized.trimmed).map((item) => text(item?.sourceRef || item?.label || item, 180)).filter(Boolean);
      trace.context.cached = safeList(normalized.cached).map((item) => text(item?.sourceRef || item?.cacheKey || item, 180)).filter(Boolean);
      trace.context.omitted = safeList(normalized.omitted).map((item) => text(item?.sourceRef || item?.reason || item, 180)).filter(Boolean);
      if (normalized.toolPolicy) trace.runtime.toolPolicy = clone(normalized.toolPolicy);
      return emit();
    },
    upsertTool,
    setVerification(value = {}) {
      const checks = safeList(value.checks || value.stateVerifications || value).map(normalizeCheck);
      const blockingCount = checks.filter((item) => item.severity === 'blocking' && ['violated', 'failed', 'unclear'].includes(item.status)).length;
      const warningCount = checks.filter((item) => item.severity !== 'blocking' && item.status !== 'satisfied' && item.status !== 'passed').length;
      trace.verification = {
        policy: 'strict',
        status: value.status || (blockingCount ? 'blocked' : checks.length ? 'passed' : 'pending'),
        checks,
        blockingCount,
        warningCount,
      };
      return emit();
    },
    addFallback(value = {}) {
      trace.fallbacks.push({
        from: text(value.from, 120),
        to: text(value.to, 120),
        reason: text(value.reason, 360),
      });
      return emit();
    },
    addModelCall(value = {}) {
      trace.modelCalls.push({
        role: text(value.role || 'chat', 80),
        model: text(value.model || '', 160),
        requestId: text(value.requestId || '', 180),
        stopReason: text(value.stopReason || '', 80),
        usage: value.usage && typeof value.usage === 'object' ? clone(value.usage) : {},
      });
      const usage = value.usage && typeof value.usage === 'object' ? value.usage : {};
      trace.usage = {
        inputTokens: (Number(trace.usage.inputTokens) || 0) + (Number(usage.inputTokens) || 0),
        outputTokens: (Number(trace.usage.outputTokens) || 0) + (Number(usage.outputTokens) || 0),
        totalTokens: (Number(trace.usage.totalTokens) || 0) + (Number(usage.totalTokens) || 0),
        estimated: trace.usage.estimated === true || usage.estimated === true,
      };
      return emit();
    },
    addDecision(value = {}) {
      trace.decisions.push({
        kind: text(value.kind || value.type || 'decision', 100),
        status: text(value.status || 'pending', 80),
        summary: text(value.summary || value.message || '', 360),
      });
      return emit();
    },
    mergeHarness(harnessTrace) {
      if (!harnessTrace || typeof harnessTrace !== 'object') return clone(trace);
      trace.modelCalls = safeList(harnessTrace.modelCalls).map((item) => clone(item));
      trace.usage = harnessTrace.usage && typeof harnessTrace.usage === 'object' ? clone(harnessTrace.usage) : trace.usage;
      if (safeList(harnessTrace.sourceRefs).length) {
        trace.context.sources = harnessTrace.sourceRefs.map((item) => ({
          sourceRef: text(item?.ref || item?.sourceRef || item, 180),
          kind: text(item?.type || item?.kind || 'context', 80),
        })).filter((item) => item.sourceRef);
      }
      if (safeList(harnessTrace.trimmed).length) trace.context.trimmed = harnessTrace.trimmed.map((item) => text(item, 180));
      for (const stage of safeList(harnessTrace.stages)) {
        const id = `harness-${text(stage?.name || 'stage', 80)}`;
        const existing = trace.stages.findIndex((item) => item.id === id);
        const normalized = {
          id,
          kind: 'harness',
          label: text(stage?.name || 'Harness', 160),
          status: stage?.status === 'failed' ? 'failed' : stage?.status === 'blocked' ? 'blocked' : 'completed',
          startedAt: '',
          completedAt: '',
          durationMs: Number(stage?.durationMs) || 0,
          summary: text(stage?.detail || '', 360),
        };
        if (existing >= 0) trace.stages[existing] = normalized;
        else trace.stages.push(normalized);
      }
      const verificationChecks = [
        ...safeList(harnessTrace.stateVerifications),
        ...safeList(harnessTrace.constraintVerifications),
      ];
      if (verificationChecks.length) {
        this.setVerification({ checks: verificationChecks });
      }
      return emit();
    },
    complete(status = 'completed') {
      trace.status = TRACE_STATUS.has(status) ? status : 'completed';
      if (trace.verification.status === 'pending' && trace.status === 'completed') {
        trace.verification.status = 'not_required';
      }
      trace.completedAt = new Date().toISOString();
      for (const stage of trace.stages) {
        if (stage.status === 'running') {
          stage.status = trace.status === 'failed' ? 'failed' : trace.status === 'blocked' ? 'blocked' : 'completed';
          stage.completedAt = trace.completedAt;
          if (stage.startedAt) stage.durationMs = Math.max(0, new Date(stage.completedAt).getTime() - new Date(stage.startedAt).getTime());
        }
      }
      return emit();
    },
  };
}

module.exports = {
  createExecutionTrace,
  createExecutionTraceAccumulator,
  normalizeCheck,
  text,
  toolSummary,
};
