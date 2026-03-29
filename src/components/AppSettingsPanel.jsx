import React, { useCallback, useMemo, useState } from 'react';
import { AgentApiSettings } from '@/components/AgentApiSettings.jsx';
import { useI18n } from '@/i18n/LanguageContext.jsx';
import { Button, Accordion, AccordionItem } from '@heroui/react';
import {
  SUPPORTED_LANGUAGES,
  getLanguageByCode,
  resolveLanguage,
} from '@/services/languageSettings.js';

export function AppSettingsPanel() {
  const { preference, setPreference, savePreference, t } = useI18n();
  const initialPreference = useMemo(() => preference, [preference]);
  const [languagePreference, setLanguagePreference] = useState(initialPreference);
  const [savedFlash, setSavedFlash] = useState(false);

  const effectiveLanguage = resolveLanguage(languagePreference);
  const effectiveLabel =
    getLanguageByCode(effectiveLanguage)?.label || effectiveLanguage;

  const onSaveLanguage = useCallback(() => {
    savePreference(languagePreference);
    setPreference(languagePreference);
    setSavedFlash(true);
    setTimeout(() => setSavedFlash(false), 1500);
  }, [languagePreference, savePreference, setPreference]);

  return (
    <div className="space-y-3">
      <Accordion defaultExpandedKeys={['1']} variant="bordered" className="bg-vscode-sidebar/30">
        <AccordionItem
          key="1"
          aria-label="Language Settings"
          title={<span className="text-xs font-bold text-gray-400 uppercase tracking-wide">{t('settings.languageTitle')}</span>}
        >
          <div className="pb-3 text-xs">
            <p className="text-gray-500 mt-2 mb-2">
              {t('settings.languageDesc')}
            </p>
            <div className="grid grid-cols-1 gap-4">
              <label className="flex flex-col gap-1 text-xs">
                <span className="text-gray-500">{t('settings.uiLanguage')}</span>
                <select
                  className="bg-vscode-sidebar border border-vscode-panel-border rounded px-2 py-2"
                  value={languagePreference}
                  onChange={(e) => setLanguagePreference(e.target.value)}
                >
                  <option value="system">{t('settings.followSystem')}</option>
                  {SUPPORTED_LANGUAGES.map((l) => (
                    <option key={l.code} value={l.code}>
                      {l.label}
                    </option>
                  ))}
                </select>
              </label>
              <div className="text-gray-500">
                {t('settings.effectiveLanguage')}:{' '}
                <span className="text-gray-300">{effectiveLabel}</span>
              </div>
              <div>
                <Button
                  color="primary"
                  size="sm"
                  onPress={onSaveLanguage}
                >
                  {savedFlash ? t('settings.saved') : t('settings.saveLanguage')}
                </Button>
              </div>
            </div>
          </div>
        </AccordionItem>
        <AccordionItem
          key="2"
          aria-label="LLM Settings"
          title={<span className="text-xs font-bold text-gray-400 uppercase tracking-wide">{t('settings.llmTitle')}</span>}
        >
          <div className="pb-3">
            <AgentApiSettings />
          </div>
        </AccordionItem>
      </Accordion>
    </div>
  );
}
