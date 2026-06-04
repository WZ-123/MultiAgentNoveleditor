import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Send, Bot, User, AlertCircle, Square, RotateCcw, Wrench, Brain,
  Plus, MessageSquare, Trash2, Edit3, Undo2, Check, X, ChevronLeft,
  ChevronRight, MoreVertical, Save, Wifi, WifiOff
} from 'lucide-react';
import { appendToolUseMessage, applyToolResultMessage } from '@/components/chatToolState.mjs';
import { buildQuickFeedbackPayload } from '@/components/chatFeedbackPayload.mjs';
import { parseToolResultMeta } from '@/components/chatToolResultMeta.mjs';
import { getRecentRendererLogs, installRecentRendererLogCapture } from '@/components/recentRendererLogs.mjs';

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
  const [expandedChanges, setExpandedChanges] = useState({});
  const [restoredChanges, setRestoredChanges] = useState({});

  // ---- Write chapter confirmation ----
  const [pendingWriteChapter, setPendingWriteChapter] = useState(null);
  const [pendingCharacterProfileDecision, setPendingCharacterProfileDecision] = useState(null);
  const [pendingCharacterProfilePatch, setPendingCharacterProfilePatch] = useState(null);
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
  const sessionIdRef = useRef(sessionId);
  useEffect(() => { onReplaceRef.current = onReplaceSelectedText; }, [onReplaceSelectedText]);
  useEffect(() => { onReplaceNearCursorRef.current = onReplaceTextNearCursor; }, [onReplaceTextNearCursor]);
  useEffect(() => { onInsertRef.current = onInsertTextAtCursor; }, [onInsertTextAtCursor]);
  useEffect(() => { editorContextRef.current = editorContext; }, [editorContext]);
  useEffect(() => { sessionIdRef.current = sessionId; }, [sessionId]);

  // ====== Load threads on mount ======
  useEffect(() => {
    installRecentRendererLogCapture();
    loadThreads(currentNovelId);
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
  useEffect(() => {
    if (!mana?.chatHistory) return;
    const run = async () => {
      const list = await mana.chatHistory.listThreads(currentNovelId);
      setThreads(list || []);
      // If active thread belongs to current novel, keep it; otherwise switch to first available
      const activeBelongs = activeThreadId && list?.some((t) => t.id === activeThreadId);
      if (!activeBelongs) {
        // Active novel state can briefly flicker to null while the app refreshes
        // workspace context. Do not kill an in-flight chat turn during that gap.
        if (!currentNovelId && status !== 'idle' && (sessionId || activeThreadId)) {
          return;
        }
        if (list?.length > 0) {
          switchThread(list[0].id);
        } else {
          // No threads for this novel — close current session and clear UI
          if (sessionId && mana?.chatAgent) {
            try { await mana.chatAgent.closeSession(sessionId); } catch { /* ignore */ }
          }
          if (offEventRef.current) {
            try { offEventRef.current(); } catch { /* ignore */ }
          }
          setActiveThreadId(null);
          setMessages([]);
          setError('');
          setThinkingText('');
          setEditingId(null);
          setPendingWriteChapter(null);
          setPendingCharacterProfileDecision(null);
          setPendingCharacterProfilePatch(null);
          setSessionId(null);
        }
      }
    };
    run();
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
      switchThread(t.id);
    } catch (err) {
      setError(err?.message || String(err));
    }
  }

  async function switchThread(threadId) {
    if (threadId === activeThreadId) return;
    if (isBusy) {
      setError('AI 正在回复中，请先停止生成或等待完成后再切换对话。');
      return;
    }
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
    setPendingWriteChapter(null);
    setPendingCharacterProfileDecision(null);
    setPendingCharacterProfilePatch(null);

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
        if (offEventRef.current) {
          try { offEventRef.current(); } catch { /* ignore */ }
          offEventRef.current = null;
        }
        setSessionId(null);
        setActiveThreadId(null);
        setMessages([]);
        setError('');
        setThinkingText('');
        setEditingId(null);
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
        setSessionId(r.sessionId);
      }
      setStatus('idle');
      setThinkingText('');
    } catch (err) {
      setError(err?.message || String(err));
    }
  }

  // ====== Auto-scroll ======
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    // Delay scroll until browser has finished layout so scrollHeight is accurate
    const raf = requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
    return () => cancelAnimationFrame(raf);
  }, [messages, thinkingText]);

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
      try { runtimeDriver = await mana.runtime?.getActiveDriver?.(); } catch {}
      try {
        const alias = await mana.modelAliases?.getAlias?.('sonnet');
        model = alias?.modelId || '';
      } catch {}
      try {
        const currentProvider = await mana.ccs?.current?.();
        providerType = currentProvider?.type || currentProvider?.id || '';
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
          <div className="flex items-center gap-2 min-w-0">
            <button
              type="button"
              className="text-gray-400 hover:text-white p-1"
              onClick={() => setShowSidebar((v) => !v)}
              title={showSidebar ? '隐藏侧边栏' : '显示侧边栏'}
            >
              {showSidebar ? <ChevronLeft size={14} /> : <ChevronRight size={14} />}
            </button>
            <span className="text-xs font-bold text-gray-400 truncate min-w-0">
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
              className="text-gray-500 hover:text-gray-300 text-[10px] px-1 disabled:opacity-40"
              onClick={createThread}
              title="新建对话"
              disabled={isBusy}
            >
              <Plus size={12} />
            </button>
            {activeThreadId && (
              <button
                type="button"
                className="text-gray-500 hover:text-rose-400 text-[10px] px-1 disabled:opacity-40"
                onClick={() => deleteThread({ stopPropagation: () => {} }, activeThreadId)}
                title="删除当前对话"
                disabled={isBusy}
              >
                <Trash2 size={12} />
              </button>
            )}
            <button
              type="button"
              className="text-emerald-500 hover:text-emerald-300 text-[10px] px-1"
              onClick={openFeedbackModal}
              title="反馈 AI 聊天问题"
            >
              <AlertCircle size={12} />
            </button>
          </div>
        </div>

        {/* Messages */}
        <div ref={containerRef} className="flex-1 overflow-y-auto overflow-x-hidden p-3 space-y-3">
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
              const resultMeta = m.status === 'done' && !m.isError ? parseToolResultMeta(m.result || '') : null;
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
                <div key={m.id || idx} className="flex gap-2 min-w-0">
                  <div className="w-6 h-6 rounded-full bg-amber-600 flex items-center justify-center shrink-0">
                    <Wrench size={12} className="text-white" />
                  </div>
                  <div className="bg-vscode-active-item/50 p-2 rounded max-w-[85%] min-w-0 break-words text-sm">
                    <div className="text-amber-400 text-xs font-medium mb-1">
                      {m.status === 'running' ? `调用: ${m.name}...` : `调用: ${m.name}`}
                    </div>
                    {m.input && expandedResults[m.id] && (
                      <pre className="text-gray-400 text-[11px] overflow-x-hidden whitespace-pre-wrap break-words max-h-32 overflow-y-auto">
                        {JSON.stringify(m.input, null, 2)}
                      </pre>
                    )}
                    {m.status === 'done' && (
                      <div>
                        {expandedResults[m.id] ? (
                          <pre className="mt-1 text-[11px] text-green-400 overflow-x-hidden whitespace-pre-wrap break-words max-h-60 overflow-y-auto">
                            {m.result}
                          </pre>
                        ) : (
                          <div className={`mt-1 text-[11px] leading-relaxed ${m.isError ? 'text-rose-400' : 'text-green-400'}`}>
                            {m.isError
                              ? `错误: ${m.result?.slice(0, 180)}`
                              : `结果预览: ${m.result?.slice(0, 180)}${m.result?.length > 180 ? '…（完整内容请点「查看详情」）' : ''}`}
                          </div>
                        )}
                        {(m.input || m.result?.length > 180) && (
                          <button
                            type="button"
                            className="text-[10px] text-blue-400 hover:text-blue-300 mt-0.5"
                            onClick={() => setExpandedResults(prev => ({ ...prev, [m.id]: !prev[m.id] }))}
                          >
                            {expandedResults[m.id] ? '折叠' : '查看详情'}
                          </button>
                        )}
                        {changedFiles.length > 0 && (
                          <div className="mt-2 border border-vscode-panel-border bg-vscode-sidebar/70 rounded overflow-hidden">
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
                                  const beforePreview = String(file.beforeContent || '').slice(0, 900);
                                  const afterPreview = String(file.afterContent || '').slice(0, 900);
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
                                      <div className="grid grid-cols-1 gap-0 text-[10px]">
                                        <div className="px-2 py-1">
                                          <div className="mb-0.5 text-rose-300">变更前</div>
                                          <pre className="max-h-28 overflow-y-auto whitespace-pre-wrap break-words text-gray-400">
                                            {beforePreview || '（新建章节）'}
                                          </pre>
                                        </div>
                                        <div className="px-2 py-1 border-t border-vscode-panel-border">
                                          <div className="mb-0.5 text-green-300">变更后</div>
                                          <pre className="max-h-28 overflow-y-auto whitespace-pre-wrap break-words text-gray-300">
                                            {afterPreview || '（已删除）'}
                                          </pre>
                                        </div>
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
              <div key={m.id || idx} className={`flex gap-2 min-w-0 ${m.role === 'user' ? 'flex-row-reverse' : ''}`}>
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
                <div className={`group relative p-2 rounded text-sm whitespace-pre-wrap min-w-0 break-words ${
                  isEditing
                    ? 'w-[95%]'
                    : 'max-w-[85%]'
                } ${
                  m.role === 'user'
                    ? 'bg-primary-600/20 text-gray-200'
                    : 'bg-vscode-active-item text-gray-200'
                }`}>
                  {isEditing ? (
                    <div className="flex flex-col gap-2">
                      <textarea
                        className="bg-vscode-sidebar border border-vscode-panel-border rounded p-2 text-sm text-gray-200 w-full resize-y min-h-[200px]"
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

        {/* Character Profile Gate Card */}
        {pendingCharacterProfileDecision && (
          <div className="px-3 py-3 border-t border-sky-500/30 bg-sky-500/10 shrink-0">
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
        {pendingCharacterProfilePatch && (
          <div className="px-3 py-3 border-t border-cyan-500/30 bg-cyan-500/10 shrink-0">
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
        {pendingWriteChapter && (
          <div className="px-3 py-3 border-t border-amber-500/30 bg-amber-500/10 shrink-0">
            <div className="flex items-center gap-1.5 mb-2">
              <AlertCircle size={12} className="text-amber-400" />
              <span className="text-xs font-bold text-amber-300">章节写入请求</span>
            </div>
            <div className="text-xs text-gray-300 mb-2">
              AI 请求写入章节：
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
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="px-3 py-1.5 text-xs font-semibold rounded bg-emerald-600 text-white hover:bg-emerald-500"
                onClick={() => {
                  setInput('确认写入这一章');
                }}
              >
                确认写入
              </button>
              {pendingWriteChapter.warning && (
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
        <div className="p-2 border-t border-vscode-panel-border shrink-0">
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
          <div className="flex items-end gap-2 bg-vscode-sidebar border border-vscode-panel-border rounded px-2 py-1.5">
            <textarea
              placeholder="向 AI 提问…"
              rows={3}
              className="min-h-[4.5rem] w-full resize-none bg-transparent border-none outline-none flex-1 text-sm leading-6 text-gray-200 placeholder-gray-600 overflow-y-auto"
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
