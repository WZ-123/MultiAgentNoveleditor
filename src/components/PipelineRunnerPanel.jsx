import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Chip } from '@heroui/react';
import { useI18n } from '@/i18n/LanguageContext.jsx';

const STAGES = [
  { value: 'outline', tKey: 'pipeline.stageOutline' },
  { value: 'writing', tKey: 'pipeline.stageWriting' },
];

function fmtEventLine(ev, subagentByToolUseId) {
  const ts = new Date(ev.ts || Date.now()).toLocaleTimeString();
  // Resolve sub-agent attribution: prefer the explicit subagentId on the event,
  // fall back to looking up parentToolUseId in the running map (sub-agent
  // events nested inside a Task/Agent call carry parentToolUseId but not
  // subagentId), and finally label the top-level orchestrator turn.
  const owner = ev.subagentId
    || (ev.parentToolUseId && subagentByToolUseId?.get(ev.parentToolUseId))
    || (ev.data?.parentToolUseId && subagentByToolUseId?.get(ev.data.parentToolUseId))
    || 'orchestrator';
  if (ev.kind === 'pipeline_started') {
    const label = ev.data?.name || ev.dagId || '?';
    const stage = ev.data?.stage || ev.data?.autonomous ? (ev.data?.autonomous ? 'autonomous' : ev.data?.stage) : '';
    return `[${ts}] ▶ ${label}${stage ? ` (${stage})` : ''}`;
  }
  if (ev.kind === 'pipeline_done') return `[${ts}] ✔ done`;
  if (ev.kind === 'pipeline_error') return `[${ts}] ✖ ${ev.data?.message}`;
  if (ev.kind === 'node_started') return `[${ts}] ┝ start ${ev.data?.kind} ${ev.nodeId} ${ev.data?.label || ''}`;
  if (ev.kind === 'node_done') return `[${ts}] └ done  ${ev.nodeId}`;
  if (ev.kind === 'node_error') return `[${ts}] └ err   ${ev.nodeId} ${ev.data?.message}`;
  if (ev.kind === 'gate_decision') return `[${ts}] ◇ gate  ${ev.nodeId} -> ${ev.data?.decision} (rev=${ev.data?.revisions})`;
  if (ev.kind === 'gate_max_revisions') return `[${ts}] ⚠ gate maxRevisions; forced ${ev.data?.forced}`;
  if (ev.kind === 'awaiting_human') return `[${ts}] ✋ awaiting human at ${ev.nodeId}`;
  if (ev.kind === 'queued') return `[${ts}]   queued ${owner}`;
  if (ev.kind === 'running') return `[${ts}]   running ${owner} (${ev.data?.tier} ${ev.data?.model})`;
  if (ev.kind === 'sub_agent_start') return `[${ts}]   ▶▶ ${ev.subagentId || ev.data?.subagentId || '?'} (start)`;
  if (ev.kind === 'sub_agent_done') return `[${ts}]   ◀◀ ${ev.subagentId || ev.data?.subagentId || '?'} (done${ev.data?.isError ? ' err' : ''})`;
  if (ev.kind === 'text') {
    const txt = (ev.data?.text || '').slice(0, 80).replace(/\s+/g, ' ');
    return `[${ts}]   text  ${owner}: ${txt}`;
  }
  if (ev.kind === 'tool_use') return `[${ts}]   tool↑ ${owner} ${ev.data?.name}`;
  if (ev.kind === 'tool_result') return `[${ts}]   tool↓ ${owner} ${ev.data?.name || '?'}${ev.data?.isError ? ' (error)' : ''}`;
  if (ev.kind === 'output') return `[${ts}]   out   ${owner}`;
  if (ev.kind === 'done') return `[${ts}]   ok    ${owner} (turns=${ev.data?.turns ?? '?'})`;
  if (ev.kind === 'error') return `[${ts}]   err   ${owner} ${ev.data?.message}`;
  if (ev.kind === 'cost') return `[${ts}]   $$    cost=${ev.data?.costUsd?.toFixed?.(4) ?? ev.data?.costUsd} dur=${ev.data?.durationMs}ms turns=${ev.data?.turns}`;
  return `[${ts}] ${ev.kind} ${ev.nodeId || owner}`;
}

