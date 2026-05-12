import React, { useState } from 'react';
import { AlertTriangle, Check, ChevronDown, ChevronRight, User, Globe, Book, Pen, AlertCircle, Info } from 'lucide-react';

const severityConfig = {
  critical: { icon: AlertCircle, color: 'text-rose-400', bg: 'bg-rose-500/10', border: 'border-rose-500/30', label: '严重' },
  normal: { icon: AlertTriangle, color: 'text-amber-400', bg: 'bg-amber-500/10', border: 'border-amber-500/30', label: '普通' },
  minor: { icon: Info, color: 'text-blue-400', bg: 'bg-blue-500/10', border: 'border-blue-500/30', label: '轻微' },
};

const typeIcons = {
  character: User,
  world: Globe,
  outline: Book,
  style: Pen,
};

export function ConflictReportPanel({ conflicts, summary, onMerge, onNewProject, onDiscard }) {
  const [expandedItems, setExpandedItems] = useState({});
  const [viewFilter, setViewFilter] = useState('all'); // all | critical | normal | minor

  const toggleItem = (idx) => {
    setExpandedItems((prev) => ({ ...prev, [idx]: !prev[idx] }));
  };

  const filteredConflicts = conflicts.filter((c) => {
    if (viewFilter === 'all') return true;
    return c.severity === viewFilter;
  });

  const groups = {};
  for (const c of filteredConflicts) {
    const key = c.type || 'other';
    groups[key] = groups[key] || [];
    groups[key].push(c);
  }

  return (
    <div className="space-y-3">
      {/* Summary banner */}
      <div className={`p-3 rounded border ${summary.critical > 0 ? 'border-rose-500/30 bg-rose-500/10' : 'border-amber-500/30 bg-amber-500/10'}`}>
        <div className="flex items-center gap-2 text-sm font-semibold text-gray-200">
          {summary.critical > 0 ? <AlertCircle size={16} className="text-rose-400" /> : <Info size={16} className="text-amber-400" />}
          检测到 {summary.total} 项冲突
        </div>
        <div className="flex gap-3 mt-2 text-xs">
          {summary.critical > 0 && <span className="text-rose-400">严重: {summary.critical}</span>}
          {summary.normal > 0 && <span className="text-amber-400">普通: {summary.normal}</span>}
          {summary.minor > 0 && <span className="text-blue-400">轻微: {summary.minor}</span>}
        </div>
      </div>

      {/* Filter tabs */}
      <div className="flex gap-1 text-xs">
        {['all', 'critical', 'normal', 'minor'].map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setViewFilter(f)}
            className={`px-2 py-1 rounded ${viewFilter === f ? 'bg-vscode-active-item text-gray-200' : 'text-gray-500 hover:text-gray-300'}`}
          >
            {f === 'all' ? '全部' : severityConfig[f]?.label || f}
          </button>
        ))}
      </div>

      {/* Conflict groups */}
      <div className="space-y-2 max-h-80 overflow-y-auto">
        {Object.entries(groups).map(([type, items]) => {
          const TypeIcon = typeIcons[type] || AlertTriangle;
          return (
            <div key={type} className="border border-vscode-panel-border rounded">
              <div className="px-2 py-1.5 bg-vscode-sidebar text-gray-400 font-medium text-[11px] flex items-center gap-1.5 uppercase tracking-wide">
                <TypeIcon size={12} />
                {type === 'character' && '角色冲突'}
                {type === 'world' && '世界观冲突'}
                {type === 'outline' && '大纲冲突'}
                {type === 'style' && '文风差异'}
                <span className="text-gray-600">({items.length})</span>
              </div>
              {items.map((c, i) => {
                const cfg = severityConfig[c.severity] || severityConfig.normal;
                const Icon = cfg.icon;
                const isExpanded = expandedItems[`${type}-${i}`];
                return (
                  <div key={i} className="border-t border-vscode-panel-border">
                    <button
                      type="button"
                      onClick={() => toggleItem(`${type}-${i}`)}
                      className="w-full flex items-start gap-2 px-2 py-1.5 text-left hover:bg-vscode-active-item/50"
                    >
                      {isExpanded ? <ChevronDown size={12} className="mt-0.5 shrink-0 text-gray-500" /> : <ChevronRight size={12} className="mt-0.5 shrink-0 text-gray-500" />}
                      <span className={`px-1 rounded text-[10px] ${cfg.color} ${cfg.bg} shrink-0`}>{cfg.label}</span>
                      <span className="text-xs text-gray-300 flex-1">{c.reason}</span>
                    </button>
                    {isExpanded && (
                      <div className="px-3 pb-2 pt-1 space-y-2">
                        {(c.localTarget || c.importedTarget) && (
                          <div className="text-[11px] text-gray-500">
                            涉及: <span className="text-gray-400">{c.importedTarget || c.localTarget}</span>
                            {c.detail && <div className="mt-0.5 text-gray-600">{c.detail}</div>}
                          </div>
                        )}
                        {(c.localContent || c.importedContent) && (
                          <div className="grid grid-cols-2 gap-2 border border-vscode-panel-border rounded p-2 text-[11px]">
                            {c.importedContent && (
                              <div>
                                <div className="text-blue-400 mb-0.5">导入:</div>
                                <div className="text-gray-400 whitespace-pre-wrap line-clamp-6">{c.importedContent}</div>
                              </div>
                            )}
                            {c.localContent && (
                              <div>
                                <div className="text-green-400 mb-0.5">现有:</div>
                                <div className="text-gray-400 whitespace-pre-wrap line-clamp-6">{c.localContent}</div>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>

      {/* Action buttons */}
      <div className="flex justify-end gap-2 pt-2 border-t border-vscode-panel-border">
        <button
          type="button"
          onClick={onDiscard}
          className="px-3 py-1.5 text-gray-500 hover:text-gray-300 text-xs"
        >
          不接受（放入废纸篓）
        </button>
        {summary.total > 0 ? (
          <button
            type="button"
            onClick={onMerge}
            className="px-3 py-1.5 bg-amber-700 text-white rounded hover:bg-amber-600 text-xs flex items-center gap-1"
          >
            <AlertTriangle size={12} />
            接受并进入合并模式
          </button>
        ) : (
          <button
            type="button"
            onClick={onMerge}
            className="px-3 py-1.5 bg-blue-700 text-white rounded hover:bg-blue-600 text-xs flex items-center gap-1"
          >
            <Check size={12} />
            无冲突，直接导入
          </button>
        )}
      </div>
    </div>
  );
}
