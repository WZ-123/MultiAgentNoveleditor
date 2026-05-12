import React, { useState } from 'react';
import { Check, Edit3, Sparkles, RotateCcw, AlertCircle, AlertTriangle, Info } from 'lucide-react';

const severityConfig = {
  critical: { icon: AlertCircle, color: 'text-rose-400', bg: 'bg-rose-500/10', label: '严重' },
  normal: { icon: AlertTriangle, color: 'text-amber-400', bg: 'bg-amber-500/10', label: '普通' },
  minor: { icon: Info, color: 'text-blue-400', bg: 'bg-blue-500/10', label: '轻微' },
};

export function MergeConflictItem({ item, onResolve, onReset, onAiMerge, aiMerging }) {
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState('');
  const [noteText, setNoteText] = useState(item?.userNote || '');

  if (!item) {
    return (
      <div className="flex items-center justify-center h-full text-gray-500 text-xs">
        选择一个冲突项开始合并
      </div>
    );
  }

  const cfg = severityConfig[item.severity] || severityConfig.normal;
  const SevIcon = cfg.icon;
  const isResolved = item.status === 'resolved';

  function handleEdit() {
    setEditText(item.resolvedContent || item.leftContent || '');
    setEditing(true);
  }

  function handleSaveEdit() {
    onResolve('edited', editText);
    setEditing(false);
  }

  function handleStartAiMerge() {
    if (onAiMerge) onAiMerge(item.id, noteText);
  }

  function handleAcceptLeft() {
    onResolve('left', item.leftContent);
  }

  function handleAcceptRight() {
    onResolve('right', item.rightContent);
  }

  return (
    <div className="flex flex-col h-full text-xs">
      {/* Header */}
      <div className="px-3 py-2 border-b border-vscode-panel-border flex items-center gap-2 shrink-0">
        <SevIcon size={14} className={cfg.color} />
        <span className={`px-1 rounded text-[10px] ${cfg.color} ${cfg.bg}`}>{cfg.label}</span>
        <span className="text-gray-200 font-medium flex-1">{item.label || item.id}</span>
        {isResolved && (
          <span className="text-green-400 flex items-center gap-0.5">
            <Check size={12} /> 已解决
          </span>
        )}
      </div>

      {/* Diff View (simplified) */}
      <div className="flex-1 overflow-y-auto p-2 space-y-2">
        {/* Imported version */}
        <div>
          <div className="text-[11px] font-semibold text-blue-400 mb-0.5">导入版本:</div>
          <div className="bg-vscode-sidebar border border-vscode-panel-border rounded p-2 text-[11px] font-mono whitespace-pre-wrap max-h-40 overflow-y-auto text-gray-300">
            {item.leftContent || '(空)'}
          </div>
        </div>

        {/* Existing version */}
        <div>
          <div className="text-[11px] font-semibold text-green-400 mb-0.5">现有版本:</div>
          <div className="bg-vscode-sidebar border border-vscode-panel-border rounded p-2 text-[11px] font-mono whitespace-pre-wrap max-h-40 overflow-y-auto text-gray-300">
            {item.rightContent || '(空)'}
          </div>
        </div>

        {/* Resolved content preview */}
        {isResolved && item.resolvedContent && (
          <div>
            <div className="text-[11px] font-semibold text-amber-400 mb-0.5">合并结果:</div>
            <div className="bg-amber-500/5 border border-amber-500/30 rounded p-2 text-[11px] font-mono whitespace-pre-wrap max-h-40 overflow-y-auto text-gray-200">
              {item.resolvedContent}
            </div>
          </div>
        )}

        {/* Note input */}
        <div>
          <div className="text-[11px] font-semibold text-gray-500 mb-0.5">批注（给AI合并的参考）:</div>
          <textarea
            className="w-full bg-vscode-sidebar border border-vscode-panel-border rounded p-1.5 text-[11px] text-gray-300 outline-none focus:border-blue-500 resize-none"
            rows={2}
            value={noteText}
            onChange={(e) => setNoteText(e.target.value)}
            placeholder="例如：将两个版本的背景描述合并..."
          />
        </div>
      </div>

      {/* Action bar */}
      <div className="px-3 py-2 border-t border-vscode-panel-border flex items-center gap-1.5 flex-wrap shrink-0">
        <button
          type="button"
          onClick={handleAcceptLeft}
          className="px-2 py-1 bg-blue-700 text-white rounded hover:bg-blue-600 text-[11px] flex items-center gap-1"
        >
          <Check size={11} /> 接受导入版
        </button>
        <button
          type="button"
          onClick={handleAcceptRight}
          className="px-2 py-1 bg-green-700 text-white rounded hover:bg-green-600 text-[11px] flex items-center gap-1"
        >
          <Check size={11} /> 接受现有版
        </button>
        <button
          type="button"
          onClick={handleEdit}
          className="px-2 py-1 bg-vscode-active-item text-gray-300 rounded hover:bg-vscode-active-item/80 text-[11px] flex items-center gap-1"
        >
          <Edit3 size={11} /> 编辑
        </button>
        <button
          type="button"
          onClick={handleStartAiMerge}
          disabled={aiMerging}
          className="px-2 py-1 bg-purple-700 text-white rounded hover:bg-purple-600 disabled:opacity-40 text-[11px] flex items-center gap-1"
        >
          <Sparkles size={11} /> {aiMerging ? 'AI合并中...' : 'AI合并'}
        </button>
        {item.status !== 'pending' && (
          <button
            type="button"
            onClick={() => onReset(item.id)}
            className="px-2 py-1 text-gray-500 hover:text-gray-300 rounded text-[11px] flex items-center gap-1 ml-auto"
          >
            <RotateCcw size={11} /> 重置
          </button>
        )}
      </div>

      {/* Edit modal */}
      {editing && (
        <div className="absolute inset-0 z-10 bg-black/70 flex items-center justify-center" onClick={() => setEditing(false)}>
          <div className="bg-vscode-panel-bg border border-vscode-panel-border rounded-lg p-3 w-[500px] max-w-[90vw]" onClick={(e) => e.stopPropagation()}>
            <div className="text-gray-200 font-semibold text-sm mb-2">编辑合并结果</div>
            <textarea
              className="w-full h-48 bg-vscode-sidebar border border-vscode-panel-border rounded p-2 text-xs font-mono text-gray-300 outline-none focus:border-blue-500 resize-none"
              value={editText}
              onChange={(e) => setEditText(e.target.value)}
            />
            <div className="flex justify-end gap-2 mt-2">
              <button type="button" onClick={() => setEditing(false)} className="px-3 py-1 text-gray-400 hover:text-gray-200 text-xs">取消</button>
              <button type="button" onClick={handleSaveEdit} className="px-3 py-1 bg-blue-700 text-white rounded hover:bg-blue-600 text-xs">保存</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
