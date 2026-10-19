import React, { useCallback, useEffect, useRef, useState } from 'react';
import { X, RotateCcw, Save, AlertTriangle } from 'lucide-react';
import { MergeFileTree } from './MergeFileTree.jsx';
import { MergeDiffView } from './MergeDiffView.jsx';
import { MergeConflictItem } from './MergeConflictItem.jsx';

export function ImportMergePanel({ importId, novelId, onClose }) {
  const mana = typeof window !== 'undefined' ? window.mana : null;

  const [sessionId, setSessionId] = useState(null);
  const [items, setItems] = useState([]);
  const [summary, setSummary] = useState(null);
  const [activeItemId, setActiveItemId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [outcome, setOutcome] = useState(null);
  const cancelRequested = useRef(false);
  const [aiMerging, setAiMerging] = useState(false);

  // Create merge session on mount
  useEffect(() => {
    if (!mana?.import?.createMerge || !importId || !novelId) return;
    setLoading(true);
    mana.import.createMerge(importId, novelId)
      .then((result) => {
        setSessionId(result.sessionId);
        setItems(result.items || []);
        setSummary(result.summary || { total: 0, resolved: 0, disputed: 0, pending: 0 });
        if (result.items?.length > 0) setActiveItemId(result.items[0].id);
      })
      .catch((err) => setError(err?.message || String(err)))
      .finally(() => setLoading(false));
  }, [importId, novelId, mana]);

  const activeItem = items.find((i) => i.id === activeItemId) || null;

  const handleSelectItem = useCallback((itemId) => {
    setActiveItemId(itemId);
  }, []);

  const handleResolve = useCallback(async (itemId, decision, content) => {
    if (!mana?.import?.resolveConflict || !sessionId) return;
    try {
      const updated = await mana.import.resolveConflict(sessionId, itemId, decision, {
        resolvedContent: content,
        userNote: items.find((i) => i.id === itemId)?.userNote || '',
      });
      setItems((prev) => prev.map((i) => i.id === itemId ? { ...i, ...updated } : i));
      const s = await mana.import.getMergeSummary(sessionId);
      setSummary(s);
    } catch (err) {
      setError(err?.message || String(err));
    }
  }, [sessionId, mana, items]);

  const handleReset = useCallback(async (itemId) => {
    if (!mana?.import?.resetMerge || !sessionId) return;
    try {
      await mana.import.resetMerge(sessionId);
      setItems((prev) => prev.map((i) => ({ ...i, resolution: null, resolvedContent: null, userNote: '', status: 'pending' })));
      const s = await mana.import.getMergeSummary(sessionId);
      setSummary(s);
    } catch (err) {
      setError(err?.message || String(err));
    }
  }, [sessionId, mana]);

  const handleSaveExit = useCallback(async () => {
    if (!mana?.import?.finalizeMerge || !sessionId) return;
    setSaving(true);
    try {
      await mana.import.finalizeMerge(sessionId);
      if (cancelRequested.current) setOutcome(await mana.import.get(importId));
      else onClose();
    } catch (err) {
      if (cancelRequested.current) {
        const current = await mana.import.get(importId);
        if (['cancelled', 'completed'].includes(current.state)) { setOutcome(current); setSaving(false); return; }
      }
      setError(err?.message || String(err));
      const current = await mana.import.getMerge(sessionId);
      if (current) { setItems(current.items); setSummary(await mana.import.getMergeSummary(sessionId)); }
    }
    setSaving(false);
  }, [sessionId, mana, onClose, importId]);

  const handleCancel = useCallback(async () => {
    cancelRequested.current = true; setCancelling(true); setError('');
    try {
      const current = await mana.import.cancel(importId);
      if (['cancelled', 'completed'].includes(current.state)) setOutcome(current);
      else setError(current.error?.message || '提交需要恢复，请核对保存结果');
    } catch (err) { setError(err.message); }
    finally { setCancelling(false); }
  }, [mana, importId]);

  const handleAiMerge = useCallback(async (itemId, userNote) => {
    if (!mana?.import?.resolveConflict || !mana?.import?.aiMerge || !sessionId) return;
    setAiMerging(true);
    try {
      const item = items.find((i) => i.id === itemId);
      if (!item) return;

      const merged = await mana.import.aiMerge(item.leftContent, item.rightContent, item.type, userNote);

      const updated = await mana.import.resolveConflict(sessionId, itemId, 'ai_merged', {
        resolvedContent: merged || item.leftContent,
        userNote,
      });
      setItems((prev) => prev.map((i) => i.id === itemId ? { ...i, ...updated } : i));
      const s = await mana.import.getMergeSummary(sessionId);
      setSummary(s);
    } catch (err) {
      setError(err?.message || String(err));
    }
    setAiMerging(false);
  }, [sessionId, mana, items]);

  if (loading) {
    return (
      <div className="fixed inset-0 z-[100] bg-vscode-bg flex items-center justify-center">
        <div className="text-gray-400 text-sm">正在创建合并会话...</div>
      </div>
    );
  }


  if (outcome) return <div className="h-full flex flex-col items-center justify-center gap-4 p-8 text-sm text-gray-300" data-testid="merge-import-outcome" data-import-state={outcome.state}>
    <p>{outcome.state === 'cancelled' ? '导入已取消，目标项目未写入本次变更。' : '项目已保存；取消请求到达提交决定之后，已保留保存回执。'}</p>
    {outcome.result?.receipt && <details className="max-w-full"><summary>查看保存回执</summary><pre className="whitespace-pre-wrap break-all">{JSON.stringify(outcome.result.receipt, null, 2)}</pre></details>}
    <button onClick={onClose}>关闭合并结果</button>
  </div>;

  return (
    <div className="fixed inset-0 z-[100] bg-vscode-bg flex flex-col">
      {error && <div role="alert" className="absolute top-2 left-1/4 right-1/4 z-50 bg-red-950 border border-red-500 p-3 text-sm text-red-200">{error}<button className="ml-3 underline" onClick={() => setError('')}>继续审阅</button><button className="ml-3 underline" onClick={onClose}>关闭</button></div>}
      {/* Top bar */}
      <div className="h-10 border-b border-vscode-panel-border flex items-center px-3 shrink-0 bg-vscode-sidebar">
        <div className="flex items-center gap-2 text-sm text-gray-200 font-semibold flex-1">
          <span>合并模式</span>
          {summary && (
            <span className="text-xs font-normal text-gray-500">
              已解决 {summary.resolved}/{summary.total} · 争议 {summary.disputed}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button type="button" data-testid="merge-import-cancel" disabled={cancelling} onClick={handleCancel} className="text-amber-300 text-xs">
            {cancelling ? '正在核对取消与保存结果…' : '取消本次导入'}
          </button>
          <button
            type="button"
            onClick={() => handleReset()}
            disabled={saving || cancelling}
            className="px-2 py-1 text-gray-400 hover:text-gray-200 text-xs flex items-center gap-1"
          >
            <RotateCcw size={12} />
            放弃修改
          </button>
          <button
            type="button"
            onClick={handleSaveExit}
            disabled={saving}
            className="px-3 py-1 bg-blue-700 text-white rounded hover:bg-blue-600 disabled:opacity-40 text-xs flex items-center gap-1"
          >
            {saving ? '保存中...' : <><Save size={12} /> 保存并退出</>}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="p-1 text-gray-400 hover:text-white"
          >
            <X size={16} />
          </button>
        </div>
      </div>

      {/* Main content */}
      <div className="flex flex-1 min-h-0">
        {/* Left: File tree */}
        <div className="w-56 border-r border-vscode-panel-border overflow-y-auto shrink-0">
          <MergeFileTree
            items={items}
            activeItemId={activeItemId}
            onSelect={handleSelectItem}
            summary={summary}
          />
        </div>

        {/* Right: Diff view + conflict operations */}
        <div className="flex-1 flex flex-col min-w-0">
          {activeItem ? (
            <div className="flex-1 flex flex-col min-h-0">
              {/* Diff view */}
              <div className="flex-1 p-2 overflow-hidden">
                <MergeDiffView
                  leftContent={activeItem.resolvedContent || activeItem.leftContent}
                  rightContent={activeItem.rightContent}
                  leftLabel={activeItem.resolution ? '合并结果' : '导入版本'}
                  rightLabel="现有版本"
                />
              </div>
              {/* Conflict operations */}
              <div className="h-48 border-t border-vscode-panel-border shrink-0 relative">
                <MergeConflictItem
                  item={activeItem}
                  onResolve={(decision, content) => handleResolve(activeItem.id, decision, content)}
                  onReset={handleReset}
                  onAiMerge={handleAiMerge}
                  aiMerging={aiMerging}
                />
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-center h-full text-gray-500 text-sm">
              {items.length === 0 ? '没有发现冲突' : '选择一个冲突项'}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
