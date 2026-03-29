import React, { useCallback, useMemo, useState } from 'react';
import { useI18n } from '@/i18n/LanguageContext.jsx';
import { Button, Input, Checkbox } from '@heroui/react';
import {
  AGENT_ENDPOINT_KEYS,
  AGENT_ENDPOINT_LABELS,
  applyPresetToAgent,
  loadAgentApiConfig,
  saveAgentApiConfig,
} from '@/services/agentApiConfig.js';
import { PROVIDER_PRESETS } from '@/services/aiProviders.js';

export function AgentApiSettings() {
  const { t } = useI18n();
  const initial = useMemo(() => loadAgentApiConfig(), []);
  const [config, setConfig] = useState(initial);
  const [savedFlash, setSavedFlash] = useState(false);

  const updateAgent = useCallback((key, patch) => {
    setConfig((c) => ({
      ...c,
      [key]: { ...c[key], ...patch },
    }));
  }, []);

  const onProviderChange = useCallback((key, providerId) => {
    setConfig((c) => ({
      ...c,
      [key]: applyPresetToAgent(c[key], providerId),
    }));
  }, []);

  const save = useCallback(() => {
    saveAgentApiConfig(config);
    setSavedFlash(true);
    setTimeout(() => setSavedFlash(false), 1500);
  }, [config]);

  return (
    <section className="pt-1">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
        <div>
          <div className="font-bold text-sm">{t('settings.apiTitle')}</div>
          <p className="text-xs text-gray-500 mt-1">
            {t('settings.apiDesc')}
          </p>
        </div>
        <Button
          color="primary"
          size="sm"
          onPress={save}
        >
          {savedFlash ? t('settings.saved') : t('settings.saveAll')}
        </Button>
      </div>

      <div className="space-y-4 max-h-[min(70vh,520px)] overflow-y-auto pr-2">
        {AGENT_ENDPOINT_KEYS.map((key) => {
          const row = config[key];
          if (!row) return null;
          const label = AGENT_ENDPOINT_LABELS[key] ?? key;
          return (
            <div
              key={key}
              className="border border-vscode-panel-border/80 rounded p-4 bg-vscode-editor-bg/50"
            >
              <div className="text-xs font-semibold text-gray-300 mb-3">{label}</div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <label className="flex flex-col gap-1 text-xs">
                  <span className="text-gray-500">{t('settings.providerPreset')}</span>
                  <select
                    className="bg-vscode-sidebar border border-vscode-panel-border rounded px-2 py-2"
                    value={row.providerId}
                    onChange={(e) => onProviderChange(key, e.target.value)}
                  >
                    {PROVIDER_PRESETS.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                </label>
                <Input
                  label={t('settings.modelId')}
                  size="sm"
                  value={row.model}
                  onValueChange={(val) => updateAgent(key, { model: val })}
                />
                <div className="sm:col-span-2">
                  <Input
                    label={t('settings.baseUrl')}
                    size="sm"
                    className="font-mono"
                    value={row.baseUrl}
                    onValueChange={(val) => updateAgent(key, { baseUrl: val })}
                    placeholder="https://api.openai.com/v1"
                  />
                </div>
                <div className="sm:col-span-2">
                  <Input
                    type="password"
                    label={t('settings.apiKey')}
                    size="sm"
                    className="font-mono"
                    value={row.apiKey}
                    onValueChange={(val) => updateAgent(key, { apiKey: val })}
                    placeholder="sk-… 或各厂商密钥"
                  />
                </div>
                <div className="sm:col-span-2 flex items-center">
                  <Checkbox
                    isSelected={row.useMock}
                    onValueChange={(checked) => updateAgent(key, { useMock: checked })}
                    size="sm"
                  >
                    <span className="text-gray-400 text-xs">{t('settings.useMock')}</span>
                  </Checkbox>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
