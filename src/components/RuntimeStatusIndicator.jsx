import React, { useCallback, useEffect, useState } from 'react';
import { useI18n } from '@/i18n/LanguageContext.jsx';

/**
 * Tiny chip in the status bar showing the active runtime driver.
 *
 * Subscribes to the `runtime:changed` event so the label updates live when the
 * user switches drivers in settings. Optional `onOpenSettings` prop lets the
 * status bar pass a click handler that opens the settings panel.
 */
export function RuntimeStatusIndicator({ onOpenSettings }) {
  const { t } = useI18n();
  const mana = typeof window !== 'undefined' ? window.mana : null;
  const [activeId, setActiveId] = useState(null);
  const [displayName, setDisplayName] = useState('');
  const [available, setAvailable] = useState(true);

  const refresh = useCallback(async () => {
    if (!mana?.runtime) return;
    try {
      const [id, list] = await Promise.all([
        mana.runtime.getActiveDriver(),
        mana.runtime.listDrivers(),
      ]);
      setActiveId(id);
      const match = (list || []).find((d) => d.id === id);
      setDisplayName(match?.displayName || id || '');
      setAvailable(match?.availability?.available !== false);
    } catch {
      // best-effort; status bar should never crash the app
    }
  }, [mana]);

  useEffect(() => {
    refresh();
    if (!mana?.runtime?.on) return undefined;
    const off = mana.runtime.on('runtime:changed', () => refresh());
    return () => { try { off(); } catch { /* ignore */ } };
  }, [mana, refresh]);

  if (!activeId) return null;

  const dotClass = available ? 'bg-green-500' : 'bg-amber-500';
  const tip = available ? t('runtime.statusReady') : t('runtime.statusUnavailable');

  const inner = (
    <span className="inline-flex items-center gap-1.5">
      <span className={`inline-block w-2 h-2 rounded-full ${dotClass}`} />
      <span className="text-white whitespace-nowrap">{displayName}</span>
    </span>
  );

  if (onOpenSettings) {
    return (
      <button
        type="button"
        className="cursor-pointer hover:text-gray-100"
        onClick={onOpenSettings}
        title={tip}
      >
        {inner}
      </button>
    );
  }

  return (
    <span title={tip} className="text-gray-300">
      {inner}
    </span>
  );
}
