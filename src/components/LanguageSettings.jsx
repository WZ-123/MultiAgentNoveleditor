import React, { useCallback, useMemo, useState } from 'react';
import { Button } from '@heroui/react';
import { useI18n } from '@/i18n/LanguageContext.jsx';
import {
  SUPPORTED_LANGUAGES,
  getLanguageByCode,
  resolveLanguage,
} from '@/services/languageSettings.js';

export function LanguageSettings() {
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
    <div className="text-xs space-y-3 max-w-xl">
      <p className="text-gray-500">{t('settings.languageDesc')}</p>
      <label className="flex flex-col gap-1">
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
        <Button color="primary" size="sm" onPress={onSaveLanguage}>
          {savedFlash ? t('settings.saved') : t('settings.saveLanguage')}
        </Button>
      </div>
    </div>
  );
}
