import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Globe, X, Search, CheckCircle, AlertCircle, Loader2, Clock, Sparkles } from 'lucide-react';

const STATUS_ICON = {
  pending: Clock,
  searching: Search,
  fetching: Loader2,
  extracting: Loader2,
  success: CheckCircle,
  failed: AlertCircle,
  skipped: Clock,
};

const STATUS_LABEL = {
  pending: '等待中',
  searching: '搜索中',
  fetching: '获取页面',
  extracting: 'AI提取',
  success: '成功',
  failed: '失败',
  skipped: '跳过',
};

const STATUS_COLOR = {
  pending: 'text-gray-500',
  searching: 'text-blue-400',
  fetching: 'text-blue-400',
  extracting: 'text-amber-400',
  success: 'text-green-400',
  failed: 'text-rose-400',
  skipped: 'text-gray-600',
};

/**
 * CharacterEnrichPanel — manual web-search enrichment UI.
 *
 * Props:
 *   - novelId: string
 *   - characters: Array<{id, name}> — initial character list
 *   - onClose: () => void
 *   - onComplete: () => void — called when enrichment finishes
 *   - initialSelectedIds: string[] — pre-selected character ids
 */
export function CharacterEnrichPanel({ novelId, characters, onClose, onComplete, initialSelectedIds }) {
  const mana = typeof window !== 'undefined' ? window.mana : null;
  const [fanworkName, setFanworkName] = useState('');
  const [running, setRunning] = useState(false);
  const [runId, setRunId] = useState('');
  const [logs, setLogs] = useState([]);
  const [charStatus, setCharStatus] = useState(() => {
    const m = {};
    for (const ch of (characters || [])) {
      m[ch.id || ch.name] = { id: ch.id || ch.name, name: ch.name || ch.id, status: 'pending', message: '' };
    }
    return m;
  });
  const [selectedIds, setSelectedIds] = useState(() => {
    const s = new Set();
    if (Array.isArray(initialSelectedIds) && initialSelectedIds.length > 0) {
      for (const id of initialSelectedIds) s.add(id);
    } else {
      for (const ch of (characters || [])) {
        s.add(ch.id || ch.name);
      }
    }
    return s;
  });
  const [summary, setSummary] = useState(null);
  const [completionNotice, setCompletionNotice] = useState(null);
  const logEndRef = useRef(null);
  const autoCloseTimerRef = useRef(null);

  // Auto-detect fanwork name from world meta on mount
  useEffect(() => {
    if (!mana?.novel?.active) return;
    mana.novel.active().then((active) => {
      if (active?.dir) {
        mana.fs.readJson(`${active.dir}/world/meta.json`, null)
          .then((meta) => {
            if (meta?.possibleFanworkOf && meta.possibleFanworkOf !== 'null' && meta.possibleFanworkOf !== '原创作品') {
              setFanworkName(meta.possibleFanworkOf);
            }
          })
          .catch(() => {});
      }
    }).catch(() => {});
  }, [mana]);

  // Subscribe to runtime progress events
  useEffect(() => {
    if (!mana?.runtime?.on || !runId) return;
    const unsub = mana.runtime.on('agent:event', (payload) => {
      if (payload.runId !== runId) return;
      if (payload.subagentId !== 'character-enricher') return;
      const { charName, status, message, total, successCount, failCount } = payload.data || {};

      if (status === 'start' && total) {
        setLogs((prev) => [...prev, `开始补全 ${total} 个角色`]);
        setSummary({ total, done: 0, success: 0, fail: 0 });
      } else if (status === 'complete') {
        setLogs((prev) => [...prev, message || `完成: ${successCount} 成功, ${failCount} 失败`]);
        setSummary((s) => s ? { ...s, done: s.total } : s);
        setRunning(false);
        setCompletionNotice({ successCount, failCount, message: message || `完成: ${successCount} 成功, ${failCount} 失败` });
        onComplete?.();
        // 2 秒后自动关闭
        autoCloseTimerRef.current = setTimeout(() => {
          if (document.visibilityState !== 'hidden') onClose?.();
        }, 2000);
      } else if (charName && charName !== '_all') {
        setCharStatus((prev) => ({
          ...prev,
          [charName]: { ...(prev[charName] || { name: charName }), status: status || 'pending', message: (message || '').split('\n')[0] },
        }));
        // Split multi-line messages into separate log entries for readability
        const basePrefix = `[${charName}] ${STATUS_LABEL[status] || status}`;
        if (message && message.includes('\n')) {
          setLogs((prev) => [...prev, `${basePrefix}:`, ...message.split('\n').map((ln) => `  ${ln}`)]);
        } else {
          setLogs((prev) => [...prev, `${basePrefix}${message ? ': ' + message : ''}`]);
        }
        if (status === 'success' || status === 'failed' || status === 'skipped') {
          setSummary((s) => s ? { ...s, done: s.done + 1, success: status === 'success' ? s.success + 1 : s.success, fail: status === 'failed' || status === 'skipped' ? s.fail + 1 : s.fail } : s);
        }
      } else if (charName === '_all' && message) {
        if (message.includes('\n')) {
          setLogs((prev) => [...prev, ...message.split('\n')]);
        } else {
          setLogs((prev) => [...prev, message]);
        }
      }
    });
    return unsub;
  }, [mana, runId, onComplete]);

  // Auto-scroll log to bottom
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  // Clean up auto-close timer on unmount
  useEffect(() => {
    return () => {
      if (autoCloseTimerRef.current) clearTimeout(autoCloseTimerRef.current);
    };
  }, []);

  const startEnrichment = async () => {
    if (!mana?.novel?.enrichCharacters || running) return;
    if (selectedIds.size === 0) {
      setLogs((prev) => [...prev, '请至少选择一个角色']);
      return;
    }
    setRunning(true);
    setLogs((prev) => [...prev, `启动联网搜索补全（${selectedIds.size} 个角色）...`]);
    setSummary(null);
    setCharStatus((prev) => {
      const next = {};
      for (const k of Object.keys(prev)) {
        next[k] = { ...prev[k], status: selectedIds.has(k) ? 'pending' : 'skipped', message: '' };
      }
      return next;
    });
    try {
      const selectedArray = Array.from(selectedIds);
      // Generate runId BEFORE the IPC call so the useEffect subscription
      // has the matching runId when progress/completion events arrive.
      // Events fired during enrichment are dropped if runId is still ''.
      const expectedRunId = `enrich-${novelId || ''}-${Date.now()}`;
      setRunId(expectedRunId);
      const result = await mana.novel.enrichCharacters(novelId, fanworkName.trim() || undefined, selectedArray, expectedRunId);
      // Use result.runId in case backend chose a different one
      if (result.runId && result.runId !== expectedRunId) setRunId(result.runId);
      if (result.fanworkName) {
        setLogs((prev) => [...prev, `检测到同人作品: ${result.fanworkName}`]);
      } else {
        setLogs((prev) => [...prev, '未检测到同人作品，未提供作品名，跳过补全']);
        setRunning(false);
      }
    } catch (err) {
      setLogs((prev) => [...prev, `启动失败: ${err.message}`]);
      setRunning(false);
    }
  };

  const progressPct = useMemo(() => {
    if (!summary || !summary.total) return 0;
    return Math.round((summary.done / summary.total) * 100);
  }, [summary]);

  const charList = useMemo(() => {
    return Object.values(charStatus);
  }, [charStatus]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="bg-vscode-panel-bg border border-vscode-panel-border rounded-lg shadow-xl w-[560px] max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-vscode-panel-border">
          <div className="flex items-center gap-2 text-gray-200 font-semibold">
            <Sparkles size={16} className="text-amber-400" />
            联网搜索补全角色人设
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-white">
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {/* Fanwork name input */}
          <div>
            <label className="text-gray-500 text-[11px] block mb-1">原作/同人作品名称（可选，留空则自动检测）</label>
            <div className="flex gap-2">
              <input
                type="text"
                value={fanworkName}
                onChange={(e) => setFanworkName(e.target.value)}
                placeholder="例如: 蔚蓝档案, 原神, Fate/stay night..."
                disabled={running}
                className="flex-1 bg-vscode-sidebar border border-vscode-panel-border rounded px-2 py-1 text-xs text-gray-300 outline-none focus:border-blue-500 disabled:opacity-50"
              />
            </div>
            <div className="text-gray-600 text-[10px] mt-0.5">
              系统会根据作品名自动判断文化圈（中日韩/欧美）并路由到最优搜索源。
            </div>
          </div>

          {/* Progress bar */}
          {summary && (
            <div>
              <div className="flex items-center justify-between text-[11px] mb-1">
                <span className="text-gray-400">总进度</span>
                <span className="text-gray-400">{summary.done}/{summary.total} ({progressPct}%)</span>
              </div>
              <div className="h-1.5 bg-vscode-sidebar rounded-full overflow-hidden">
                <div
                  className="h-full bg-blue-500 transition-all duration-300"
                  style={{ width: `${progressPct}%` }}
                />
              </div>
              <div className="flex gap-3 text-[10px] mt-1">
                <span className="text-green-400">成功 {summary.success}</span>
                <span className="text-rose-400">失败 {summary.fail}</span>
                <span className="text-gray-500">待处理 {summary.total - summary.done}</span>
              </div>
            </div>
          )}

          {/* Completion notice */}
          {completionNotice && (
            <div className="bg-green-900/20 border border-green-700/40 rounded p-2 text-center">
              <div className="text-green-400 text-xs font-semibold">{completionNotice.message}</div>
              <div className="text-green-500/70 text-[10px] mt-0.5">2 秒后自动关闭...</div>
            </div>
          )}

          {/* Character selection */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-gray-500 text-[11px]">选择要补全的角色</label>
              <div className="flex gap-2 text-[10px]">
                <button
                  onClick={() => setSelectedIds(new Set(Object.keys(charStatus)))}
                  disabled={running}
                  className="text-blue-400 hover:text-blue-300 disabled:opacity-40"
                >全选</button>
                <button
                  onClick={() => setSelectedIds(new Set())}
                  disabled={running}
                  className="text-gray-500 hover:text-gray-300 disabled:opacity-40"
                >取消全选</button>
              </div>
            </div>
            <div className="border border-vscode-panel-border rounded divide-y divide-vscode-panel-border/50 max-h-48 overflow-y-auto">
              {charList.map((ch) => {
                const Icon = STATUS_ICON[ch.status] || Clock;
                const isSpinning = ch.status === 'searching' || ch.status === 'fetching' || ch.status === 'extracting';
                const isSelected = selectedIds.has(ch.id);
                return (
                  <div key={ch.id} className="flex items-center gap-2 px-3 py-1.5 text-xs">
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => {
                        setSelectedIds((prev) => {
                          const next = new Set(prev);
                          if (next.has(ch.id)) next.delete(ch.id);
                          else next.add(ch.id);
                          return next;
                        });
                      }}
                      disabled={running}
                      className="accent-blue-500"
                    />
                    <Icon size={12} className={`shrink-0 ${isSpinning ? 'animate-spin' : ''} ${STATUS_COLOR[ch.status] || 'text-gray-500'}`} />
                    <span className={`flex-1 truncate ${isSelected ? 'text-gray-300' : 'text-gray-600'}`}>{ch.name}</span>
                    <span className={`text-[10px] ${STATUS_COLOR[ch.status] || 'text-gray-500'}`}>
                      {STATUS_LABEL[ch.status] || ch.status}
                    </span>
                    {ch.message && (
                      <span className="text-[10px] text-gray-600 truncate max-w-[140px]" title={ch.message}>
                        {ch.message}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
            <div className="text-[10px] text-gray-600 mt-0.5">
              已选择 {selectedIds.size} / {charList.length} 个角色
            </div>
          </div>

          {/* Log output */}
          <div>
            <label className="text-gray-500 text-[11px] block mb-1">运行日志</label>
            <div className="bg-vscode-sidebar border border-vscode-panel-border rounded p-2 h-32 overflow-y-auto font-mono text-[10px] text-gray-400 leading-relaxed">
              {logs.length === 0 ? (
                <span className="text-gray-600 italic">等待启动...</span>
              ) : (
                logs.map((log, i) => {
                  const isDetail = log.startsWith('  ') || log.startsWith('    ');
                  return (
                    <div key={i} className={isDetail ? 'whitespace-pre-wrap break-words text-gray-500' : 'truncate'} title={log}>
                      {log}
                    </div>
                  );
                })
              )}
              <div ref={logEndRef} />
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-4 py-3 border-t border-vscode-panel-border">
          <div className="text-[10px] text-gray-600">
            {running ? (
              <span className="flex items-center gap-1 text-blue-400">
                <Loader2 size={10} className="animate-spin" /> 补全进行中...
              </span>
            ) : summary ? (
              <span>完成: {summary.success} 成功 / {summary.fail} 失败</span>
            ) : (
              <span>点击启动开始联网搜索</span>
            )}
          </div>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="px-3 py-1.5 text-xs text-gray-400 hover:text-gray-200 rounded border border-vscode-panel-border"
            >
              关闭
            </button>
            <button
              onClick={startEnrichment}
              disabled={running || !characters?.length}
              className="px-3 py-1.5 text-xs bg-blue-700 text-white rounded hover:bg-blue-600 disabled:opacity-40 flex items-center gap-1"
            >
              {running ? <Loader2 size={12} className="animate-spin" /> : <Globe size={12} />}
              {running ? '补全中...' : '启动联网补全'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
