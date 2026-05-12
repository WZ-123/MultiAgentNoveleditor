import React, { useCallback, useEffect, useRef, useState } from 'react';
import { FileText, Upload, AlertTriangle, Check, X, FolderOpen, Loader2, Sparkles, User, Globe, Book, Pen, Shield, Clock } from 'lucide-react';
import { ConflictReportPanel } from './ConflictReportPanel.jsx';

export function ImportNovelPanel({ isOpen, onClose, existingNovels, activeNovelId, onImportComplete, onEnterMergeMode }) {
  const mana = typeof window !== 'undefined' ? window.mana : null;

  const [step, setStep] = useState('select'); // select | parse | target | fanwork-check | pick-dir | confirm | done | analysis | analysis-done | character-review | duplicate
  const [filePaths, setFilePaths] = useState([]);
  const [parsed, setParsed] = useState(null);
  const [targetMode, setTargetMode] = useState('new');
  const [targetNovelId, setTargetNovelId] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [importResult, setImportResult] = useState(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [analysisTasks, setAnalysisTasks] = useState([]); // [{ id, label, status }, ...]
  const [analysisResult, setAnalysisResult] = useState(null);
  const [chunkProgress, setChunkProgress] = useState({ current: 0, total: 1, chunkMode: false });
  const [conflicts, setConflicts] = useState([]);
  const [conflictSummary, setConflictSummary] = useState(null);
  const [projectName, setProjectName] = useState('');
  const [projectParentDir, setProjectParentDir] = useState('');
  const [duplicateInfo, setDuplicateInfo] = useState(null); // { isDuplicate, existingImportId, existingTitle, existingImportedAt }
  // Fanwork detection & character review
  const [fanworkMeta, setFanworkMeta] = useState({ hasFanwork: null, referencedWorks: ['', '', ''] });
  const [characterMarks, setCharacterMarks] = useState([]);
  const [enrichProgress, setEnrichProgress] = useState(null);
  const [enriching, setEnriching] = useState(false);
  const [aiFanworkSuggestion, setAiFanworkSuggestion] = useState(null); // { isFanwork, referencedWorks }
  const unsubscribeRef = useRef(null);
  const runIdSetRef = useRef(null);
  const chaptersRef = useRef([]); // persist chapter data across re-renders

  const reset = useCallback(() => {
    setStep('select');
    setFilePaths([]);
    setParsed(null);
    setTargetMode('new');
    setTargetNovelId('');
    setLoading(false);
    setError('');
    setImportResult(null);
    setAnalyzing(false);
    setAnalysisTasks([]);
    setAnalysisResult(null);
    setChunkProgress({ current: 0, total: 1, chunkMode: false });
    setConflicts([]);
    setConflictSummary(null);
    setProjectName('');
    setProjectParentDir('');
    setDuplicateInfo(null);
    setFanworkMeta({ hasFanwork: null, referencedWorks: ['', '', ''] });
    setCharacterMarks([]);
    setEnrichProgress(null);
    setEnriching(false);
    setAiFanworkSuggestion(null);
    if (unsubscribeRef.current) { unsubscribeRef.current(); unsubscribeRef.current = null; }
    runIdSetRef.current = null;
    chaptersRef.current = [];
  }, []);

  useEffect(() => {
    if (isOpen) reset();
  }, [isOpen, reset]);

  async function handlePickFiles() {
    if (!mana?.import?.pickFiles) return;
    try {
      const result = await mana.import.pickFiles();
      if (!result.canceled && result.filePaths?.length > 0) {
        setFilePaths(result.filePaths);
        setError('');
      }
    } catch (err) {
      setError(err?.message || String(err));
    }
  }

  async function handleParse() {
    if (!mana?.import?.parseFiles || filePaths.length === 0) return;
    setLoading(true);
    setError('');
    try {
      const result = await mana.import.parseFiles(filePaths);
      chaptersRef.current = result.chapters || [];
      setParsed(result);

      // Check for duplicate import
      if (mana?.import?.checkDuplicate) {
        const dup = await mana.import.checkDuplicate(filePaths);
        if (dup?.isDuplicate) {
          setDuplicateInfo(dup);
          setStep('duplicate');
          setLoading(false);
          return;
        }
      }

      setStep('target');
    } catch (err) {
      setError(err?.message || String(err));
    }
    setLoading(false);
  }

  async function handleCreateStaging() {
    if (!mana?.import?.createStaging) return;
    setLoading(true);
    setError('');
    try {
      const result = await mana.import.createStaging({
        sourceFiles: filePaths,
        chapters: parsed.chapters,
        metadata: { ...parsed.metadata, fanwork: fanworkMeta },
        targetNovelId: targetMode === 'existing' ? targetNovelId : null,
      });
      setImportResult(result);
      if (onImportComplete) onImportComplete({ ...result, chapters: chaptersRef.current });
      setStep('analysis');
      setLoading(false);
      handleStartAnalysis(result.importId);
    } catch (err) {
      setError(err?.message || String(err));
      setLoading(false);
    }
  }

  const getComputedProjectDir = () => {
    const name = projectName.trim() || 'untitled';
    return projectParentDir ? `${projectParentDir}/${name}` : '';
  };

  async function handlePickProjectParentDir() {
    if (!mana?.fs?.pickDirectory) { setError('文件系统 API 不可用'); return; }
    try {
      const dir = await mana.fs.pickDirectory({ title: '选择父目录（将在其中创建项目文件夹）' });
      if (dir) {
        setProjectParentDir(dir);
      }
    } catch (err) {
      setError(err?.message || String(err));
    }
  }

  async function handlePromoteToNovel(importId) {
    if (!mana?.import?.promoteToNovel || !mana?.novel?.open || !importId) return null;
    const computedDir = getComputedProjectDir();
    if (!computedDir) { setError('请先选择保存目录'); return null; }
    try {
      const title = projectName.trim() || parsed?.metadata?.title || filePaths[0]?.split('/').pop()?.replace(/\.[^.]+$/, '') || '导入的小说';
      const result = await mana.import.promoteToNovel(importId, title, computedDir);
      if (result?.id) {
        await mana.novel.open(result.id);
        if (mana.config?.setApp) {
          await mana.config.setApp({ lastNovelId: result.id });
        }
      }
      return result;
    } catch (err) {
      setError(err?.message || String(err));
      return null;
    }
  }

  async function handleStartAnalysis(importId) {
    if (!mana?.import?.analyze || !importId) return;
    setAnalyzing(true);
    setError('');

    const taskDefs = [
      { id: 'characters', label: '提取角色信息' },
      { id: 'factions', label: '提取势力派系' },
      { id: 'timeline', label: '提取时间线事件' },
      { id: 'world', label: '提取世界观设定' },
      { id: 'outline', label: '提取剧情大纲' },
      { id: 'style', label: '分析文风特征' },
    ];
    setAnalysisTasks(taskDefs.map((t) => ({ ...t, status: 'pending' })));
    setChunkProgress({ current: 0, total: 1, chunkMode: false });

    try {
      // Step 1: start all subagents, get runIds
      const analysisResult = await mana.import.analyze(importId);
      const { runIds, taskIds, chunkMode, chunkCount } = analysisResult;
      if (chunkMode && chunkCount > 1) {
        setChunkProgress({ current: 0, total: chunkCount, chunkMode: true });
      }

      if (!runIds || runIds.length === 0) {
        setAnalysisTasks(taskDefs.map((t) => ({ ...t, status: 'done' })));
        setAnalyzing(false);
        setStep('analysis-done');
        return;
      }

      const runIdSet = new Set(runIds);
      runIdSetRef.current = runIdSet;

      // Track per-task runId mapping (for single-chunk mode; chunk mode has multiple runIds per task)
      const taskRunIds = {};
      for (let i = 0; i < taskIds.length; i++) {
        taskRunIds[runIds[i]] = taskIds[i];
      }

      // Track which tasks are done (deduped by taskId across chunks)
      const completedTasks = new Set();
      // Track latest chunk progress per task
      const taskChunkProgress = {};

      // Step 2: subscribe to agent:event for real-time progress
      if (mana?.runtime?.on) {
        if (unsubscribeRef.current) unsubscribeRef.current();
        const unsub = mana.runtime.on('agent:event', (payload) => {
          if (!runIdSet.has(payload.runId)) return;
          const taskId = taskRunIds[payload.runId];
          if (!taskId) return;

          const ci = payload.data?.chunkIndex ?? 0;
          const cc = payload.data?.chunkCount ?? 1;
          taskChunkProgress[taskId] = { ci, cc };

          // Update overall chunk progress
          const maxChunk = Math.max(...Object.values(taskChunkProgress).map((p) => p.ci), 0);
          setChunkProgress((prev) => ({
            ...prev,
            current: maxChunk + 1,
            total: cc,
            chunkMode: cc > 1,
          }));

          if (payload.kind === 'running' || payload.kind === 'queued') {
            setAnalysisTasks((prev) =>
              prev.map((t) => t.id === taskId ? { ...t, status: 'running' } : t)
            );
          } else if (payload.kind === 'done' || payload.kind === 'output') {
            completedTasks.add(taskId);
            setAnalysisTasks((prev) =>
              prev.map((t) => t.id === taskId ? { ...t, status: 'done', label: `${t.label}` } : t)
            );
          } else if (payload.kind === 'error') {
            completedTasks.add(taskId);
            setAnalysisTasks((prev) =>
              prev.map((t) => t.id === taskId ? { ...t, status: 'error', label: `${t.label}` } : t)
            );
          }
        });
        unsubscribeRef.current = unsub;
      }

      // Step 3: wait for finalize (blocks until all subagents finish writing results)
      const result = await mana.import.finalizeAnalysis(importId);
      setAnalysisResult(result);

      // Mark any stragglers as done
      setAnalysisTasks((prev) =>
        prev.map((t) => completedTasks.has(t.id) ? t : { ...t, status: 'done' })
      );

      // Cleanup event subscription
      if (unsubscribeRef.current) {
        unsubscribeRef.current();
        unsubscribeRef.current = null;
      }

      // After analysis: if fanwork, go to character-review; else auto-promote as before
      if (fanworkMeta.hasFanwork === true) {
        // Load AI-suggested fanwork info from world/meta.json as defaults
        try {
          const staging = await mana.import.getStaging(importId);
          if (staging?.novelMeta?.fanwork) {
            const saved = staging.novelMeta.fanwork;
            if (saved.hasFanwork !== null) {
              setFanworkMeta(saved);
            }
          }
          // Also read world meta for AI suggestions
          const worldMeta = await mana.fs.readJson(`${staging?.dir}/world/meta.json`, null);
          if (worldMeta?.isFanwork != null) {
            setAiFanworkSuggestion({
              isFanwork: worldMeta.isFanwork,
              referencedWorks: worldMeta.referencedWorks || [],
            });
          }
        } catch { /* ignore */ }
        // Load characters for review
        await loadCharactersForReview(importId);
        setStep('character-review');
      } else {
        // Original novel or user chose to skip: auto-promote as before
        if (targetMode === 'new' && projectParentDir && projectName.trim()) {
          const promoted = await handlePromoteToNovel(importId);
          if (promoted) {
            setImportResult((prev) => ({ ...prev, promotedId: promoted.id }));
            if (onImportComplete) {
              onImportComplete({
                ...promoted,
                chapters: chaptersRef.current,
              });
            }
            setStep('done');
          } else {
            setStep('analysis-done');
          }
        } else {
          setStep('analysis-done');
        }
      }
    } catch (err) {
      setError(err?.message || String(err));
    }
    setAnalyzing(false);
  }

  function handleConfirmImport() {
    if (targetMode === 'existing' && !targetNovelId) {
      setError('请选择一个现有项目');
      return;
    }
    setStep('fanwork-check');
  }

  function handleFanworkCheckNext() {
    if (targetMode === 'existing') {
      setStep('confirm');
    } else {
      setStep('pick-dir');
    }
  }

  async function loadCharactersForReview(importId) {
    if (!mana?.import?.getStagingCharacters) return;
    try {
      const chars = await mana.import.getStagingCharacters(importId);
      // Initialize character marks with defaults
      const marks = (chars || []).map((ch) => ({
        id: ch.id || ch.name || String(Math.random()),
        name: ch.name || ch.id || '?',
        isOriginal: true,
        selected: true,
        sourceWork: '',
        data: ch,
      }));
      setCharacterMarks(marks);
    } catch (err) {
      console.error('[import] loadCharactersForReview failed:', err);
      setCharacterMarks([]);
    }
  }

  async function handleStartEnrichment() {
    if (!importResult?.importId || !mana?.import?.enrichStagingCharacters) return;
    const workAssignments = {};
    for (const m of characterMarks) {
      if (!m.selected || m.isOriginal) continue;
      const work = m.sourceWork || fanworkMeta.referencedWorks[0] || '';
      if (!work) continue;
      if (!workAssignments[work]) workAssignments[work] = [];
      workAssignments[work].push(m.id);
    }
    if (Object.keys(workAssignments).length === 0) {
      setError('请至少选择一个二创角色并指定所属作品');
      return;
    }
    setEnriching(true);
    setError('');
    try {
      const result = await mana.import.enrichStagingCharacters(importResult.importId, workAssignments);
      setEnrichProgress({ runId: result.runId, status: 'done', results: result.results });
      // Reload characters after enrichment
      await loadCharactersForReview(importResult.importId);
    } catch (err) {
      setError(`联网补全失败: ${err.message || String(err)}`);
    }
    setEnriching(false);
  }

  function handleSkipEnrichment() {
    handleCharacterReviewDone();
  }

  async function handleCharacterReviewDone() {
    if (!importResult?.importId) return;
    // Save any manual character markings back to staging
    const toSave = characterMarks.map((m) => ({
      ...m.data,
      isOriginal: m.isOriginal,
      sourceWork: m.isOriginal ? '' : (m.sourceWork || ''),
    }));
    try {
      await mana.import.saveStagingCharacters(importResult.importId, toSave);
    } catch (err) {
      console.error('[import] saveStagingCharacters failed:', err);
    }
    // Promote and finish
    if (targetMode === 'new' && projectParentDir && projectName.trim()) {
      const promoted = await handlePromoteToNovel(importResult.importId);
      if (promoted) {
        setImportResult((prev) => ({ ...prev, promotedId: promoted.id }));
        if (onImportComplete) {
          onImportComplete({ ...promoted, chapters: chaptersRef.current });
        }
        setStep('done');
        return;
      }
    }
    setStep('analysis-done');
  }

  async function handleReuseExisting() {
    if (!duplicateInfo?.existingImportId || !mana?.import?.getStaging) return;
    setLoading(true);
    setError('');
    try {
      const existing = await mana.import.getStaging(duplicateInfo.existingImportId);
      if (existing) {
        setImportResult({ importId: duplicateInfo.existingImportId, chapterCount: existing.chapters?.length || 0, title: existing.novelMeta?.title });
        chaptersRef.current = existing.chapters || [];
        // Check if already analyzed
        const check = await mana.import.checkAnalysis(duplicateInfo.existingImportId);
        if (check?.analyzed) {
          setAnalysisResult({
            characters: check.characterCount || 0,
            hasLore: check.hasLore,
            hasOutline: check.hasOutline,
            hasStyle: check.hasStyle,
          });
          setStep('analysis-done');
        } else {
          setStep('analysis');
          setLoading(false);
          handleStartAnalysis(duplicateInfo.existingImportId);
          return;
        }
      }
    } catch (err) {
      setError(err?.message || String(err));
    }
    setLoading(false);
  }

  async function handleRecreateImport() {
    if (!duplicateInfo?.existingImportId || !mana?.import?.discardStaging) return;
    setLoading(true);
    setError('');
    try {
      await mana.import.discardStaging(duplicateInfo.existingImportId);
      setDuplicateInfo(null);
      setStep('target');
    } catch (err) {
      setError(err?.message || String(err));
    }
    setLoading(false);
  }

  async function handleSkipAnalysis() {
    setStep('done');
  }

  async function handleDetectConflicts() {
    if (!mana?.import?.detectConflicts || !importResult?.importId || !targetNovelId) return;
    setLoading(true);
    setError('');
    try {
      const result = await mana.import.detectConflicts(importResult.importId, targetNovelId);
      setConflicts(result.conflicts || []);
      setConflictSummary(result.summary || { critical: 0, normal: 0, minor: 0, total: 0 });
      setStep('conflict-report');
    } catch (err) {
      setError(err?.message || String(err));
    }
    setLoading(false);
  }

  async function handleDiscardImport() {
    if (!mana?.import?.discardStaging || !importResult?.importId) return;
    try {
      await mana.import.discardStaging(importResult.importId);
    } catch { /* ignore */ }
    onClose();
  }

  function handleNewProject() {
    // Promote staging to new novel (skip merge)
    setStep('done');
  }

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="bg-vscode-panel-bg border border-vscode-panel-border rounded-lg shadow-xl w-[640px] max-w-[90vw] max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-vscode-panel-border">
          <div className="flex items-center gap-2 text-gray-200">
            <Upload size={16} />
            <span className="font-semibold text-sm">导入外部小说</span>
          </div>
          <button type="button" className="text-gray-400 hover:text-white" onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-4 text-xs">
          {error && (
            <div className="mb-3 p-2 bg-rose-500/10 border border-rose-500/30 rounded text-rose-300 flex items-center gap-1.5">
              <AlertTriangle size={12} />
              <span>{error}</span>
            </div>
          )}

          {step === 'select' && (
            <div className="space-y-3">
              <p className="text-gray-500">选择要导入的小说文件。支持 Markdown (.md)、纯文本 (.txt) 和 EPUB (.epub) 格式，可多选。</p>
              <button
                type="button"
                onClick={handlePickFiles}
                className="w-full py-6 border-2 border-dashed border-vscode-panel-border rounded hover:border-blue-500/50 hover:bg-vscode-sidebar transition-colors flex flex-col items-center gap-2 text-gray-400"
              >
                <FolderOpen size={24} />
                <span>点击选择文件</span>
              </button>
              {filePaths.length > 0 && (
                <div className="space-y-1">
                  <div className="text-gray-400 font-medium">已选择 {filePaths.length} 个文件:</div>
                  {filePaths.map((fp, i) => (
                    <div key={i} className="flex items-center gap-1.5 text-gray-500">
                      <FileText size={12} />
                      <span className="truncate">{fp.split('/').pop()}</span>
                    </div>
                  ))}
                </div>
              )}
              <div className="flex justify-end">
                <button
                  type="button"
                  disabled={filePaths.length === 0 || loading}
                  onClick={handleParse}
                  className="px-3 py-1.5 bg-blue-700 text-white rounded hover:bg-blue-600 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1"
                >
                  {loading ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
                  解析文件
                </button>
              </div>
            </div>
          )}

          {step === 'target' && parsed && (
            <div className="space-y-3">
              <div className="text-gray-400">
                解析完成：共 <span className="text-white font-bold">{parsed.chapters.length}</span> 章
                {parsed.metadata?.title && (
                  <span>，标题：{parsed.metadata.title}</span>
                )}
                {parsed.metadata?.author && (
                  <span>，作者：{parsed.metadata.author}</span>
                )}
              </div>
              <div className="border border-vscode-panel-border rounded p-2 max-h-32 overflow-y-auto">
                {parsed.chapters.slice(0, 10).map((ch, i) => (
                  <div key={i} className="text-gray-500 truncate py-0.5">
                    {i + 1}. {ch.title}
                  </div>
                ))}
                {parsed.chapters.length > 10 && (
                  <div className="text-gray-600">... 还有 {parsed.chapters.length - 10} 章</div>
                )}
              </div>
              <div className="space-y-2">
                <div className="text-gray-400 font-medium">导入目标:</div>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="targetMode"
                    value="new"
                    checked={targetMode === 'new'}
                    onChange={() => { setTargetMode('new'); setTargetNovelId(''); setProjectParentDir(''); setError(''); }}
                  />
                  <span className="text-gray-300">创建为新项目</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="targetMode"
                    value="existing"
                    checked={targetMode === 'existing'}
                    onChange={() => { setTargetMode('existing'); setError(''); }}
                  />
                  <span className="text-gray-300">导入到现有项目</span>
                </label>
                {targetMode === 'existing' && (
                  <select
                    className="w-full bg-vscode-sidebar border border-vscode-panel-border rounded px-2 py-1.5 text-gray-200"
                    value={targetNovelId}
                    onChange={(e) => setTargetNovelId(e.target.value)}
                  >
                    <option value="">-- 选择项目 --</option>
                    {existingNovels?.map((n) => (
                      <option key={n.id} value={n.id}>{n.title}</option>
                    ))}
                  </select>
                )}
              </div>
              <div className="flex justify-end gap-2">
                <button type="button" onClick={() => setStep('select')} className="px-3 py-1.5 text-gray-400 hover:text-gray-200">上一步</button>
                <button type="button" onClick={handleConfirmImport} className="px-3 py-1.5 bg-blue-700 text-white rounded hover:bg-blue-600">下一步</button>
              </div>
            </div>
          )}

          {step === 'fanwork-check' && (
            <div className="space-y-3">
              <div className="text-gray-400">
                这部小说是否包含二创/同人元素？角色是否来自已有的文艺作品？
              </div>
              <div className="space-y-2">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="hasFanwork"
                    checked={fanworkMeta.hasFanwork === true}
                    onChange={() => setFanworkMeta((prev) => ({ ...prev, hasFanwork: true }))}
                  />
                  <span className="text-gray-300">是，角色来自已有文艺作品（如动漫、游戏、影视、小说）</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="hasFanwork"
                    checked={fanworkMeta.hasFanwork === false}
                    onChange={() => setFanworkMeta((prev) => ({ ...prev, hasFanwork: false, referencedWorks: ['', '', ''] }))}
                  />
                  <span className="text-gray-300">否，原创作品，所有角色均为原创</span>
                </label>
              </div>

              {fanworkMeta.hasFanwork === true && (
                <div className="space-y-2 border border-vscode-panel-border rounded p-3">
                  <div className="text-gray-400 font-medium">引用作品列表（每行一个，支持多部作品）：</div>
                  {aiFanworkSuggestion?.referencedWorks?.length > 0 && (
                    <div className="text-blue-400 text-[11px]">
                      AI 检测到可能引用：{aiFanworkSuggestion.referencedWorks.join('、')}（可在下方修改）
                    </div>
                  )}
                  {fanworkMeta.referencedWorks.map((work, i) => (
                    <input
                      key={i}
                      type="text"
                      value={work}
                      onChange={(e) => {
                        const next = [...fanworkMeta.referencedWorks];
                        next[i] = e.target.value;
                        setFanworkMeta((prev) => ({ ...prev, referencedWorks: next }));
                      }}
                      placeholder={`作品 ${i + 1}（如：碧蓝航线、原神）`}
                      className="w-full bg-vscode-sidebar border border-vscode-panel-border rounded px-2 py-1.5 text-sm text-gray-200 outline-none focus:border-blue-500"
                    />
                  ))}
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => setFanworkMeta((prev) => ({ ...prev, referencedWorks: [...prev.referencedWorks, ''] }))}
                      className="text-blue-400 hover:text-blue-300 text-[11px]"
                    >
                      + 添加作品
                    </button>
                    {fanworkMeta.referencedWorks.length > 1 && (
                      <button
                        type="button"
                        onClick={() => setFanworkMeta((prev) => ({ ...prev, referencedWorks: prev.referencedWorks.slice(0, -1) }))}
                        className="text-gray-500 hover:text-gray-300 text-[11px]"
                      >
                        - 移除最后一个
                      </button>
                    )}
                  </div>
                  <div className="text-gray-600 text-[10px]">
                    填写原作名称后，系统会在联网补全阶段根据作品名搜索角色信息。若同时引用多部作品，后续步骤需要为每个角色选择所属作品。
                  </div>
                </div>
              )}

              <div className="flex justify-end gap-2">
                <button type="button" onClick={() => setStep('target')} className="px-3 py-1.5 text-gray-400 hover:text-gray-200">上一步</button>
                <button
                  type="button"
                  onClick={handleFanworkCheckNext}
                  disabled={fanworkMeta.hasFanwork === null}
                  className="px-3 py-1.5 bg-blue-700 text-white rounded hover:bg-blue-600 disabled:opacity-40"
                >
                  下一步
                </button>
              </div>
            </div>
          )}

          {step === 'duplicate' && duplicateInfo && (
            <div className="space-y-3">
              <div className="flex items-start gap-2 text-amber-400 bg-amber-500/10 border border-amber-500/30 rounded p-3">
                <AlertTriangle size={16} className="shrink-0 mt-0.5" />
                <div>
                  <div className="font-semibold">检测到重复导入</div>
                  <div className="text-amber-300/80 mt-1">
                    此文件已于 <span className="text-white">{new Date(duplicateInfo.existingImportedAt).toLocaleString()}</span> 导入过。
                    项目名：<span className="text-white">{duplicateInfo.existingTitle || '导入的小说'}</span>
                  </div>
                  <div className="text-amber-300/60 mt-1 text-[11px]">
                    你可以选择复用已有的分析结果，或重新导入（旧项目将被标记为废弃）。
                  </div>
                </div>
              </div>
              <div className="flex justify-end gap-2">
                <button type="button" onClick={() => setStep('select')} className="px-3 py-1.5 text-gray-400 hover:text-gray-200">取消</button>
                <button
                  type="button"
                  onClick={handleRecreateImport}
                  disabled={loading}
                  className="px-3 py-1.5 text-gray-300 hover:text-white border border-vscode-panel-border rounded hover:bg-vscode-sidebar"
                >
                  {loading ? <Loader2 size={12} className="animate-spin" /> : <Upload size={12} />}
                  重新导入
                </button>
                <button
                  type="button"
                  onClick={handleReuseExisting}
                  disabled={loading}
                  className="px-3 py-1.5 bg-blue-700 text-white rounded hover:bg-blue-600 disabled:opacity-40 flex items-center gap-1"
                >
                  {loading ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
                  复用已有结果
                </button>
              </div>
            </div>
          )}

          {step === 'pick-dir' && (
            <div className="space-y-3">
              <div className="text-gray-400">项目名称与保存位置：</div>
              <div>
                <label className="text-gray-500 text-[11px]">项目名称</label>
                <input
                  type="text"
                  value={projectName}
                  onChange={(e) => setProjectName(e.target.value.replace(/[/\\?%*:|"<>]/g, ''))}
                  placeholder="输入项目名称"
                  className="w-full bg-vscode-sidebar border border-vscode-panel-border rounded px-2 py-1.5 text-sm text-gray-200 outline-none focus:border-blue-500 mt-0.5"
                />
              </div>
              <div>
                <label className="text-gray-500 text-[11px]">父目录（将在其中创建项目文件夹）</label>
                <button
                  type="button"
                  onClick={handlePickProjectParentDir}
                  className="w-full mt-0.5 py-3 border-2 border-dashed border-vscode-panel-border rounded hover:border-blue-500/50 hover:bg-vscode-sidebar transition-colors flex flex-col items-center gap-1.5 text-gray-400"
                >
                  <FolderOpen size={18} />
                  <span className="text-xs">{projectParentDir ? '切换父目录' : '选择父目录'}</span>
                </button>
              </div>
              {projectParentDir && projectName.trim() && (
                <div className="text-green-400 text-xs flex items-center gap-1">
                  <Check size={12} /> 项目将创建在:
                  <span className="text-gray-400 ml-1 break-all">{getComputedProjectDir()}/</span>
                </div>
              )}
              <div className="flex justify-end gap-2">
                <button type="button" onClick={() => setStep('target')} className="px-3 py-1.5 text-gray-400 hover:text-gray-200">上一步</button>
                <button
                  type="button"
                  onClick={handleCreateStaging}
                  disabled={!projectParentDir || !projectName.trim() || loading}
                  className="px-3 py-1.5 bg-blue-700 text-white rounded hover:bg-blue-600 disabled:opacity-40 flex items-center gap-1"
                >
                  {loading ? <Loader2 size={12} className="animate-spin" /> : <Upload size={12} />}
                  开始导入并分析
                </button>
              </div>
            </div>
          )}

          {step === 'confirm' && (
            <div className="space-y-3">
              <div className="flex items-start gap-2 text-amber-400 bg-amber-500/10 border border-amber-500/30 rounded p-3">
                <AlertTriangle size={16} className="shrink-0 mt-0.5" />
                <div>
                  <div className="font-semibold">警告：可能出现冲突</div>
                  <div className="text-amber-300/80 mt-1">
                    将外部小说导入到现有项目时，可能会出现人设、世界观、大纲等方面的冲突。导入后系统会自动检测冲突并进入合并模式。
                  </div>
                </div>
              </div>
              <div className="flex justify-end gap-2">
                <button type="button" onClick={() => setStep('target')} className="px-3 py-1.5 text-gray-400 hover:text-gray-200">取消</button>
                <button
                  type="button"
                  onClick={handleCreateStaging}
                  disabled={loading}
                  className="px-3 py-1.5 bg-amber-700 text-white rounded hover:bg-amber-600 disabled:opacity-40 flex items-center gap-1"
                >
                  {loading ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
                  确认导入并自动分析
                </button>
              </div>
            </div>
          )}

          {step === 'analysis' && (
            <div className="space-y-4">
              <div className="text-gray-200 font-semibold flex items-center gap-2">
                <Sparkles size={16} />
                AI 分析中...
              </div>
              {chunkProgress.chunkMode && (
                <div className="text-blue-400 text-xs font-medium">
                  文本较长，正在分片分析：第 {chunkProgress.current}/{chunkProgress.total} 片
                </div>
              )}
              <div className="text-gray-500">
                正在并行分析导入的小说内容，分别提取角色、势力、时间线、世界观、大纲和文风信息。
              </div>
              <div className="bg-vscode-sidebar rounded p-3 space-y-1 border border-vscode-panel-border">
                {analysisTasks.map((t) => {
                  const colors = {
                    pending: 'text-gray-500',
                    running: 'text-blue-400',
                    done: 'text-green-400',
                    error: 'text-rose-400',
                  };
                  const icons = { characters: User, factions: Shield, timeline: Clock, world: Globe, outline: Book, style: Pen };
                  const Icon = icons[t.id] || Sparkles;
                  return (
                    <div key={t.id} className={`flex items-center gap-2 py-1 ${colors[t.status] || 'text-gray-500'}`}>
                      {t.status === 'running' ? (
                        <Loader2 size={14} className="animate-spin" />
                      ) : t.status === 'done' ? (
                        <Check size={14} />
                      ) : (
                        <Icon size={14} />
                      )}
                      <span className="text-xs">{t.label}</span>
                    </div>
                  );
                })}
              </div>
              <div className="flex justify-between">
                <button type="button" onClick={handleSkipAnalysis} className="px-3 py-1.5 text-gray-500 hover:text-gray-300">跳过分析</button>
              </div>
            </div>
          )}

          {step === 'character-review' && importResult && (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-gray-200 font-semibold">
                <User size={16} />
                <span>角色归属标记（共 {characterMarks.length} 个角色）</span>
              </div>
              <div className="text-gray-500 text-[11px]">
                请为每个角色标记是否为二创角色。若为二创，系统将根据所选作品进行联网补全。
                {fanworkMeta.referencedWorks.filter(Boolean).length > 1 && ' 因涉及多部作品，每个二创角色需选择具体所属作品。'}
              </div>

              {/* Batch actions */}
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setCharacterMarks((prev) => prev.map((m) => ({ ...m, isOriginal: true, sourceWork: '' })))}
                  className="px-2 py-0.5 bg-vscode-sidebar border border-vscode-panel-border rounded text-[11px] text-gray-400 hover:text-gray-200"
                >
                  全部设为原创
                </button>
                <button
                  type="button"
                  onClick={() => setCharacterMarks((prev) => prev.map((m) => ({ ...m, isOriginal: false, sourceWork: m.sourceWork || fanworkMeta.referencedWorks.filter(Boolean)[0] || '' })))}
                  className="px-2 py-0.5 bg-vscode-sidebar border border-vscode-panel-border rounded text-[11px] text-gray-400 hover:text-gray-200"
                >
                  全部设为二创
                </button>
              </div>

              {/* Character list */}
              <div className="border border-vscode-panel-border rounded divide-y divide-vscode-panel-border/50 max-h-64 overflow-y-auto">
                {characterMarks.map((m) => (
                  <div key={m.id} className="flex items-center gap-2 px-3 py-2 text-xs">
                    <input
                      type="checkbox"
                      checked={m.selected}
                      onChange={() => setCharacterMarks((prev) => prev.map((x) => x.id === m.id ? { ...x, selected: !x.selected } : x))}
                      className="accent-blue-500"
                    />
                    <span className="flex-1 truncate text-gray-300 font-medium">{m.name}</span>
                    <div className="flex items-center gap-2 shrink-0">
                      <label className="flex items-center gap-1 cursor-pointer">
                        <input
                          type="radio"
                          name={`type-${m.id}`}
                          checked={m.isOriginal}
                          onChange={() => setCharacterMarks((prev) => prev.map((x) => x.id === m.id ? { ...x, isOriginal: true, sourceWork: '' } : x))}
                        />
                        <span className="text-gray-400">原创</span>
                      </label>
                      <label className="flex items-center gap-1 cursor-pointer">
                        <input
                          type="radio"
                          name={`type-${m.id}`}
                          checked={!m.isOriginal}
                          onChange={() => setCharacterMarks((prev) => prev.map((x) => x.id === m.id ? { ...x, isOriginal: false, sourceWork: x.sourceWork || fanworkMeta.referencedWorks.filter(Boolean)[0] || '' } : x))}
                        />
                        <span className="text-gray-400">二创</span>
                      </label>
                    </div>
                    {!m.isOriginal && (
                      <select
                        value={m.sourceWork}
                        onChange={(e) => setCharacterMarks((prev) => prev.map((x) => x.id === m.id ? { ...x, sourceWork: e.target.value } : x))}
                        className="bg-vscode-sidebar border border-vscode-panel-border rounded px-1 py-0.5 text-gray-300 text-[11px] outline-none shrink-0"
                        disabled={m.isOriginal}
                      >
                        <option value="">-- 选择作品 --</option>
                        {fanworkMeta.referencedWorks.filter(Boolean).map((w, i) => (
                          <option key={i} value={w}>{w}</option>
                        ))}
                      </select>
                    )}
                  </div>
                ))}
              </div>

              {enrichProgress?.status === 'done' && (
                <div className="bg-green-900/20 border border-green-700/40 rounded p-2 text-center">
                  <div className="text-green-400 text-xs font-semibold">
                    联网补全完成
                    {enrichProgress.results?.map((r) => ` | ${r.workName}: ${r.count} 个角色`).join('')}
                  </div>
                </div>
              )}

              <div className="flex justify-between items-center">
                <button
                  type="button"
                  onClick={handleSkipEnrichment}
                  className="px-3 py-1.5 text-gray-500 hover:text-gray-300"
                >
                  跳过补全
                </button>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setStep('analysis')}
                    disabled={enriching}
                    className="px-3 py-1.5 text-gray-400 hover:text-gray-200 disabled:opacity-40"
                  >
                    上一步
                  </button>
                  {enrichProgress?.status === 'done' ? (
                    <button
                      type="button"
                      onClick={handleCharacterReviewDone}
                      className="px-3 py-1.5 bg-blue-700 text-white rounded hover:bg-blue-600"
                    >
                      完成导入
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={handleStartEnrichment}
                      disabled={enriching || characterMarks.filter((m) => !m.isOriginal && m.selected && m.sourceWork).length === 0}
                      className="px-3 py-1.5 bg-amber-700 text-white rounded hover:bg-amber-600 disabled:opacity-40 flex items-center gap-1"
                    >
                      {enriching ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
                      {enriching ? '补全中...' : '开始联网补全角色信息'}
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}

          {step === 'analysis-done' && importResult && (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-green-400">
                <Check size={16} />
                <span className="font-semibold">AI 分析完成</span>
              </div>
              {analysisResult?.chunkMode && (
                <div className="text-blue-400 text-xs">
                  分片分析完成：共 {analysisResult?.chunkCount} 片结果已合并
                </div>
              )}
              <div className="bg-vscode-sidebar rounded p-3 border border-vscode-panel-border space-y-1">
                <div className="text-green-400 flex items-center gap-2 text-xs">
                  <Check size={12} /> 角色: {analysisResult?.characters || 0} 个
                </div>
                <div className="text-green-400 flex items-center gap-2 text-xs">
                  <Check size={12} /> 势力: {analysisResult?.factions || 0} 个
                </div>
                <div className="text-green-400 flex items-center gap-2 text-xs">
                  <Check size={12} /> 时间线: {analysisResult?.timeline || 0} 条事件
                </div>
                <div className="text-green-400 flex items-center gap-2 text-xs">
                  <Check size={12} /> 世界观: {analysisResult?.lore > 100 ? '已分析' : '已分析'}
                </div>
                <div className="text-green-400 flex items-center gap-2 text-xs">
                  <Check size={12} /> 大纲: {analysisResult?.outline > 100 ? '已生成' : '未生成'}
                </div>
                <div className="text-green-400 flex items-center gap-2 text-xs">
                  <Check size={12} /> 文风: {analysisResult?.style > 100 ? '已分析' : '已分析'}
                </div>
              </div>
              {targetMode === 'existing' ? (
                <button
                  type="button"
                  onClick={handleDetectConflicts}
                  disabled={loading}
                  className="w-full px-3 py-1.5 bg-amber-700 text-white rounded hover:bg-amber-600 disabled:opacity-40"
                >
                  {loading ? '检测中...' : '继续 → 冲突检测与合并模式'}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => { setStep('done'); }}
                  className="w-full px-3 py-1.5 bg-blue-700 text-white rounded hover:bg-blue-600"
                >
                  查看导入结果
                </button>
              )}
            </div>
          )}

          {step === 'done' && importResult && (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-green-400">
                <Check size={16} />
                <span className="font-semibold">导入成功</span>
              </div>
              <div className="text-gray-400 space-y-1">
                <div>共 <span className="text-white">{importResult.chapterCount}</span> 章已成功导入。</div>
                {targetMode === 'new' && importResult.promotedId ? (
                  <div>
                    新项目「<span className="text-white">{parsed?.metadata?.title || '导入的小说'}</span>」已创建并打开，可以直接在编辑器中查看和编辑章节内容。
                  </div>
                ) : targetMode === 'existing' ? (
                  <div>
                    临时项目已创建，可以在下一步进行冲突检测与合并。
                  </div>
                ) : (
                  <div>
                    临时项目已创建，文案已更新，请关闭窗口后查看。
                  </div>
                )}
              </div>
              <div className="flex justify-end">
                <button type="button" onClick={() => { onClose(); }} className="px-3 py-1.5 bg-blue-700 text-white rounded hover:bg-blue-600">完成</button>
              </div>
            </div>
          )}

          {step === 'conflict-report' && conflictSummary && (
            <ConflictReportPanel
              conflicts={conflicts}
              summary={conflictSummary}
              onMerge={() => {
                onClose();
                if (onEnterMergeMode && importResult?.importId && targetNovelId) {
                  onEnterMergeMode(importResult.importId, targetNovelId);
                }
              }}
              onNewProject={handleNewProject}
              onDiscard={handleDiscardImport}
            />
          )}
        </div>
      </div>
    </div>
  );
}
