import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { messages } from '@/i18n/messages.js';
import {
  loadLanguagePreference,
  resolveLanguage,
  saveLanguagePreference,
} from '@/services/languageSettings.js';

const LanguageContext = createContext(null);

function getByPath(obj, path) {
  return String(path || '')
    .split('.')
    .reduce((acc, key) => (acc && acc[key] !== undefined ? acc[key] : undefined), obj);
}

export function LanguageProvider({ children }) {
  const [preference, setPreference] = useState(() => loadLanguagePreference());
  const effectiveLanguage = resolveLanguage(preference);

  const t = useCallback(
    (key) => {
      const current = messages[effectiveLanguage] || messages['en-US'];
      const fallback = messages['en-US'];
      return getByPath(current, key) ?? getByPath(fallback, key) ?? key;
    },
    [effectiveLanguage]
  );

  const savePreference = useCallback((next) => {
    saveLanguagePreference(next);
  }, []);

  const value = useMemo(
    () => ({
      preference,
      setPreference,
      savePreference,
      effectiveLanguage,
      t,
    }),
    [effectiveLanguage, preference, savePreference, t]
  );

  return (
    <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>
  );
}

export function useI18n() {
  const ctx = useContext(LanguageContext);
  if (!ctx) {
    throw new Error('useI18n must be used within LanguageProvider');
  }
  return ctx;
}

