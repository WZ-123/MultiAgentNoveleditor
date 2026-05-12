import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Input, Chip } from '@heroui/react';
import { useI18n } from '@/i18n/LanguageContext.jsx';

const DRIVER_BIN_FIELDS = {
  'claude-code-vscode': true,
  'claude-code-cli': true,
  codex: true,
  'direct-api': false,
};

function CapabilityChips({ caps, t }) {
  if (!caps) return null;
  const items = [];
  if (caps.supportsSubagents) items.push(t('runtime.capSubagents'));
  if (caps.supportsPerSubagentModel) items.push(t('runtime.capPerSubagentModel'));
  if (caps.supportsMcp) items.push(t('runtime.capMcp'));
  if (caps.supportsStreamingTokens) items.push(t('runtime.capStreaming'));
  if (caps.supportsHumanInLoop) items.push(t('runtime.capHumanLoop'));
  if (caps.supportsToolConfirmation) items.push(t('runtime.capToolConfirm'));
  if (caps.workflowExecution) items.push(`${t('runtime.capWorkflow')}:${caps.workflowExecution}`);
  return (
    <div className="flex flex-wrap gap-1 mt-1">
      {items.map((label) => (
        <Chip key={label} size="sm" variant="flat" className="text-[10px] h-5">
          {label}
        </Chip>
      ))}
    </div>
  );
}

