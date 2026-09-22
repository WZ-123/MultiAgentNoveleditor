import React, { useCallback, useEffect, useState } from 'react';

export function RuntimeStatusIndicator({ onOpenSettings }) {
  const mana = typeof window !== 'undefined' ? window.mana : null;
  const [status, setStatus] = useState(null);
  const refresh = useCallback(async () => {
    try { setStatus(await mana?.codex?.status?.()); }
    catch (error) { setStatus({ ready: false, message: error?.message || String(error) }); }
  }, [mana]);
  useEffect(() => {
    refresh();
    const off = mana?.codex?.onEvent?.((event) => {
      if (event?.type === 'turn_started' || event?.type === 'turn_completed' || event?.type === 'turn_failed' || event?.type === 'turn_interrupted') refresh();
    });
    const offModel = mana?.modelConfig?.onChanged?.(() => refresh());
    return () => { off?.(); offModel?.(); };
  }, [mana, refresh]);
  if (!status) return null;
  const label = status.ready ? `${status.connectionName || status.connectionId} · ${status.modelId}${status.toolStatus === 'failed' ? ' · 仅聊天' : ''}` : 'Responses 未配置';
  const content = <span className="inline-flex items-center gap-1.5"><span className={`inline-block h-2 w-2 rounded-full ${status.ready ? 'bg-green-500' : 'bg-amber-500'}`} /><span className="whitespace-nowrap text-white">{label}</span></span>;
  if (!onOpenSettings) return <span title={status.message || label}>{content}</span>;
  return <button type="button" onClick={onOpenSettings} title={status.message || label}>{content}</button>;
}
