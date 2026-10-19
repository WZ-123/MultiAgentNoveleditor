import React, { useEffect, useState } from 'react';
import { Wifi, X, Trash2, Save } from 'lucide-react';

export function OfflineSyncDialog({ novelId, onClose }) {
  const mana = typeof window !== 'undefined' ? window.mana : null;
  const [unsynced, setUnsynced] = useState([]);
  const [byType, setByType] = useState({});
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [processing, setProcessing] = useState(false);

  useEffect(() => {
    loadUnsynced();
  }, [novelId]);

  async function loadUnsynced() {
    if (!mana?.offlineLog) return;
    setLoading(true);
    setError('');
    try {
      const entries = await mana.offlineLog.listUnsynced(novelId);
      setUnsynced(entries || []);
      const grouped = await mana.offlineLog.listUnsyncedByType(novelId);
      setByType(grouped || {});
    } catch (err) {
      setError(err?.message || String(err));
      console.error('[OfflineSyncDialog] load failed', err);
    }
    setLoading(false);
  }

  const typeLabel = (type) => {
    const map = {
      character: '角色卡',
      world: '世界观',
      outline: '大纲',
      chapter: '章节',
      asset: '素材',
      style: '文风记忆',
      timeline: '时间线',
      unknown: '其他',
    };
    return map[type] || type;
  };

  async function handleSync() {
    if (!mana?.offlineLog || unsynced.length === 0) return;
    setProcessing(true);
    try {
      for (const entry of unsynced) {
        await mana.offlineLog.syncEntry(novelId, entry.id);
      }
      onClose();
    } catch (err) {
      console.error('[OfflineSyncDialog] sync failed', err);
      const message = '同步失败: ' + (err?.message || String(err));
      await loadUnsynced();
      setError(message);
    }
    setProcessing(false);
  }

  async function handleDiscard() {
    if (!mana?.offlineLog) return;
    const ok = window.confirm('确定要丢弃所有离线期间的编辑记录吗？此操作不可撤销。');
    if (!ok) return;
    try {
      await mana.offlineLog.discardUnsynced(novelId);
      onClose();
    } catch (err) {
      console.error('[OfflineSyncDialog] discard failed', err);
    }
  }

  const totalCount = unsynced.length;
  const hasPendingWrites = unsynced.some((entry) => entry.persistence !== 'local_committed');

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="bg-vscode-panel-bg border border-vscode-panel-border rounded-lg shadow-xl w-[480px] max-w-[90vw] max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-vscode-panel-border">
          <div className="flex items-center gap-2 text-gray-200">
            <Wifi size={16} className="text-green-400" />
            <span className="font-semibold text-sm">检测到离线编辑记录</span>
          </div>
          <button
            type="button"
            className="text-gray-400 hover:text-white"
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-4 text-xs">
          {error && <div role="alert" className="text-rose-300 mb-2">{error}</div>}
          {loading ? (
            <div className="text-gray-500 text-center py-4">加载中...</div>
          ) : totalCount === 0 ? (
            <div className="text-gray-500 text-center py-4">没有待同步的离线记录</div>
          ) : (
            <>
              <p className="text-gray-400 mb-3">
                你在离线期间共有 <span className="text-white font-bold">{totalCount}</span> 条编辑记录，
                本机已保存的操作仅确认记录；待提交操作需完整数据及版本凭证。
              </p>
              <div className="space-y-2">
                {Object.entries(byType).map(([type, entries]) => (
                  <div
                    key={type}
                    className="border border-vscode-panel-border rounded px-3 py-2"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-gray-300 font-medium">{typeLabel(type)}</span>
                      <span className="text-gray-500">{entries.length} 条</span>
                    </div>
                    <div className="mt-1 text-gray-500">
                      {entries.slice(0, 3).map((e, i) => (
                        <div key={i} className="truncate">
                          {e.action}: {e.targetName || e.targetId || '(未命名)'}
                        </div>
                      ))}
                      {entries.length > 3 && (
                        <div className="text-gray-600">还有 {entries.length - 3} 条...</div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
              {unsynced.map((entry) => <details key={entry.id} className="mt-3 border border-vscode-panel-border rounded p-2">
                <summary>{entry.persistence === 'local_committed' ? '已保存，仅确认' : entry.schemaVersion === 2 && entry.change ? '待写入，需提交' : '旧记录，需人工核对'}：{entry.targetName || entry.targetId || entry.type}</summary>
                <pre className="whitespace-pre-wrap break-words max-h-52 overflow-y-auto mt-2">{JSON.stringify(entry.change || entry.payload, null, 2)}</pre>
              </details>)}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-vscode-panel-border">
          <button
            type="button"
            className="flex items-center gap-1 px-3 py-1.5 text-rose-400 hover:text-rose-300 text-xs"
            onClick={handleDiscard}
            disabled={processing || loading || totalCount === 0}
          >
            <Trash2 size={12} />
            丢弃
          </button>
          <button
            type="button"
            className="flex items-center gap-1 px-3 py-1.5 bg-gray-700 text-gray-200 rounded hover:bg-gray-600 text-xs"
            onClick={onClose}
            disabled={processing}
          >
            <X size={12} />
            稍后处理
          </button>
          <button
            type="button"
            className="flex items-center gap-1 px-3 py-1.5 bg-green-700 text-white rounded hover:bg-green-600 text-xs"
            onClick={handleSync}
            disabled={processing || loading || totalCount === 0}
          >
            <Save size={12} />
            {processing ? '处理中...' : hasPendingWrites ? '确认并提交待保存变更' : '确认保存记录'}
          </button>
        </div>
      </div>
    </div>
  );
}
