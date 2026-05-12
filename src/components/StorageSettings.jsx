import React, { useCallback, useEffect, useState } from 'react';
import { useI18n } from '@/i18n/LanguageContext.jsx';
import { HardDrive, Trash2 } from 'lucide-react';

export function StorageSettings() {
  const { t } = useI18n();
  const mana = typeof window !== 'undefined' ? window.mana : null;

  const [chatMaxMB, setChatMaxMB] = useState(200);
  const [offlineMaxMB, setOfflineMaxMB] = useState(100);
  const [chatStats, setChatStats] = useState({ totalBytes: 0, threadCount: 0 });
  const [offlineStats, setOfflineStats] = useState({ totalBytes: 0 });
  const [savedFlash, setSavedFlash] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadConfig();
    loadStats();
  }, []);

  async function loadConfig() {
    if (!mana?.config) return;
    try {
      const cfg = await mana.config.getApp();
      if (cfg?.storageQuota) {
        setChatMaxMB(cfg.storageQuota.chatHistoryMaxMB ?? 200);
        setOfflineMaxMB(cfg.storageQuota.offlineLogMaxMB ?? 100);
      }
    } catch (err) {
      console.error('[StorageSettings] loadConfig failed', err);
    }
  }

  async function loadStats() {
    setLoading(true);
    try {
      if (mana?.chatHistory?.getStorageStats) {
        const s = await mana.chatHistory.getStorageStats();
        setChatStats(s || { totalBytes: 0, threadCount: 0 });
      }
      if (mana?.offlineLog?.getStorageStats) {
        const s = await mana.offlineLog.getStorageStats();
        setOfflineStats(s || { totalBytes: 0 });
      }
    } catch (err) {
      console.error('[StorageSettings] loadStats failed', err);
    }
    setLoading(false);
  }

  const onSave = useCallback(async () => {
    if (!mana?.config) return;
    try {
      await mana.config.setApp({
        storageQuota: {
          chatHistoryMaxMB: Math.max(10, Math.floor(chatMaxMB)),
          offlineLogMaxMB: Math.max(10, Math.floor(offlineMaxMB)),
        },
      });
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1500);
    } catch (err) {
      console.error('[StorageSettings] save failed', err);
    }
  }, [chatMaxMB, offlineMaxMB, mana]);

  const onEnforceChat = async () => {
    if (!mana?.chatHistory) return;
    try {
      const r = await mana.chatHistory.enforceQuota(chatMaxMB * 1024 * 1024);
      await loadStats();
      window.alert(`已清理 ${r.deleted} 个旧对话`);
    } catch (err) {
      console.error('[StorageSettings] enforce chat quota failed', err);
    }
  };

  const onEnforceOffline = async () => {
    if (!mana?.offlineLog) return;
    try {
      const r = await mana.offlineLog.enforceQuota(offlineMaxMB * 1024 * 1024);
      await loadStats();
      window.alert(`已清理 ${r.deleted} 个旧日志文件`);
    } catch (err) {
      console.error('[StorageSettings] enforce offline quota failed', err);
    }
  };

  const fmtMB = (bytes) => (bytes / 1024 / 1024).toFixed(2);

  return (
    <div className="text-xs space-y-4 max-w-xl">
      <p className="text-gray-500">
        配置对话历史与离线操作日志的存储上限。超出上限时，最久远的记录会被自动删除，直到实际占用低于设定值的 90%。
      </p>

      {/* Chat History Quota */}
      <div className="border border-vscode-panel-border rounded p-3 space-y-3">
        <div className="flex items-center gap-2 text-gray-300 font-semibold">
          <HardDrive size={14} />
          <span>对话历史存储</span>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex flex-col gap-1 flex-1">
            <span className="text-gray-500">最大存储空间 (MB)</span>
            <input
              type="number"
              min={10}
              className="bg-vscode-sidebar border border-vscode-panel-border rounded px-2 py-1.5 text-gray-200"
              value={chatMaxMB}
              onChange={(e) => setChatMaxMB(parseInt(e.target.value) || 0)}
            />
          </label>
          <div className="text-gray-500">
            当前占用:{' '}
            <span className="text-gray-300">
              {loading ? '...' : `${fmtMB(chatStats.totalBytes)} MB (${chatStats.threadCount} 个对话)`}
            </span>
          </div>
        </div>
        <button
          type="button"
          className="flex items-center gap-1 text-rose-400 hover:text-rose-300"
          onClick={onEnforceChat}
        >
          <Trash2 size={12} />
          立即清理超出上限的对话
        </button>
      </div>

      {/* Offline Log Quota */}
      <div className="border border-vscode-panel-border rounded p-3 space-y-3">
        <div className="flex items-center gap-2 text-gray-300 font-semibold">
          <HardDrive size={14} />
          <span>离线操作日志存储</span>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex flex-col gap-1 flex-1">
            <span className="text-gray-500">最大存储空间 (MB)</span>
            <input
              type="number"
              min={10}
              className="bg-vscode-sidebar border border-vscode-panel-border rounded px-2 py-1.5 text-gray-200"
              value={offlineMaxMB}
              onChange={(e) => setOfflineMaxMB(parseInt(e.target.value) || 0)}
            />
          </label>
          <div className="text-gray-500">
            当前占用:{' '}
            <span className="text-gray-300">
              {loading ? '...' : `${fmtMB(offlineStats.totalBytes)} MB`}
            </span>
          </div>
        </div>
        <button
          type="button"
          className="flex items-center gap-1 text-rose-400 hover:text-rose-300"
          onClick={onEnforceOffline}
        >
          <Trash2 size={12} />
          立即清理超出上限的日志
        </button>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="button"
          className="px-3 py-1.5 bg-blue-700 text-white rounded hover:bg-blue-600"
          onClick={onSave}
        >
          {savedFlash ? '已保存' : '保存设置'}
        </button>
      </div>
    </div>
  );
}