export function PipelineRunnerPanel() {
  const { t } = useI18n();
  const mana = typeof window !== 'undefined' ? window.mana : null;
  const [stage, setStage] = useState('outline');
  const [dags, setDags] = useState([]);
  const [activeDagId, setActiveDagId] = useState('');
  const [userInput, setUserInput] = useState('');
  const [events, setEvents] = useState([]);
  const [pipelineRunId, setPipelineRunId] = useState(null);
  const [running, setRunning] = useState(false);
  const [finalOutput, setFinalOutput] = useState(null);
  const [awaitingHuman, setAwaitingHuman] = useState(null);
  const [errorMsg, setErrorMsg] = useState('');
  const eventsRef = useRef(null);

  const refreshDags = useCallback(async () => {
    if (!mana?.config) return;
    const list = await mana.config.listDagsByStage(stage);
    setDags(list || []);
    if (list?.length && !list.find((d) => d.id === activeDagId)) {
      setActiveDagId(list[0].id);
    }
  }, [mana, stage, activeDagId]);

  useEffect(() => { refreshDags(); }, [refreshDags]);

  const stageDag = dags.find((d) => d.id === activeDagId) || null;

  // Subscribe to event channels
  useEffect(() => {
    if (!mana?.runtime?.on) return;
    const offPipe = mana.runtime.on('pipeline:event', (payload) => {
      if (pipelineRunId && payload.pipelineRunId !== pipelineRunId) return;
      setEvents((prev) => [...prev, { ...payload, _kind: 'pipeline' }]);
      if (payload.kind === 'awaiting_human') {
        setAwaitingHuman({ nodeId: payload.nodeId, snapshot: payload.data?.snapshot, label: payload.data?.label });
      }
      if (payload.kind === 'pipeline_done') {
        setFinalOutput(payload.data?.output);
        setRunning(false);
        setAwaitingHuman(null);
      }
      if (payload.kind === 'pipeline_error') {
        setErrorMsg(payload.data?.message || 'pipeline error');
        setRunning(false);
        setAwaitingHuman(null);
      }
    });
    const offAgent = mana.runtime.on('agent:event', (payload) => {
      if (pipelineRunId && payload.pipelineRunId !== pipelineRunId) return;
      setEvents((prev) => [...prev, { ...payload, _kind: 'agent' }]);
    });
    return () => { try { offPipe(); offAgent(); } catch { /* ignore */ } };
  }, [mana, pipelineRunId]);

  useEffect(() => {
    if (eventsRef.current) eventsRef.current.scrollTop = eventsRef.current.scrollHeight;
  }, [events]);

  const onRun = useCallback(async () => {
    if (!mana?.runtime?.runPipeline || !stageDag) return;
    setEvents([]);
    setFinalOutput(null);
    setErrorMsg('');
    setAwaitingHuman(null);
    setRunning(true);
    try {
      const res = await mana.runtime.runPipeline({
        dagId: stageDag.id,
        userInput,
        userLang: 'zh-CN',
      });
      setPipelineRunId(res.pipelineRunId);
      setFinalOutput(res.output);
    } catch (err) {
      setErrorMsg(err?.message || String(err));
    } finally {
      setRunning(false);
    }
  }, [mana, stageDag, userInput]);

  const onCancel = useCallback(async () => {
    if (!mana?.runtime?.cancelPipeline || !pipelineRunId) return;
    await mana.runtime.cancelPipeline(pipelineRunId);
  }, [mana, pipelineRunId]);

  const onResumeAccept = useCallback(async () => {
    if (!mana?.runtime?.resumePipeline || !pipelineRunId || !awaitingHuman) return;
    await mana.runtime.resumePipeline(pipelineRunId, awaitingHuman.nodeId, { decision: 'pass', note: 'ok' });
    setAwaitingHuman(null);
  }, [mana, pipelineRunId, awaitingHuman]);

  const onResumeRevise = useCallback(async () => {
    if (!mana?.runtime?.resumePipeline || !pipelineRunId || !awaitingHuman) return;
    await mana.runtime.resumePipeline(pipelineRunId, awaitingHuman.nodeId, { decision: 'revise', note: 'send back' });
    setAwaitingHuman(null);
  }, [mana, pipelineRunId, awaitingHuman]);

  const renderedEvents = useMemo(() => {
    // Build a `parent_tool_use_id → subagentId` map by walking events in order.
    // sub_agent_start carries both the toolUseId (from data.toolUseId) and the
    // subagentId; subsequent text/tool events under that Agent call carry
    // parentToolUseId pointing back to it.
    const map = new Map();
    for (const ev of events) {
      if (ev.kind === 'sub_agent_start') {
        const tid = ev.data?.toolUseId;
        const sid = ev.subagentId || ev.data?.subagentId;
        if (tid && sid) map.set(tid, sid);
      }
    }
    return events.map((ev) => fmtEventLine(ev, map));
  }, [events]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1">
          {STAGES.map((s) => (
            <Button
              key={s.value}
              size="sm"
              variant={stage === s.value ? 'solid' : 'flat'}
              color={stage === s.value ? 'primary' : 'default'}
              onPress={() => setStage(s.value)}
            >
              {t(s.tKey)}
            </Button>
          ))}
        </div>
        <label className="flex items-center gap-2 text-xs">
          <span className="text-gray-500">{t('pipeline.activeDag')}</span>
          <select
            className="bg-vscode-sidebar border border-vscode-panel-border rounded px-2 py-1 text-xs min-w-[280px]"
            value={activeDagId}
            onChange={(e) => setActiveDagId(e.target.value)}
          >
            {dags.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}{d.builtIn ? ' (built-in)' : ''}
              </option>
            ))}
            {!dags.length && <option value="">--</option>}
          </select>
        </label>
        <Button size="sm" color="primary" onPress={onRun} isDisabled={!stageDag || running}>
          {t('pipeline.run')}
        </Button>
        <Button size="sm" variant="flat" color="danger" onPress={onCancel} isDisabled={!running}>
          {t('pipeline.cancel')}
        </Button>
        {running && <Chip size="sm" color="primary" variant="flat">running</Chip>}
        {!!errorMsg && <Chip size="sm" color="danger" variant="flat">{errorMsg}</Chip>}
      </div>

      <textarea
        className="w-full bg-vscode-sidebar border border-vscode-panel-border rounded p-2 text-xs font-mono"
        rows={4}
        placeholder="主角在雨夜回到故乡，发现少年时的旧友失踪……"
        value={userInput}
        onChange={(e) => setUserInput(e.target.value)}
      />

      {awaitingHuman && (
        <div className="border border-amber-500/60 bg-amber-500/10 rounded p-3 text-xs space-y-2">
          <div className="font-bold text-amber-400">{t('pipeline.awaitingHuman')} — {awaitingHuman.label || awaitingHuman.nodeId}</div>
          <pre className="bg-vscode-sidebar p-2 rounded font-mono text-[10px] max-h-48 overflow-auto">{JSON.stringify(awaitingHuman.snapshot, null, 2)}</pre>
          <div className="flex gap-2">
            <Button size="sm" color="success" onPress={onResumeAccept}>{t('pipeline.acceptHuman')}</Button>
            <Button size="sm" variant="flat" color="warning" onPress={onResumeRevise}>{t('pipeline.reviseHuman')}</Button>
          </div>
        </div>
      )}

      <div>
        <div className="text-xs font-bold text-gray-400 mb-1">{t('pipeline.events')}</div>
        <div
          ref={eventsRef}
          className="bg-vscode-sidebar border border-vscode-panel-border rounded p-2 font-mono text-[11px] h-56 overflow-auto whitespace-pre"
        >
          {renderedEvents.length ? renderedEvents.join('\n') : '(empty)'}
        </div>
      </div>

      {finalOutput && (
        <div>
          <div className="text-xs font-bold text-gray-400 mb-1">{t('pipeline.finalOutput')}</div>
          <pre className="bg-vscode-sidebar border border-vscode-panel-border rounded p-2 font-mono text-[11px] max-h-72 overflow-auto whitespace-pre-wrap">
            {typeof finalOutput === 'string' ? finalOutput : JSON.stringify(finalOutput, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}
