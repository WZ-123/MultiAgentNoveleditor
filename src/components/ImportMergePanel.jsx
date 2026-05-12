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
      onClose();
    } catch (err) {
      setError(err?.message || String(err));
    }
    setSaving(false);
  }, [sessionId, mana, onClose]);

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

  if (error) {
    return (
      <div className="fixed inset-0 z-[100] bg-vscode-bg flex items-center justify-center">
        <div className="text-rose-400 text-sm flex items-center gap-2">
          <AlertTriangle size={16} />
          {error}
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-[100] bg-vscode-bg flex flex-col">
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
          <button
            type="button"
            onClick={() => handleReset()}
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
