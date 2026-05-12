import React, { useCallback, useEffect, useState } from 'react';
import { useI18n } from '@/i18n/LanguageContext.jsx';

/**
 * Listens for "awaiting_confirmation" events from the runtime and renders a
 * modal to accept/reject the tool call. Mounted once at the App level.
 */
export function ToolConfirmationModal() {
  const { t } = useI18n();
  const mana = typeof window !== 'undefined' ? window.mana : null;
  const [pending, setPending] = useState(null); // { runId, toolUseId, tool, arguments, subagentId }
  const [patchText, setPatchText] = useState('');
  const [patchError, setPatchError] = useState('');

  useEffect(() => {
    if (!mana?.runtime?.on) return undefined;
    const off = mana.runtime.on('agent:event', (ev) => {
      if (!ev || ev.kind !== 'awaiting_confirmation') return;
      setPending({
        runId: ev.runId,
        toolUseId: ev.data?.toolUseId,
        tool: ev.data?.tool,
        arguments: ev.data?.arguments,
        subagentId: ev.data?.subagentId,
        nodeId: ev.data?.nodeId,
      });
      setPatchText('');
      setPatchError('');
    });
    return () => { try { off?.(); } catch { /* ignore */ } };
  }, [mana]);

  const onAccept = useCallback(async () => {
    if (!pending) return;
    let patch;
    if (patchText.trim()) {
      try { patch = JSON.parse(patchText); }
      catch { setPatchError(t('toolConfirm.patchInvalid')); return; }
    }
    await mana.runtime.resolveToolConfirmation(pending.runId, pending.toolUseId, {
      accept: true,
      patch,
    });
    setPending(null);
  }, [pending, patchText, mana, t]);

  const onReject = useCallback(async () => {
    if (!pending) return;
    await mana.runtime.resolveToolConfirmation(pending.runId, pending.toolUseId, {
      accept: false,
    });
    setPending(null);
  }, [pending, mana]);

  if (!pending) return null;

  const replacePreview = pending.tool === 'replace_chapter_text'
    ? {
        chapterName: pending.arguments?.name || '',
        targetText: pending.arguments?.targetText || '',
        replacement: pending.arguments?.replacement || '',
        expectedMatchCount: pending.arguments?.expectedMatchCount,
      }
    : null;

  const desc = (t('toolConfirm.desc') || '')
    .replace('{subagent}', pending.subagentId || 'subagent')
    .replace('{tool}', pending.tool || 'tool');

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60"
      role="dialog"
      aria-modal="true"
      onClick={(e) => { if (e.target === e.currentTarget) onReject(); }}
    >
      <div className="w-full max-w-2xl mx-4 bg-vscode-sidebar border border-vscode-panel-border rounded shadow-xl flex flex-col max-h-[85vh]">
        <div className="px-4 py-3 border-b border-vscode-panel-border/60">
          <span className="text-amber-400 font-semibold text-sm">{t('toolConfirm.title')}</span>
        </div>
        <div className="px-4 py-3 overflow-y-auto flex-1">
          <div className="text-sm text-gray-300 mb-3">{desc}</div>
          {replacePreview ? (
            <div className="mb-3 space-y-3">
              <div className="text-xs text-gray-400">章节</div>
              <div className="rounded border border-vscode-panel-border/60 bg-vscode-bg/60 px-2 py-1 text-xs text-gray-200">
                {replacePreview.chapterName || '(未指定章节)'}
              </div>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <div>
                  <div className="mb-1 text-xs text-gray-400">原文片段</div>
                  <pre className="min-h-24 rounded border border-vscode-panel-border/60 bg-vscode-bg/60 p-2 text-xs whitespace-pre-wrap text-rose-200 overflow-auto">{replacePreview.targetText || '(空)'}</pre>
                </div>
                <div>
                  <div className="mb-1 text-xs text-gray-400">替换为</div>
                  <pre className="min-h-24 rounded border border-vscode-panel-border/60 bg-vscode-bg/60 p-2 text-xs whitespace-pre-wrap text-emerald-200 overflow-auto">{replacePreview.replacement || '(空)'}</pre>
                </div>
              </div>
              <div className="text-[11px] text-gray-500">
                预期命中次数: {replacePreview.expectedMatchCount ?? 1}
              </div>
            </div>
          ) : null}
          <div className="text-xs text-gray-400 mb-1">{t('toolConfirm.arguments')}</div>
          <pre className="bg-vscode-bg/60 border border-vscode-panel-border/60 rounded p-2 text-xs overflow-auto max-h-60 whitespace-pre-wrap text-gray-200">
{JSON.stringify(pending.arguments, null, 2)}
          </pre>
          <div className="mt-3">
            <label className="block text-xs text-gray-400 mb-1">{t('toolConfirm.patch')}</label>
            <textarea
              rows={3}
              value={patchText}
              onChange={(e) => { setPatchText(e.target.value); setPatchError(''); }}
              className="w-full bg-vscode-bg/60 border border-vscode-panel-border/60 rounded p-2 text-xs font-mono text-gray-200 outline-none focus:border-blue-500"
              placeholder='{"key": "value"}'
            />
            {patchError && <div className="text-xs text-red-400 mt-1">{patchError}</div>}
          </div>
        </div>
        <div className="px-4 py-3 border-t border-vscode-panel-border/60 flex justify-end gap-2">
          <button
            type="button"
            onClick={onReject}
            className="px-3 py-1.5 text-xs rounded bg-vscode-bg/60 hover:bg-vscode-active-item border border-vscode-panel-border/60 text-gray-200"
          >
            {t('toolConfirm.reject')}
          </button>
          <button
            type="button"
            onClick={onAccept}
            className="px-3 py-1.5 text-xs rounded bg-blue-600 hover:bg-blue-500 text-white"
          >
            {t('toolConfirm.accept')}
          </button>
        </div>
      </div>
    </div>
  );
}
