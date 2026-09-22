import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Bot, Check, ChevronLeft, MessageSquare, Plus, Send, ShieldCheck, Square, Trash2, X } from 'lucide-react';
import { ChatMarkdown } from '@/components/ChatMarkdown.jsx';
import { mergeRunState, terminalRun } from '@/components/chatRunState.mjs';
import { taskConstraintsFor } from '@/components/writingTaskConstraints.mjs';

export { taskConstraintsFor } from '@/components/writingTaskConstraints.mjs';

function id(prefix) {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
}

function displayItemStatus(status) {
  return ({ inProgress: '运行中', running: '运行中', completed: '已完成', failed: '失败', interrupted: '已中断', user_rejected: '用户已拒绝', declined: '未获批准' })[status] || status || '已接收';
}

function progressPhaseLabel(phase) {
  return ({
    'waiting-model': '等待模型响应', reasoning: '推理中', 'tool-running': '工具执行中', 'waiting-approval': '等待批准',
    completed: '本回合已结束', 'goal-incomplete': '本回合已结束', failed: '执行失败', interrupted: '已停止',
  })[phase] || '准备中';
}

function chapterLabel(resourceRef) {
  return resourceRef?.startsWith('chapter:') ? resourceRef.slice('chapter:'.length) : '待确定';
}

function NativePatchDiff({ diff }) {
  const lines = String(diff || '').split(/\r?\n/u);
  return (
    <pre data-testid="native-patch-diff" className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-black/25 p-2 text-[10px] leading-5">
      {lines.map((line, index) => {
        const isAdded = line.startsWith('+') && !line.startsWith('+++');
        const isRemoved = line.startsWith('-') && !line.startsWith('---');
        const className = isAdded
          ? 'block rounded bg-emerald-500/15 px-1 text-emerald-100'
          : isRemoved
            ? 'block rounded bg-rose-500/15 px-1 text-rose-100'
            : line.startsWith('@@')
              ? 'block px-1 text-sky-200'
              : 'block px-1 text-gray-200';
        const testId = isAdded ? 'native-patch-line-added' : isRemoved ? 'native-patch-line-removed' : undefined;
        return <span key={`${index}-${line}`} data-testid={testId} className={className}>{line || ' '}</span>;
      })}
    </pre>
  );
}

function ConfirmationCard({ request, onResolve }) {
  const [busy, setBusy] = useState(false);
  const preview = request?.arguments?.preview || [];
  const nativeChanges = request?.arguments?.nativeChanges || [];
  const resolve = async (accept) => {
    setBusy(true);
    try { await onResolve(request.confirmationId, accept); } finally { setBusy(false); }
  };
  return (
    <div data-testid="codex-confirmation-card" className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs">
      <div className="font-semibold text-amber-100">等待确认：{request.tool}</div>
      <div className="mt-1 text-gray-300">{request.arguments?.reason || '确认后才会写入小说资源。'}</div>
      <div className="mt-2 max-h-56 space-y-2 overflow-auto">
        {preview.map((item) => (
          <details key={item.resourceRef} className="rounded border border-white/10 bg-black/20 p-2">
            <summary className="cursor-pointer text-gray-200">{item.resourceRef} · {item.mode}</summary>
            <div className="mt-2 grid gap-2">
              <pre className="max-h-32 overflow-auto whitespace-pre-wrap rounded bg-rose-950/20 p-2 text-[10px] text-rose-100">{item.before ?? '（不存在）'}</pre>
              <pre className="max-h-32 overflow-auto whitespace-pre-wrap rounded bg-emerald-950/20 p-2 text-[10px] text-emerald-100">{item.after ?? '（删除）'}</pre>
            </div>
          </details>
        ))}
        {preview.length === 0 && nativeChanges.map((item, index) => (
          <details key={item.path || item.filePath || index} open className="rounded border border-white/10 bg-black/20 p-2">
            <summary className="cursor-pointer text-gray-200">{item.resourceRef || item.path || item.filePath || item.name || `原生文件变更 ${index + 1}`}</summary>
            <div className="mt-1 text-[10px] text-gray-500">{item.path || item.filePath || ''}</div>
            <NativePatchDiff diff={typeof item === 'string' ? item : item.diff || JSON.stringify(item, null, 2)} />
          </details>
        ))}
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <button disabled={busy} onClick={() => resolve(false)} className="flex items-center gap-1 rounded border border-white/10 px-3 py-1.5 text-gray-300 hover:bg-white/5"><X size={12} />拒绝</button>
        <button disabled={busy} onClick={() => resolve(true)} className="flex items-center gap-1 rounded bg-emerald-600 px-3 py-1.5 text-white hover:bg-emerald-500"><Check size={12} />确认写入</button>
      </div>
    </div>
  );
}

