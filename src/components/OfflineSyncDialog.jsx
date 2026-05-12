import React, { useEffect, useState } from 'react';
import { Wifi, X, Trash2, Save } from 'lucide-react';

export function OfflineSyncDialog({ novelId, onClose }) {
  const mana = typeof window !== 'undefined' ? window.mana : null;
  const [unsynced, setUnsynced] = useState([]);
  const [byType, setByType] = useState({});
  const [loading, setLoading] = useState(true);
  const [processing, setProcessing] = useState(false);

  useEffect(() => {
    loadUnsynced();
  }, [novelId]);

  async function loadUnsynced() {
    if (!mana?.offlineLog) return;
    setLoading(true);
    try {
      const entries = await mana.offlineLog.listUnsynced(novelId);
      setUnsynced(entries || []);
      const grouped = await mana.offlineLog.listUnsyncedByType(novelId);
      setByType(grouped || {});
    } catch (err) {
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
      // Apply each entry to the novel store
      for (const entry of unsynced) {
        await applyEntry(entry);
      }
      // Mark all as synced
      const ids = unsynced.map((e) => e.id);
      await mana.offlineLog.markSynced(ids);
      onClose();
    } catch (err) {
      console.error('[OfflineSyncDialog] sync failed', err);
      alert('同步失败: ' + (err?.message || String(err)));
    }
    setProcessing(false);
  }

  async function applyEntry(entry) {
    const { type, action, targetId, payload } = entry;
    if (!mana?.novel) return;

    switch (type) {
      case 'character': {
        if (action === 'create' || action === 'update') {
          await mana.novel.writeCharacter(novelId, { id: targetId, ...payload });
        }
        break;
      }
      case 'world': {
        if (action === 'update') {
          await mana.novel.writeWorld(novelId, payload);
        }
        break;
      }
      case 'chapter': {
        if (action === 'update' && payload?.name && payload?.content !== undefined) {
          await mana.novel.saveChapter(novelId, payload.name, payload.content);
        }
        break;
      }
      case 'style': {
        if (action === 'update' && payload?.text) {
          await mana.novel.writeStyleMemory(novelId, payload.text);
        }
        break;
      }
      case 'timeline': {
        if (action === 'create' && payload?.event) {
          await mana.novel.appendTimeline(novelId, payload.event);
        }
        break;
      }
      case 'asset': {
        if (action === 'create' || action === 'update') {
          await mana.novel.upsertAsset(novelId, { id: targetId, ...payload });
        }
        break;
      }
      default:
        console.warn('[OfflineSyncDialog] unhandled entry type', type);
    }
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
          {loading ? (
            <div className="text-gray-500 text-center py-4">加载中...</div>
          ) : totalCount === 0 ? (
            <div className="text-gray-500 text-center py-4">没有待同步的离线记录</div>
          ) : (
            <>
              <p className="text-gray-400 mb-3">
                你在离线期间共有 <span className="text-white font-bold">{totalCount}</span> 条编辑记录，
                是否将这些修改同步到设定集中？
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
            {processing ? '同步中...' : '同步到设定集'}
          </button>
        </div>
      </div>
    </div>
  );
}