export function RuntimeDriverSettings() {
  const { t } = useI18n();
  const mana = typeof window !== 'undefined' ? window.mana : null;

  const [drivers, setDrivers] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [appConfig, setAppConfig] = useState(null);
  const [draftBinPaths, setDraftBinPaths] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [savedFlash, setSavedFlash] = useState({});
  const [detectFlash, setDetectFlash] = useState({});

  const refresh = useCallback(async () => {
    if (!mana?.runtime || !mana?.config) {
      setError(t('runtime.bridgeMissing'));
      return;
    }
    setError('');
    try {
      const [list, active, cfg] = await Promise.all([
        mana.runtime.listDrivers(),
        mana.runtime.getActiveDriver(),
        mana.config.getApp(),
      ]);
      setDrivers(list || []);
      setActiveId(active);
      setAppConfig(cfg);
      const draft = {};
      for (const d of list || []) {
        const driverCfg = cfg?.drivers?.[d.id] || {};
        draft[d.id] = driverCfg.binPath || '';
      }
      setDraftBinPaths(draft);
    } catch (err) {
      setError(err.message || String(err));
    }
  }, [mana, t]);

  useEffect(() => {
    refresh();
    if (!mana?.runtime?.on) return undefined;
    const off = mana.runtime.on('runtime:changed', () => refresh());
    return () => { try { off(); } catch { /* ignore */ } };
  }, [mana, refresh]);

  const onSelectDriver = useCallback(async (id) => {
    if (!mana?.runtime || id === activeId) return;
    setBusy(true);
    try {
      await mana.runtime.setActiveDriver(id);
      setActiveId(id);
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setBusy(false);
    }
  }, [mana, activeId]);

  const onSaveBinPath = useCallback(async (id) => {
    if (!mana?.config) return;
    setBusy(true);
    try {
      const driverPatch = {
        ...(appConfig?.drivers?.[id] || {}),
        binPath: draftBinPaths[id] || '',
      };
      const next = await mana.config.setApp({
        drivers: { [id]: driverPatch },
      });
      setAppConfig(next);
      setSavedFlash((prev) => ({ ...prev, [id]: true }));
      setTimeout(() => setSavedFlash((prev) => ({ ...prev, [id]: false })), 1500);
      await refresh();
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setBusy(false);
    }
  }, [mana, draftBinPaths, appConfig, refresh]);

  const onTestAvailability = useCallback(async (id) => {
    if (!mana?.runtime) return;
    setBusy(true);
    try {
      await mana.runtime.driverAvailability(id);
      await refresh();
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setBusy(false);
    }
  }, [mana, refresh]);

  const onAutoDetect = useCallback(async (id) => {
    if (!mana?.runtime?.autoDetectDriverBinPath) return;
    setBusy(true);
    try {
      const r = await mana.runtime.autoDetectDriverBinPath(id);
      if (r?.detected && r.path) {
        setDraftBinPaths((prev) => ({ ...prev, [id]: r.path }));
        setDetectFlash((prev) => ({ ...prev, [id]: { ok: true, path: r.path } }));
      } else {
        setDetectFlash((prev) => ({ ...prev, [id]: { ok: false, reason: r?.reason || '' } }));
      }
      setTimeout(() => setDetectFlash((prev) => ({ ...prev, [id]: null })), 4000);
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setBusy(false);
    }
  }, [mana]);

  const driverList = useMemo(() => drivers, [drivers]);

  return (
    <div className="text-xs space-y-3">
      <p className="text-gray-500">{t('runtime.description')}</p>
      {error ? <div className="text-red-400 text-xs">{error}</div> : null}
      <ul className="space-y-2">
        {driverList.map((d) => {
          const isActive = d.id === activeId;
          const av = d.availability || { available: false };
          const showBin = DRIVER_BIN_FIELDS[d.id];
          return (
            <li
              key={d.id}
              className={`border rounded p-3 ${isActive ? 'border-primary-500 bg-primary-500/5' : 'border-vscode-panel-border'}`}
            >
              <div className="flex items-start gap-3">
                <input
                  type="radio"
                  name="active-driver"
                  className="mt-1 accent-primary-500"
                  checked={isActive}
                  disabled={busy || !av.available}
                  onChange={() => onSelectDriver(d.id)}
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-semibold text-gray-200">{d.displayName}</span>
                    <Chip
                      size="sm"
                      color={av.available ? 'success' : 'default'}
                      variant="flat"
                      className="text-[10px] h-5"
                    >
                      {av.available ? t('runtime.available') : t('runtime.unavailable')}
                    </Chip>
                    {av.version ? (
                      <span className="text-[10px] text-gray-500">v{av.version}</span>
                    ) : null}
                    {isActive ? (
                      <Chip size="sm" color="primary" variant="flat" className="text-[10px] h-5">
                        {t('runtime.activeBadge')}
                      </Chip>
                    ) : null}
                  </div>
                  {d.description ? (
                    <div className="text-[11px] text-gray-500 mt-1">{d.description}</div>
                  ) : null}
                  {!av.available && av.reason ? (
                    <div className="text-[11px] text-amber-500 mt-1">{av.reason}</div>
                  ) : null}
                  <CapabilityChips caps={d.capabilities} t={t} />
                  {showBin ? (
                    <>
                      <div className="flex flex-wrap items-end gap-2 mt-3">
                        <div className="flex-1 min-w-[180px]">
                          <label className="text-[11px] text-gray-500">{t('runtime.binPath')}</label>
                          <Input
                            size="sm"
                            variant="bordered"
                            placeholder={t('runtime.binPathPlaceholder')}
                            value={draftBinPaths[d.id] || ''}
                            onChange={(e) =>
                              setDraftBinPaths((prev) => ({ ...prev, [d.id]: e.target.value }))
                            }
                          />
                        </div>
                        <Button
                          size="sm"
                          variant="flat"
                          isDisabled={busy}
                          onPress={() => onAutoDetect(d.id)}
                        >
                          {t('runtime.autoDetect')}
                        </Button>
                        <Button
                          size="sm"
                          color="primary"
                          variant="flat"
                          isDisabled={busy}
                          onPress={() => onSaveBinPath(d.id)}
                        >
                          {savedFlash[d.id] ? t('runtime.saved') : t('runtime.savePath')}
                        </Button>
                        <Button
                          size="sm"
                          variant="flat"
                          isDisabled={busy}
                          onPress={() => onTestAvailability(d.id)}
                        >
                          {t('runtime.testConnection')}
                        </Button>
                      </div>
                      {detectFlash[d.id] ? (
                        <div className={`text-[11px] mt-1 ${detectFlash[d.id].ok ? 'text-emerald-400' : 'text-amber-500'}`}>
                          {detectFlash[d.id].ok
                            ? `${t('runtime.detected')}: ${detectFlash[d.id].path}`
                            : `${t('runtime.noPathFound')}${detectFlash[d.id].reason ? ` — ${detectFlash[d.id].reason}` : ''}`}
                        </div>
                      ) : null}
                    </>
                  ) : null}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