function storedValue(key, fallback) {
  try { return JSON.parse(sessionStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function saveValue(key, value) { try { sessionStorage.setItem(key, JSON.stringify(value)); } catch { /* session storage can be unavailable */ } }

function ExecutionResult({ execution }) {
  if (!execution) return <div className="mt-2 text-[10px] text-gray-500">无执行记录</div>;
  const resources = execution.savedResources || [];
  return <div data-testid="execution-result" className="mt-2 border-t border-white/10 pt-2 text-xs text-gray-400">
    <div>{({ completed: '本回合已结束', failed: '执行失败', interrupted: '已停止', finalizing: '正在保存结果' })[execution.status] || '执行中'} · {resources.length ? `已保存 ${resources.length} 项修改` : '无正式保存记录'}</div>
    {resources.map((r, i) => <div key={`${r.resourceRef}-${i}`} className="text-emerald-300">{r.resourceRef} · {r.mode || '已提交'}</div>)}
    {execution.error && <div className="text-rose-300">{execution.error}</div>}
    {execution.status !== 'completed' && resources.length > 0 && <div>此前保存已保留，后续内容未完成。</div>}
    {execution.taskResult && <div>目标验证：{execution.taskResult.goalVerified ? '宿主检查通过（不代表内容质量全部通过）' : '尚未验证完整目标'}</div>}
  </div>;
}

export function AiChatPanel({ editorContext, onBeforeSendMessage, onOpenModelSettings }) {
  const mana = window.mana;
  const novelId = editorContext?.novelId || null;
  const projectKey = `mana-chat:${novelId || 'none'}`;
  const [activeId, setActiveId] = useState(() => storedValue(`${projectKey}:active`, ''));
  const [threads, setThreads] = useState([]);
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState({ text: '' });
  const [snapshot, setSnapshot] = useState(null);
  const [status, setStatus] = useState({ ready: false });
  const [authorization, setAuthorization] = useState(null);
  const [authorizationBusy, setAuthorizationBusy] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [lastAttempt, setLastAttempt] = useState(null);
  const [error, setError] = useState('');
  const [sidebar, setSidebar] = useState(false);
  const [clock, setClock] = useState(Date.now());
  const sending = useRef(false);
  const activeRef = useRef(activeId);
  const loadVersion = useRef(0);
  const endRef = useRef(null);
  const draftKey = `${projectKey}:draft:${activeId || 'new'}`;
  const run = snapshot && !terminalRun(snapshot) ? snapshot : null;
  const confirmation = run?.confirmation;
  const progress = snapshot?.progress;
  activeRef.current = activeId;

  const changeDraft = useCallback(value => {
    setDraft(value); saveValue(draftKey, value);
  }, [draftKey]);
  const loadThreads = useCallback(async () => {
    const list = await mana.chatHistory.listThreads(novelId);
    setThreads(list || []);
    return list || [];
  }, [mana, novelId]);
  const refreshHistory = useCallback(async (conversationId) => {
    const result = await mana.chatHistory.getThread(conversationId);
    if (activeRef.current === conversationId && String(result?.novelId || '') === String(novelId || '')) setMessages(result?.branch || []);
  }, [mana, novelId]);

  useEffect(() => {
    let cancelled = false;
    loadThreads().then(list => {
      if (!cancelled && !list.some(t => t.id === activeRef.current)) setActiveId(list[0]?.id || '');
    }).catch(e => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [loadThreads]);
  useEffect(() => {
    let cancelled = false;
    const refresh = () => mana.codex.status().then(value => { if (!cancelled) setStatus(value); }).catch(e => { if (!cancelled) setError(e.message); });
    refresh(); const off = mana.modelConfig?.onChanged?.(refresh);
    return () => { cancelled = true; off?.(); };
  }, [mana]);

  // Subscribe before loading the snapshot. Versions keep late replies from replacing new events.
  useEffect(() => mana.codex.onEvent(event => {
    if (event.type === 'writing_authorization_changed' && event.novelId === novelId) setAuthorization(event.authorization);
    if (!event.conversationId || event.conversationId !== activeRef.current) return;
    if (String(event.novelId || '') !== String(novelId || '')) return;
    if (event.runState) setSnapshot(old => mergeRunState(old, event.runState));
    if (event.type === 'checkpoint_failed') setError(event.error || '结果保存失败');
    if (['turn_completed', 'turn_failed', 'turn_interrupted'].includes(event.type)) {
      setError(event.error || '');
      refreshHistory(event.conversationId).catch(e => setError(e.message));
      loadThreads().catch(() => {});
    }
  }), [mana, novelId, refreshHistory, loadThreads]);
  useEffect(() => {
    const version = ++loadVersion.current;
    saveValue(`${projectKey}:active`, activeId);
    setDraft(storedValue(draftKey, { text: '' }));
    setSnapshot(null); setMessages([]); setError(''); setLastAttempt(storedValue(`${draftKey}:attempt`, null));
    if (!activeId) return undefined;
    const refresh = async () => {
      const [thread, state] = await Promise.all([mana.chatHistory.getThread(activeId), mana.codex.getConversationState({ conversationId: activeId })]);
      if (version !== loadVersion.current) return;
      if (String(thread?.novelId || '') !== String(novelId || '')) { setActiveId(''); return; }
      setMessages(thread?.branch || []);
      setSnapshot(old => mergeRunState(old, state.run));
      if (state.run?.error) setError(state.run.error);
    };
    refresh().catch(e => { if (version === loadVersion.current) setError(e.message); });
    const focus = () => refresh().catch(e => setError(e.message));
    window.addEventListener('focus', focus); window.addEventListener('online', focus);
    return () => { loadVersion.current++; window.removeEventListener('focus', focus); window.removeEventListener('online', focus); };
  }, [activeId, draftKey, mana, novelId, projectKey]);
  useEffect(() => {
    let cancelled = false;
    if (novelId) mana.codex.getWritingAuthorization(novelId).then(v => { if (!cancelled) setAuthorization(v); }).catch(e => setError(e.message));
    return () => { cancelled = true; };
  }, [mana, novelId]);
  useEffect(() => {
    const handler = event => {
      const value = { text: String(event.detail?.text || ''), skillName: event.detail?.skillName,
        editorContext: event.detail?.editorContext, editScope: event.detail?.editScope };
      const target = event.detail?.novelId || novelId;
      const key = `mana-chat:${target || 'none'}`;
      const threadId = storedValue(`${key}:active`, '');
      saveValue(`${key}:draft:${threadId || 'new'}`, value);
      if (String(target || '') === String(novelId || '')) setDraft(value);
    };
    window.addEventListener('mana:codex-prompt', handler);
    return () => window.removeEventListener('mana:codex-prompt', handler);
  }, [novelId]);
  useEffect(() => { if (!run) return undefined; const timer = setInterval(() => setClock(Date.now()), 1000); return () => clearInterval(timer); }, [run?.runId]);
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }); }, [messages, snapshot?.text, confirmation]);

  const send = useCallback(async (retry = false) => {
    if (sending.current || run) return;
    const text = retry && lastAttempt ? lastAttempt.text : draft.text.trim();
    if (!text) return;
    sending.current = true; setPreparing(true); setError('');
    let attempt = retry && lastAttempt ? { ...lastAttempt } : null;
    try {
      if (attempt) {
        const known = await mana.codex.getRunState({ runId: attempt.runId });
        if (known && !terminalRun(known)) { setSnapshot(old => mergeRunState(old, known)); return; }
        // A user-requested retry is a new attempt; the stored user message is reused.
        if (known) attempt.runId = id('run');
      }
      const target = attempt?.editorContext || draft.editorContext || editorContext;
      if (String(target?.novelId || '') !== String(novelId || '')) throw new Error('命令属于其他小说，请返回原项目');
      await onBeforeSendMessage?.(target);
      let conversationId = attempt?.conversationId || activeId;
      if (!conversationId) {
        const thread = await mana.chatHistory.createThread({ title: text.slice(0, 28), novelId });
        conversationId = thread.id;
        saveValue(`${projectKey}:draft:${conversationId}`, draft);
        if (activeRef.current === activeId) { activeRef.current = conversationId; setActiveId(conversationId); }
      }
      attempt ||= { runId: id('run'), userMessageId: id('msg'), conversationId, novelId, persistence: 'chat', text,
        skillName: draft.skillName, editorContext: target, editScope: draft.editScope || { mode: 'unrestricted' },
        taskConstraints: taskConstraintsFor(text, draft.skillName, { ...target, editScope: draft.editScope }) };
      setLastAttempt(attempt);
      saveValue(`${projectKey}:draft:${conversationId}:attempt`, attempt);
      await mana.codex.startTurn(attempt);
      saveValue(`${projectKey}:draft:${conversationId}`, { text: '' });
      if (activeRef.current === conversationId) setDraft({ text: '' });
      const state = await mana.codex.getRunState({ runId: attempt.runId });
      if (activeRef.current === conversationId) setSnapshot(old => mergeRunState(old, state));
      await refreshHistory(conversationId); await loadThreads();
    } catch (e) {
      if (activeRef.current === (attempt?.conversationId || activeId)) setError(e.message || String(e));
      if (attempt) {
        if (activeRef.current === attempt.conversationId) setLastAttempt(attempt);
        try {
          const state = await mana.codex.getRunState({ runId: attempt.runId });
          if (activeRef.current === attempt.conversationId) setSnapshot(old => mergeRunState(old, state));
          await refreshHistory(attempt.conversationId);
        } catch { /* Keep the request identity until the host can be queried. */ }
      }
    } finally { sending.current = false; setPreparing(false); }
  }, [run, lastAttempt, draft, editorContext, novelId, onBeforeSendMessage, activeId, projectKey, mana, refreshHistory, loadThreads]);

  const toggleAuthorization = async () => {
    if (!novelId || authorizationBusy) return;
    setAuthorizationBusy(true);
    try { setAuthorization(authorization?.granted ? await mana.codex.revokeWritingAuthorization(novelId) : await mana.codex.setWritingAuthorization(novelId, 'append-prose')); }
    catch (e) { setError(e.message); } finally { setAuthorizationBusy(false); }
  };
  const createThread = async () => {
    try { const thread = await mana.chatHistory.createThread({ title: '新对话', novelId }); setActiveId(thread.id); setSidebar(false); await loadThreads(); }
    catch (e) { setError(e.message); }
  };
  const visible = messages.filter(m => ['user', 'assistant'].includes(m.role) && !m.isStreaming);
  const capability = run ? ({ preparing: '正在准备工具', 'project-tools': '本回合项目工具可用', 'text-only': '本回合仅文本，不能读写项目' })[run.capability]
    : novelId && status.toolStatus === 'ok' ? '项目工具待启动' : '仅文本，不能读写项目';

  return <div data-testid="codex-chat-panel" data-run-state={snapshot?.status || 'idle'} className="relative flex h-full min-h-0 bg-[#171717] text-gray-200">
    {sidebar && <aside className="absolute inset-y-0 left-0 z-20 w-64 overflow-auto border-r border-white/10 bg-[#181818] p-2 shadow-xl">
      <div className="flex justify-between"><span>对话</span><button aria-label="关闭对话列表" onClick={() => setSidebar(false)}><ChevronLeft size={15} /></button></div>
      <button onClick={createThread} className="my-2 flex gap-2 p-2"><Plus size={13} />新对话</button>
      {threads.map(t => <div key={t.id} className={`flex rounded ${t.id === activeId ? 'bg-white/10' : ''}`}>
        <button onClick={() => { setActiveId(t.id); setSidebar(false); }} className="min-w-0 flex-1 truncate p-2 text-left text-xs">{t.title}</button>
        <button aria-label="删除对话" className="p-2" onClick={async () => { try { await mana.chatHistory.deleteThread(t.id); if (activeId === t.id) setActiveId(''); await loadThreads(); } catch (e) { setError(e.message); } }}><Trash2 size={12} /></button>
      </div>)}
    </aside>}
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="flex min-h-9 shrink-0 items-center justify-between gap-2 border-b border-white/10 px-2 py-1">
        <button aria-label="对话列表" onClick={() => setSidebar(true)}><MessageSquare size={14} /></button>
        <span data-testid="codex-status" data-capability={run?.capability || 'idle'} className="text-[10px] text-emerald-300">{status.ready ? `${status.modelId} · ${capability}` : '连接未就绪'}</span>
        <div className="flex shrink-0 items-center gap-2 text-[10px]">
          {novelId && <button data-testid="writing-authorization-toggle" disabled={authorizationBusy} onClick={toggleAuthorization} title="仅新章和章末追加可自动保存" className="flex items-center gap-1"><ShieldCheck size={11} />{authorization?.granted ? '新增正文已允许' : '逐次确认'}</button>}
          <button onClick={onOpenModelSettings}>模型</button>
        </div>
      </div>
      {progress && <div data-testid="writing-progress" className="border-b border-white/10 px-3 py-2 text-[10px] text-gray-400">
        {progressPhaseLabel(confirmation ? 'waiting-approval' : progress.phase)} · {chapterLabel(progress.currentResourceRef)} · 已保存 {progress.totalSavedBodyCjk || 0} 字 · 本次 {progress.runNetBodyCjk || 0} 字
        {run && <span> · {Math.max(0, Math.floor((clock - progress.startedAtMs) / 1000))}s</span>}
        <div>最近保存：{progress.lastSavedAt ? new Date(progress.lastSavedAt).toLocaleTimeString() : '尚未保存'}</div>
      </div>}
      <div className="flex-1 space-y-3 overflow-y-auto p-3">
        {!visible.length && !run && <div className="mx-auto mt-12 max-w-xs text-center text-xs leading-6 text-gray-500">在项目中可直接要求读取或修改资料。修改会展示差异；是否保存以宿主提交记录为准。</div>}
        {visible.map(message => <div data-testid={`codex-message-${message.role}`} key={message.id} className={`flex gap-2 ${message.role === 'user' ? 'justify-end' : ''}`}>
          {message.role === 'assistant' && <Bot size={15} className="mt-1 shrink-0 text-blue-300" />}
          <div className={`max-w-[90%] rounded-2xl px-3 py-2 text-sm leading-6 ${message.role === 'user' ? 'bg-blue-600' : 'bg-white/[0.06]'}`}>
            {message.role === 'assistant' ? <><ChatMarkdown content={message.text || ''} /><ExecutionResult execution={message.execution} />
              {message.toolCalls?.some(item => !['userMessage', 'agentMessage', 'reasoning'].includes(item.type)) && <details className="mt-2 text-xs text-gray-400"><summary>工具记录</summary>{message.toolCalls.filter(item => !['userMessage', 'agentMessage', 'reasoning'].includes(item.type)).map((item, i) => <div key={item.id || i}>{item.name || item.tool || item.type} · {displayItemStatus(item.status)}</div>)}</details>}
            </> : <span className="whitespace-pre-wrap">{message.text}</span>}
          </div>
        </div>)}
        {run?.items?.length > 0 && <div className="rounded border border-white/10 p-2 text-xs text-gray-400">{run.items.filter(item => !['userMessage', 'agentMessage'].includes(item.type)).slice(-8).map((item, i) => <div key={item.id || i}>{item.name || item.tool || item.type} · {displayItemStatus(item.status)}</div>)}</div>}
        {run?.text && <div data-testid="codex-streaming-message" className="rounded-2xl bg-white/[0.06] p-3 text-sm"><ChatMarkdown content={run.text} /></div>}
        {run?.savedResources?.length > 0 && <ExecutionResult execution={run} />}
        {confirmation && <ConfirmationCard request={confirmation} onResolve={async (confirmationId, accept) => {
          try { await mana.codex.resolveConfirmation({ confirmationId, runId: run.runId, accept }); const state = await mana.codex.getRunState({ runId: run.runId }); if (activeRef.current === run.conversationId) setSnapshot(old => mergeRunState(old, state)); }
          catch (e) { if (activeRef.current === run.conversationId) setError(e.message); }
        }} />}
        {error && <div data-testid="codex-error" className="rounded border border-rose-500/25 bg-rose-500/10 p-2 text-xs text-rose-200">{error}{lastAttempt && !run && <button className="ml-2 underline" onClick={() => send(true)}>查询状态并重试</button>}</div>}
        <div ref={endRef} />
      </div>
      <div className="shrink-0 border-t border-white/10 p-2">
        {draft.editScope && <div data-testid="chat-edit-scope" className="mb-2 flex items-center justify-between gap-2 text-xs text-amber-200"><span className="min-w-0 break-all">目标：{draft.editScope.resourceRef} · {draft.editScope.mode === 'insertion' ? '在光标插入' : '仅修改选区'} {draft.editScope.start}–{draft.editScope.end}</span><button className="shrink-0 whitespace-nowrap" onClick={() => changeDraft({ text: draft.text })}>清除范围</button></div>}
        {!status.ready && <button onClick={onOpenModelSettings} className="mb-2 text-xs text-amber-200">配置模型连接</button>}
        <div className="flex items-end gap-2 rounded-xl border border-white/10 bg-black/20 p-2">
          <textarea data-testid="codex-input" value={draft.text} onChange={e => changeDraft({ ...draft, text: e.target.value })} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} rows={2} disabled={!status.ready} placeholder="随心输入" className="max-h-32 min-h-10 flex-1 resize-none bg-transparent text-sm outline-none" />
          {run ? <button aria-label="停止" onClick={async () => { try { await mana.codex.interrupt({ runId: run.runId }); } catch (e) { setError(e.message); } }} className="rounded bg-rose-600 p-2"><Square size={14} /></button>
            : <button aria-label="发送" disabled={preparing || !status.ready || !draft.text.trim()} onClick={() => send()} className="rounded bg-blue-600 p-2 disabled:opacity-30"><Send size={14} /></button>}
        </div>
      </div>
    </div>
  </div>;
}
