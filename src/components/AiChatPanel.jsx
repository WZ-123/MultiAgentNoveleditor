import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Send, Bot, User, AlertCircle, Square, RotateCcw, Wrench, Brain,
  Plus, MessageSquare, Trash2, Edit3, Undo2, Check, X, ChevronLeft,
  ChevronRight, MoreVertical, Save, Wifi, WifiOff
} from 'lucide-react';
import { appendToolUseMessage, applyToolResultMessage } from '@/components/chatToolState.mjs';

export function AiChatPanel({ editorContext, onReplaceSelectedText, onReplaceTextNearCursor, onInsertTextAtCursor }) {
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

  // ---- Message state ----
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState('');
  const [thinkingText, setThinkingText] = useState('');
  const [showThinking, setShowThinking] = useState(false);

  // ---- Editing ----
  const [editingId, setEditingId] = useState(null);
  const [editText, setEditText] = useState('');

  // ---- Session (chat agent runtime) ----
  const [sessionId, setSessionId] = useState(null);
  const offEventRef = useRef(null);
  const containerRef = useRef(null);

  // ---- Online/offline ----
  const [isOnline, setIsOnline] = useState(navigator.onLine);

  // ---- Tool result expand/collapse ----
  const [expandedResults, setExpandedResults] = useState({});

  // ---- Refs for values that change independently (avoid stale closures) ----
  const onReplaceRef = useRef(onReplaceSelectedText);
  const onReplaceNearCursorRef = useRef(onReplaceTextNearCursor);
  const onInsertRef = useRef(onInsertTextAtCursor);
  const editorContextRef = useRef(editorContext);
  const handleEventRef = useRef(null);
  const sessionIdRef = useRef(sessionId);
  useEffect(() => { onReplaceRef.current = onReplaceSelectedText; }, [onReplaceSelectedText]);
  useEffect(() => { onReplaceNearCursorRef.current = onReplaceTextNearCursor; }, [onReplaceTextNearCursor]);
  useEffect(() => { onInsertRef.current = onInsertTextAtCursor; }, [onInsertTextAtCursor]);
  useEffect(() => { editorContextRef.current = editorContext; }, [editorContext]);
  useEffect(() => { sessionIdRef.current = sessionId; }, [sessionId]);

  // ====== Load threads on mount ======
  useEffect(() => {
    loadThreads();
    const onOnline = () => setIsOnline(true);
    const onOffline = () => setIsOnline(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

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
        const thread = await mana.chatHistory.getThread(activeThreadId);
        if (thread?.branch) {
          const msgs = expandThreadBranch(thread.branch);
          setMessages(msgs);
        }
      } catch (err) {
        console.error('[AiChatPanel] resume reload failed', err);
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, [activeThreadId, mana]);

  async function loadThreads() {
    if (!mana?.chatHistory) return;
    try {
      const list = await mana.chatHistory.listThreads();
      setThreads(list || []);
    } catch (err) {
      console.error('[AiChatPanel] loadThreads failed', err);
    }
  }

  // ====== Create / switch thread ======
  async function createThread() {
    if (!mana?.chatHistory) return;
    try {
      const t = await mana.chatHistory.createThread({
        title: '新对话',
        novelId: editorContext?.novelId || null,
      });
      setThreads((prev) => [t, ...prev]);
      switchThread(t.id);
    } catch (err) {
      setError(err?.message || String(err));
    }
  }

  async function switchThread(threadId) {
    // Close old session
    if (sessionId && mana?.chatAgent) {
      try { await mana.chatAgent.closeSession(sessionId); } catch { /* ignore */ }
    }
    if (offEventRef.current) {
      try { offEventRef.current(); } catch { /* ignore */ }
    }

    setActiveThreadId(threadId);
    setMessages([]);
    setError('');
    setThinkingText('');
    setEditingId(null);

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
        setSessionId(r.sessionId);
      } catch (err) {
        setError(err?.message || String(err));
      }
    }
  }

  async function deleteThread(e, threadId) {
    e.stopPropagation();
    if (!mana?.chatHistory) return;
    const ok = window.confirm('确定要删除这个对话吗？');
    if (!ok) return;
    try {
      await mana.chatHistory.deleteThread(threadId);
      setThreads((prev) => prev.filter((t) => t.id !== threadId));
      if (activeThreadId === threadId) {
        setActiveThreadId(null);
        setMessages([]);
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

  // ====== Chat agent events ======
  useEffect(() => {
    if (!sessionId || !mana?.chatAgent?.onEvent) return;
    const off = mana.chatAgent.onEvent((payload) => {
      if (!payload || payload.sessionId !== sessionIdRef.current) return;
      handleEventRef.current(payload);
    });
    offEventRef.current = off;
    return () => { try { off(); } catch { /* ignore */ } };
  }, [sessionId, activeThreadId]);

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
        break;
      case 'tool_use': {
        let finalizedMsg = null;
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last && last.role === 'assistant' && last.isStreaming) {
            const next = [...prev];
            next[next.length - 1] = { ...last, isStreaming: false };
            finalizedMsg = next[next.length - 1];
            return appendToolUseMessage(next, ev.data, Date.now());
          }
          return appendToolUseMessage(prev, ev.data, Date.now());
        });
        if (finalizedMsg) persistMessage(finalizedMsg);
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
        setMessages((prev) => {
          const next = [...prev];
          const last = next[next.length - 1];
          if (last && last.role === 'assistant' && last.isStreaming) {
            if (doneText && (!last.text || doneText.length > last.text.length)) {
              next[next.length - 1] = { ...last, text: doneText, isStreaming: false };
            } else {
              next[next.length - 1] = { ...last, isStreaming: false };
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
              });
            }
          }
          return next;
        });
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
      default:
        break;
    }
  }, [activeThreadId, sessionId]);

  // Keep handleEventRef.current up-to-date for the subscription useEffect
  handleEventRef.current = handleEvent;

  const handleFrontendAction = useCallback(async (data) => {
    const { actionId, name, input: actionInput } = data;
    let result = '';
    let isError = false;
    try {
      if (name === 'replace_selected_text' && onReplaceRef.current) {
        result = await onReplaceRef.current(actionInput.replacement || '') || 'Text replaced successfully';
      } else if (name === 'replace_text_near_cursor' && onReplaceNearCursorRef.current) {
        result = await onReplaceNearCursorRef.current(actionInput.targetText || '', actionInput.replacement || '') || 'Text replaced near cursor successfully';
      } else if (name === 'insert_text_at_cursor' && onInsertRef.current) {
        result = await onInsertRef.current(actionInput.text || '') || 'Text inserted successfully';
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
        // Create session
        if (mana?.chatAgent?.createSession) {
          const r = await mana.chatAgent.createSession({ editorContext, messages: [], threadId: currentThreadId });
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
      await mana.chatAgent.sendMessage(currentSessionId, trimmed);
    } catch (err) {
      const msg = err?.message || String(err);
      setError(msg);
      setStatus('idle');
    }
  }, [input, activeThreadId, sessionId, status, mana, editorContext]);

  const cancelGeneration = useCallback(() => {
    if (sessionId && mana?.chatAgent?.cancel) {
      mana.chatAgent.cancel(sessionId).catch(() => {});
    }
    setStatus('idle');
  }, [sessionId, mana]);

  const handleKeyDown = useCallback(
    (e) => {
      // isComposing: IME 输入法内回车确认拼音时不发送
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
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
    const ok = window.confirm('确定要回滚到这个节点吗？之后的消息将被删除。');
    if (!ok) return;
    try {
      const thread = await mana.chatHistory.revertToNode(activeThreadId, msgId);
      if (thread?.branch) {
        const localMsgs = expandThreadBranch(thread.branch);
        setMessages(localMsgs);
      }
      // Also close and recreate agent session
      if (sessionId && mana?.chatAgent) {
        try { await mana.chatAgent.closeSession(sessionId); } catch { /* ignore */ }
      }
      if (mana?.chatAgent?.createSession) {
        const r = await mana.chatAgent.createSession({ editorContext, messages: [], threadId: activeThreadId });
        setSessionId(r.sessionId);
      }
    } catch (err) {
      setError(err?.message || String(err));
    }
  }

  // ====== Auto-scroll ======
  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [messages, thinkingText]);

  const isBusy = status === 'thinking' || status === 'streaming';
  const activeThread = threads.find((t) => t.id === activeThreadId);

  return (
    <div className="flex h-full">
      {/* Sidebar — thread list */}
      {showSidebar && (
        <div className="w-56 border-r border-vscode-panel-border flex flex-col bg-vscode-sidebar shrink-0">
          <div className="h-9 border-b border-vscode-panel-border flex items-center px-3 justify-between shrink-0">
            <span className="text-xs font-bold text-gray-400">对话历史</span>
            <button
              type="button"
              className="text-gray-400 hover:text-white p-1"
              onClick={createThread}
              title="新建对话"
            >
              <Plus size={14} />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto">
            {threads.length === 0 && (
              <div className="px-3 py-2 text-xs text-gray-500">暂无对话</div>
            )}
            {threads.map((t) => (
              <div
                key={t.id}
                className={`group flex items-center gap-2 px-3 py-2 cursor-pointer text-xs ${
                  t.id === activeThreadId ? 'bg-vscode-active-item text-white' : 'text-gray-300 hover:bg-vscode-active-item'
                }`}
                onClick={() => switchThread(t.id)}
              >
                <MessageSquare size={12} className="shrink-0" />
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
      <div className="flex-1 flex flex-col h-full min-w-0">
        {/* Toolbar */}
        <div className="h-9 border-b border-vscode-panel-border flex items-center px-2 justify-between shrink-0">
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="text-gray-400 hover:text-white p-1"
              onClick={() => setShowSidebar((v) => !v)}
              title={showSidebar ? '隐藏侧边栏' : '显示侧边栏'}
            >
              {showSidebar ? <ChevronLeft size={14} /> : <ChevronRight size={14} />}
            </button>
            <span className="text-xs font-bold text-gray-400 truncate">
              {activeThread?.title || 'AI 助手'}
            </span>
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
                className="text-gray-500 hover:text-gray-300 text-[10px] px-1"
                onClick={() => setShowThinking((v) => !v)}
                title="显示/隐藏思维链"
              >
                <Brain size={12} />
              </button>
            )}
            <button
              type="button"
              className="text-gray-500 hover:text-gray-300 text-[10px] px-1"
              onClick={createThread}
              title="新建对话"
            >
              <Plus size={12} />
            </button>
            {activeThreadId && (
              <button
                type="button"
                className="text-gray-500 hover:text-rose-400 text-[10px] px-1"
                onClick={() => deleteThread({ stopPropagation: () => {} }, activeThreadId)}
                title="删除当前对话"
              >
                <Trash2 size={12} />
              </button>
            )}
          </div>
        </div>

        {/* Messages */}
        <div ref={containerRef} className="flex-1 overflow-y-auto p-3 space-y-3">
          {messages.length === 0 && (
            <div className="flex gap-2">
              <div className="w-6 h-6 rounded-full bg-blue-600 flex items-center justify-center shrink-0">
                <Bot size={14} className="text-white" />
              </div>
              <div className="bg-vscode-active-item p-2 rounded max-w-[85%] text-sm text-gray-200">
                你好！我是你的 AI 写作助手。打开一篇文档后，我可以帮你阅读大纲、修改文本、或者调用专业子代理完成复杂任务。
              </div>
            </div>
          )}

          {messages.map((m, idx) => {
            if (m.role === 'tool') {
              return (
                <div key={m.id || idx} className="flex gap-2">
                  <div className="w-6 h-6 rounded-full bg-amber-600 flex items-center justify-center shrink-0">
                    <Wrench size={12} className="text-white" />
                  </div>
                  <div className="bg-vscode-active-item/50 p-2 rounded max-w-[85%] text-sm">
                    <div className="text-amber-400 text-xs font-medium mb-1">
                      {m.status === 'running' ? `调用: ${m.name}...` : `调用: ${m.name}`}
                    </div>
                    {m.input && (
                      <pre className="text-gray-400 text-[11px] overflow-x-auto whitespace-pre-wrap">
                        {JSON.stringify(m.input, null, 2)}
                      </pre>
                    )}
                    {m.status === 'done' && (
                      <div>
                        {expandedResults[m.id] ? (
                          <pre className="mt-1 text-[11px] text-green-400 overflow-x-auto whitespace-pre-wrap max-h-60 overflow-y-auto">
                            {m.result}
                          </pre>
                        ) : (
                          <div className={`mt-1 text-[11px] ${m.isError ? 'text-rose-400' : 'text-green-400'}`}>
                            {m.isError
                              ? `错误: ${m.result?.slice(0, 500)}`
                              : `结果: ${m.result?.slice(0, 500)}${m.result?.length > 500 ? '...' : ''}`}
                          </div>
                        )}
                        {m.result?.length > 500 && (
                          <button
                            type="button"
                            className="text-[10px] text-blue-400 hover:text-blue-300 mt-0.5"
                            onClick={() => setExpandedResults(prev => ({ ...prev, [m.id]: !prev[m.id] }))}
                          >
                            {expandedResults[m.id] ? '折叠' : '展开全部'}
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              );
            }

            const isEditing = editingId === m.id;

            return (
              <div key={m.id || idx} className={`flex gap-2 ${m.role === 'user' ? 'flex-row-reverse' : ''}`}>
                <div
                  className={`w-6 h-6 rounded-full flex items-center justify-center shrink-0 ${
                    m.role === 'user' ? 'bg-gray-600' : 'bg-blue-600'
                  }`}
                >
                  {m.role === 'user' ? (
                    <User size={14} className="text-white" />
                  ) : (
                    <Bot size={14} className="text-white" />
                  )}
                </div>
                <div className={`group relative p-2 rounded max-w-[85%] text-sm whitespace-pre-wrap ${
                  m.role === 'user'
                    ? 'bg-primary-600/20 text-gray-200'
                    : 'bg-vscode-active-item text-gray-200'
                }`}>
                  {isEditing ? (
                    <div className="flex flex-col gap-1">
                      <textarea
                        className="bg-vscode-sidebar border border-vscode-panel-border rounded p-1 text-sm text-gray-200 w-full resize-none"
                        rows={Math.min(10, editText.split("\\n").length + 2)}
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
                      {String(m.text ?? '')}
                      {m.isStreaming && (
                        <span className="inline-block w-1.5 h-3 bg-blue-400 ml-0.5 animate-pulse" />
                      )}
                      {m.edited && (
                        <span className="text-[9px] text-gray-500 ml-1">(已编辑)</span>
                      )}
                      {/* Action buttons for assistant messages */}
                      {m.role === 'assistant' && !m.isStreaming && (
                        <div className="absolute -right-1 -top-1 hidden group-hover:flex items-center gap-0.5 bg-vscode-sidebar border border-vscode-panel-border rounded px-1 py-0.5">
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
                            title="回滚到这个节点"
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

          {isBusy && !messages.some((m) => m.isStreaming) && (
            <div className="flex gap-2">
              <div className="w-6 h-6 rounded-full bg-blue-600 flex items-center justify-center shrink-0">
                <Bot size={14} className="text-white" />
              </div>
              <div className="bg-vscode-active-item p-2 rounded text-sm text-gray-400">
                <span className="inline-block w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce mr-0.5" />
                <span className="inline-block w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce mr-0.5 [animation-delay:0.1s]" />
                <span className="inline-block w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce [animation-delay:0.2s]" />
              </div>
            </div>
          )}

          {showThinking && thinkingText && (
            <div className="flex gap-2">
              <div className="w-6 h-6 rounded-full bg-purple-600 flex items-center justify-center shrink-0">
                <Brain size={12} className="text-white" />
              </div>
              <div className="bg-purple-900/30 p-2 rounded max-w-[85%] text-sm text-purple-200 italic">
                {thinkingText}
              </div>
            </div>
          )}
        </div>

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

        {/* Input */}
        <div className="p-2 border-t border-vscode-panel-border shrink-0">
          <div className="flex gap-2 bg-vscode-sidebar border border-vscode-panel-border rounded px-2 py-1.5">
            <input
              type="text"
              placeholder="向 AI 提问…"
              className="bg-transparent border-none outline-none flex-1 text-sm text-gray-200 placeholder-gray-600"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={isBusy}
            />
            {isBusy ? (
              <button
                className="p-1 hover:bg-rose-900/30 rounded text-rose-400"
                onClick={cancelGeneration}
                title="停止生成"
              >
                <Square size={16} />
              </button>
            ) : (
              <button
                className="p-1 hover:bg-vscode-active-item rounded disabled:opacity-40"
                onClick={sendMessage}
                disabled={!input.trim()}
              >
                <Send size={16} className="text-primary-400" />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
