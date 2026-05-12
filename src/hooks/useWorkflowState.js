import { useCallback, useMemo, useRef, useState } from 'react';
import {
  confirmOutline,
  createInitialOutlineState,
  dismissOutlineIssues,
  runOutlinePipeline,
  startOutlineInput,
} from '@/services/outlineOrchestrator.js';
import {
  buildCharacterContextFromArtifact,
  bulkRewriteUnresolved,
  createWritingSession,
  finalizeChapter,
  generateRemoteDraft,
  markReadyToSave,
  requestPeekRewrite,
  resolvePeek,
  runAgent4Style,
  runAgent5Quality,
  runAgent6ChapterSave,
  setWritingRequirements,
  applyQualityChoice,
  applyStyleAction,
  bulkKeepAllQuality,
} from '@/services/writingOrchestrator.js';
import { loadStyleMemory, saveStyleMemory } from '@/services/styleMemoryStore.js';

/**
 * 串联大纲阶段与撰写阶段状态机；异步步骤用 ref 读取最新 state。
 */
export function useWorkflowState() {
  const [outline, setOutline] = useState(() => createInitialOutlineState());
  const [writing, setWriting] = useState(() => createWritingSession(''));
  const [styleMemoryDraft, setStyleMemoryDraft] = useState(() => loadStyleMemory());
  const [busy, setBusy] = useState(false);

  const outlineRef = useRef(outline);
  const writingRef = useRef(writing);
  outlineRef.current = outline;
  writingRef.current = writing;

  const outlineText = useMemo(
    () => outline.artifact?.rawMarkdown ?? '',
    [outline.artifact]
  );

  const startInput = useCallback((mode, userText) => {
    setOutline((s) => startOutlineInput(s, { mode, userText }));
  }, []);

  const runOutline = useCallback(async (readCharacter) => {
    setBusy(true);
    try {
      const next = await runOutlinePipeline(outlineRef.current);
      setOutline(next);
      if (next.artifact) {
        // 如果有 readCharacter 回调，自动装配角色上下文（AB混用A方案）
        let charCtx = null;
        if (typeof readCharacter === 'function') {
          charCtx = await buildCharacterContextFromArtifact(next.artifact, readCharacter);
        }
        setWriting(createWritingSession(next.artifact.rawMarkdown, null, charCtx));
      }
    } finally {
      setBusy(false);
    }
  }, []);

  const resolveIssues = useCallback((ids) => {
    setOutline((s) => dismissOutlineIssues(s, ids));
  }, []);

  const confirm = useCallback(() => {
    setOutline((s) => confirmOutline(s));
  }, []);

  const applyReq = useCallback((targetWordCount, chapterCount, extraNotes) => {
    setWriting((s) =>
      setWritingRequirements(s, { targetWordCount, chapterCount, extraNotes })
    );
  }, []);

  const genDraft = useCallback(async () => {
    setBusy(true);
    try {
      const w = await generateRemoteDraft(writingRef.current);
      setWriting(w);
    } finally {
      setBusy(false);
    }
  }, []);

  const runAgent4 = useCallback(async () => {
    setBusy(true);
    try {
      const w = await runAgent4Style(writingRef.current);
      setWriting(w);
    } finally {
      setBusy(false);
    }
  }, []);

  const runAgent5 = useCallback(async () => {
    setBusy(true);
    try {
      const w = await runAgent5Quality(writingRef.current);
      setWriting(w);
    } finally {
      setBusy(false);
    }
  }, []);

  const runAgent6 = useCallback(async () => {
    setBusy(true);
    try {
      const w = await runAgent6ChapterSave(writingRef.current);
      setWriting(w);
    } finally {
      setBusy(false);
    }
  }, []);

  const saveStyle = useCallback(() => {
    const result = saveStyleMemory(styleMemoryDraft);
    if (!result.saved) return;
    setStyleMemoryDraft(loadStyleMemory());
  }, [styleMemoryDraft]);

  const peekRewrite = useCallback(async (paragraphId) => {
    setBusy(true);
    try {
      const w = await requestPeekRewrite(writingRef.current, paragraphId);
      setWriting(w);
    } finally {
      setBusy(false);
    }
  }, []);

  const bulkRewrite = useCallback(async () => {
    setBusy(true);
    try {
      const w = await bulkRewriteUnresolved(writingRef.current);
      setWriting(w);
    } finally {
      setBusy(false);
    }
  }, []);

  return {
    outline,
    writing,
    busy,
    outlineText,
    styleMemoryDraft,
    setStyleMemoryDraft,
    startInput,
    runOutline,
    resolveIssues,
    confirm,
    applyReq,
    genDraft,
    runAgent4,
    runAgent5,
    markReadyToSave: () => setWriting((s) => markReadyToSave(s)),
    runAgent6,
    finalizeChapter: () => setWriting((s) => finalizeChapter(s)),
    applyStyleAction: (id, action, patch) =>
      setWriting((s) => applyStyleAction(s, id, action, patch)),
    applyQualityChoice: (pid, choice) =>
      setWriting((s) => applyQualityChoice(s, pid, choice)),
    peekRewrite,
    resolvePeek: (action) => setWriting((s) => resolvePeek(s, action)),
    bulkRewrite,
    bulkKeepAll: () => setWriting((s) => bulkKeepAllQuality(s)),
    saveStyle,
  };
}
