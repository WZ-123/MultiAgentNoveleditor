import { parseToolResultMeta } from './chatToolResultMeta.mjs';

function truncateText(value, limit = 600) {
  const text = typeof value === 'string' ? value : value == null ? '' : String(value);
  if (!text || text.length <= limit) return text;
  return `${text.slice(0, limit)}...`;
}

function sanitizeThreadMeta(thread) {
  if (!thread || typeof thread !== 'object') return null;
  return {
    id: thread.id || '',
    title: thread.title || '',
    novelId: thread.novelId || null,
    updatedAt: thread.updatedAt || null,
  };
}

function buildRecentMessages(messages, limit = 8) {
  return (Array.isArray(messages) ? messages : [])
    .filter((message) => message && typeof message === 'object' && message.role !== 'tool')
    .slice(-limit)
    .map((message) => ({
      id: message.id || '',
      role: message.role || 'unknown',
      text: truncateText(message.text || '', 500),
      timestamp: message.timestamp || null,
      edited: !!message.edited,
    }));
}

function buildRecentToolCalls(messages, limit = 5) {
  return (Array.isArray(messages) ? messages : [])
    .filter((message) => message && typeof message === 'object' && message.role === 'tool')
    .slice(-limit)
    .map((message) => {
      const meta = parseToolResultMeta(message.result || '');
      return {
        id: message.id || '',
        toolUseId: message.toolUseId || null,
        name: message.name || 'unknown',
        status: message.status || 'done',
        isError: !!message.isError,
        input: message.input || null,
        resultSummary: truncateText(meta.summary || message.result || '', 500),
        changedFiles: meta.changedFiles,
        checkpoint: meta.checkpoint,
        timestamp: message.timestamp || null,
      };
    });
}

function pickLatestCheckpoint(toolCalls) {
  for (let index = toolCalls.length - 1; index >= 0; index -= 1) {
    if (toolCalls[index]?.checkpoint) return toolCalls[index].checkpoint;
  }
  return null;
}

function buildLatestChangedFiles(toolCalls) {
  for (let index = toolCalls.length - 1; index >= 0; index -= 1) {
    if (Array.isArray(toolCalls[index]?.changedFiles) && toolCalls[index].changedFiles.length) {
      return toolCalls[index].changedFiles;
    }
  }
  return [];
}

function findLatestLog(logs, predicate = () => true) {
  const items = Array.isArray(logs) ? logs : [];
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index])) return items[index];
  }
  return null;
}

export function buildQuickFeedbackPayload({
  issueTitle,
  actualBehavior,
  expectedBehavior,
  reproductionSteps,
  reproMode,
  severity,
  includeLogs,
  currentNovelId,
  editorContext,
  activeThread,
  sessionId,
  messages,
  status,
  uiError,
  runtimeDriver,
  providerType,
  model,
  recentRendererLogs,
  includeScreenshot,
}) {
  const toolCalls = buildRecentToolCalls(messages, includeLogs ? 6 : 3);
  const recentMessages = includeLogs ? buildRecentMessages(messages, 8) : [];
  const latestCheckpoint = includeLogs ? pickLatestCheckpoint(toolCalls) : null;
  const latestChangedFiles = includeLogs ? buildLatestChangedFiles(toolCalls) : [];
  const editor = editorContext && typeof editorContext === 'object' ? editorContext : {};
  const rendererLogs = includeLogs
    ? (Array.isArray(recentRendererLogs) ? recentRendererLogs.slice(-20) : [])
    : [];
  const feedbackId = `fb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  return {
    feedbackId,
    createdAt: new Date().toISOString(),
    channel: 'quick-feedback',
    userInput: {
      issueTitle: issueTitle || '未命名反馈',
      actualBehavior: actualBehavior || '',
      expectedBehavior: expectedBehavior || '',
      reproductionSteps: Array.isArray(reproductionSteps)
        ? reproductionSteps.filter(Boolean)
        : typeof reproductionSteps === 'string' && reproductionSteps.trim()
          ? reproductionSteps.split('\n').map((item) => item.trim()).filter(Boolean)
          : [],
      reproducibility: reproMode || 'unknown',
      severity: severity || 'medium',
      feedbackMode: includeLogs ? 'context-with-logs' : 'opinion-only',
    },
    environment: {
      platform: typeof navigator !== 'undefined' ? navigator.platform || '' : '',
      locale: typeof navigator !== 'undefined' ? navigator.language || '' : '',
      isOnline: typeof navigator !== 'undefined' ? navigator.onLine : true,
      activeRuntimeDriver: runtimeDriver || '',
      activeProviderType: providerType || '',
      activeModel: model || '',
    },
    novelContext: {
      activeNovelId: currentNovelId || '',
      isBlankProject: !currentNovelId,
    },
    editorContext: {
      editorType: editor.type || 'none',
      activeChapterId: editor.chapterId || '',
      activeChapterName: editor.chapterFileName || editor.title || editor.chapterId || '',
      activeChapterTitle: editor.chapterDisplayName || editor.title || '',
      selectionText: includeLogs ? truncateText(editor.selectedText || '', 400) : '',
      selectionStart: includeLogs && Number.isInteger(editor.selectionStart) ? editor.selectionStart : null,
      selectionEnd: includeLogs && Number.isInteger(editor.selectionEnd) ? editor.selectionEnd : null,
      contentExcerpt: includeLogs ? truncateText(editor.content || '', 1200) : '',
    },
    chatContext: {
      activeThread: sanitizeThreadMeta(activeThread),
      currentSessionId: sessionId || '',
      currentSessionStatus: status || 'idle',
      lastUserPrompt: includeLogs
        ? buildRecentMessages(messages, 8).filter((message) => message.role === 'user').slice(-1)[0]?.text || ''
        : '',
      recentMessages,
      recentToolCalls: toolCalls,
    },
    changeContext: {
      latestCheckpoint,
      latestChangedFiles,
    },
    recentLogs: {
      renderer: rendererLogs,
    },
    errors: {
      latestUiError: includeLogs ? truncateText(uiError || '', 800) : '',
      latestRendererError: includeLogs
        ? findLatestLog(rendererLogs, (item) => item?.level === 'error' || item?.source === 'window-error' || item?.source === 'window-rejection')
        : null,
      latestToolFailure: includeLogs
        ? toolCalls.filter((toolCall) => toolCall.isError).slice(-1)[0] || null
        : null,
    },
    attachments: includeScreenshot ? [{ kind: 'window-screenshot', label: '当前窗口截图', status: 'requested' }] : [],
  };
}
