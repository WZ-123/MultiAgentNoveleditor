import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { BookOpen } from 'lucide-react';
import { useI18n } from '@/i18n/LanguageContext.jsx';
import { useNovel } from '@/hooks/useNovel.js';

export function WorkspaceSwitcher({ onImportExternal, onActiveNovelChanged }) {
  const { t } = useI18n();
  const mana = typeof window !== 'undefined' ? window.mana : null;
  const { novels, active, open, close, create, importExisting, remove } = useNovel();
  const [busy, setBusy] = useState(false);
  const [createTitle, setCreateTitle] = useState('');
  const [createAuthorizationMode, setCreateAuthorizationMode] = useState('confirm-each-change');
  const [error, setError] = useState('');
  const [opened, setOpened] = useState(false);
  const [menuPos, setMenuPos] = useState(null);
  const popRef = useRef(null);
  const triggerRef = useRef(null);

  useEffect(() => {
    if (!opened) return undefined;
    const onDoc = (e) => {
      if (popRef.current?.contains(e.target)) return;
      if (triggerRef.current?.contains(e.target)) return;
      setOpened(false);
    };
    const onKey = (e) => { if (e.key === 'Escape') setOpened(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [opened]);

  useEffect(() => {
    if (!opened || !triggerRef.current) return undefined;
    const updatePos = () => {
      const rect = triggerRef.current.getBoundingClientRect();
      const vw = typeof window !== 'undefined' ? window.innerWidth : 1200;
      const menuWidth = 420;
      let left = Math.max(8, rect.left);
      if (left + menuWidth > vw) {
        left = Math.max(8, vw - menuWidth - 8);
      }
      setMenuPos({ top: rect.bottom + 4, left });
    };
    updatePos();
    window.addEventListener('resize', updatePos);
    return () => window.removeEventListener('resize', updatePos);
  }, [opened]);

  const onCreate = useCallback(async () => {
    if (!mana?.fs) return;
    setBusy(true);
    setError('');
    try {
      const dir = await mana.fs.pickDirectory({ title: t('novel.pickDir') });
      if (!dir) return;
      const title = createTitle.trim() || dir.split(/[/\\]/).pop() || 'Untitled';
      const r = await create({ title, dir });
      if (r?.id) {
        if (createAuthorizationMode === 'append-prose') await mana.codex.setWritingAuthorization(r.id, 'append-prose');
        await open(r.id);
        await onActiveNovelChanged?.();
      }
      setCreateTitle('');
      setCreateAuthorizationMode('confirm-each-change');
      setOpened(false);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setBusy(false);
    }
  }, [mana, t, createTitle, createAuthorizationMode, create, open, onActiveNovelChanged]);

  const onImport = useCallback(async () => {
    if (!mana?.fs) return;
    setBusy(true);
    try {
      const dir = await mana.fs.pickDirectory({ title: t('novel.pickDir') });
      if (!dir) return;
      try {
        const r = await importExisting(dir);
        if (r?.id) {
          await open(r.id);
          await onActiveNovelChanged?.();
        }
      } catch (err) {
        // No novel.json present — auto-create one with directory name as title
        const title = dir.split(/[/\\]/).pop() || 'Untitled';
        const r = await create({ title, dir });
        if (r?.id) {
          await open(r.id);
          await onActiveNovelChanged?.();
        }
      }
      setOpened(false);
    } finally {
      setBusy(false);
    }
  }, [mana, t, importExisting, create, open, onActiveNovelChanged]);

  const onSwitch = useCallback(async (id) => {
    setBusy(true);
    try {
      await open(id);
      await onActiveNovelChanged?.();
      setOpened(false);
    } finally {
      setBusy(false);
    }
  }, [open, onActiveNovelChanged]);

  const onClose = useCallback(async () => {
    setBusy(true);
    try {
      await close();
      await onActiveNovelChanged?.();
      setOpened(false);
    } finally {
      setBusy(false);
    }
  }, [close, onActiveNovelChanged]);

  const onRemove = useCallback(async (id) => {
    setBusy(true);
    try { await remove(id); }
    finally { setBusy(false); }
  }, [remove]);

  const label = active?.title
    ? `${t('novel.activePrefix')}: ${active.title}`
    : t('novel.noActive');

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        data-testid="workspace-switcher-trigger"
        type="button"
        className="flex items-center gap-1 px-2 py-0.5 hover:bg-white/15 rounded text-xs"
        title={label}
        onClick={() => setOpened((v) => !v)}
      >
        <BookOpen size={12} />
        <span className="truncate max-w-[200px]">{label}</span>
      </button>
      {opened && menuPos && createPortal(
        <div
          ref={popRef}
          style={{
            position: 'fixed',
            top: menuPos.top,
            left: menuPos.left,
            zIndex: 9999,
            width: '420px',
          }}
          className="bg-vscode-sidebar text-vscode-text border border-vscode-panel-border rounded shadow-xl p-3"
        >
          <div className="flex flex-col gap-3 text-xs">
            <div className="font-bold text-sm">{t('novel.list')}</div>

            <div className="max-h-48 overflow-y-auto border border-vscode-panel-border/60 rounded">
              {novels.length === 0 ? (
                <div className="px-2 py-3 text-gray-500">{t('novel.noNovels')}</div>
              ) : novels.map((n) => {
                const isActive = active?.id === n.id;
                return (
                  <div key={n.id} data-novel-id={n.id} className="flex items-center gap-2 px-2 py-1 border-b border-vscode-panel-border/40 last:border-0">
                    <div className="flex-1 min-w-0">
                      <div className="truncate text-gray-200">{n.title}</div>
                      <div className="truncate text-gray-500 font-mono text-[10px]">{n.dir}</div>
                    </div>
                    {isActive ? (
                      <span className="px-2 py-0.5 rounded bg-green-600/30 text-green-300 text-[10px]">{t('novel.activeBadge')}</span>
                    ) : (
                      <button
                        type="button"
                        className="px-2 py-0.5 rounded bg-vscode-active-item hover:bg-blue-600/40 text-[11px] disabled:opacity-50"
                        disabled={busy}
                        data-testid="switch-novel"
                        onClick={() => onSwitch(n.id)}
                      >
                        {t('novel.switch')}
                      </button>
                    )}
                    <button
                      type="button"
                      className="px-2 py-0.5 rounded text-red-400 hover:bg-red-600/20 text-[11px] disabled:opacity-30"
                      disabled={busy || isActive}
                      onClick={() => onRemove(n.id)}
                      title={t('novel.removeFromList')}
                    >
                      ×
                    </button>
                  </div>
                );
              })}
            </div>

            <div className="grid grid-cols-1 gap-2 border-t border-vscode-panel-border/60 pt-3">
              <input
                type="text"
                value={createTitle}
                onChange={(e) => setCreateTitle(e.target.value)}
                placeholder={t('novel.titlePlaceholder')}
                className="bg-vscode-bg/60 border border-vscode-panel-border/60 rounded px-2 py-1 text-xs outline-none focus:border-blue-500"
              />
              <fieldset className="rounded border border-vscode-panel-border/60 p-2" data-testid="new-novel-writing-authorization">
                <legend className="px-1 text-[10px] text-gray-400">AI 正文写入</legend>
                <label className="flex cursor-pointer items-start gap-2 py-1">
                  <input type="radio" name="new-novel-writing-authorization" value="confirm-each-change" checked={createAuthorizationMode === 'confirm-each-change'} onChange={(event) => setCreateAuthorizationMode(event.target.value)} />
                  <span><span className="block text-gray-200">逐次确认</span><span className="block text-[10px] text-gray-500">每次修改都先展示差异。</span></span>
                </label>
                <label className="flex cursor-pointer items-start gap-2 py-1">
                  <input type="radio" name="new-novel-writing-authorization" value="append-prose" checked={createAuthorizationMode === 'append-prose'} onChange={(event) => setCreateAuthorizationMode(event.target.value)} />
                  <span><span className="block text-gray-200">允许在本项目内新增正文</span><span className="block text-[10px] text-gray-500">仅自动保存新章和章末追加，改动已有文字仍需确认。</span></span>
                </label>
              </fieldset>
              {error && <div className="rounded border border-red-500/30 bg-red-500/10 px-2 py-1 text-[10px] text-red-300">{error}</div>}
              <div className="flex gap-2">
                <button
                  type="button"
                  className="px-2 py-1 rounded bg-blue-600 hover:bg-blue-500 text-white text-[11px] disabled:opacity-50"
                  disabled={busy}
                  onClick={onCreate}
                >
                  {t('novel.create')}
                </button>
                <button
                  type="button"
                  className="px-2 py-1 rounded bg-vscode-active-item hover:bg-vscode-bg text-[11px] disabled:opacity-50"
                  disabled={busy}
                  onClick={onImport}
                >
                  {t('novel.importExisting')}
                </button>
                <button
                  type="button"
                  className="px-2 py-1 rounded text-gray-400 hover:bg-white/10 text-[11px] disabled:opacity-50"
                  disabled={busy || !active}
                  onClick={onClose}
                >
                  {t('novel.close')}
                </button>
              </div>
              {onImportExternal && (
                <button
                  type="button"
                  className="w-full px-2 py-1 rounded bg-green-800/90 hover:bg-green-700/90 text-white text-[11px] disabled:opacity-50 flex items-center justify-center gap-1"
                  disabled={busy}
                  onClick={() => { setOpened(false); onImportExternal(); }}
                >
                  导入外部小说文件
                </button>
              )}
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
