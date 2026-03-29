const STORAGE_KEY = 'mana-language-settings-v1';

export const SUPPORTED_LANGUAGES = [
  { code: 'zh-CN', label: '简体中文' },
  { code: 'en-US', label: 'English' },
  { code: 'ru-RU', label: 'Русский' },
  { code: 'de-DE', label: 'Deutsch' },
  { code: 'ja-JP', label: '日本語' },
  { code: 'ko-KR', label: '한국어' },
];

function normalizeSystemLanguage(raw) {
  const lower = String(raw || '').toLowerCase();
  if (lower.startsWith('zh')) return 'zh-CN';
  if (lower.startsWith('en')) return 'en-US';
  if (lower.startsWith('ru')) return 'ru-RU';
  if (lower.startsWith('de')) return 'de-DE';
  if (lower.startsWith('ja')) return 'ja-JP';
  if (lower.startsWith('ko')) return 'ko-KR';
  return 'en-US';
}

export function detectSystemLanguage() {
  try {
    if (typeof navigator === 'undefined') return 'en-US';
    return normalizeSystemLanguage(navigator.language);
  } catch {
    return 'en-US';
  }
}

export function getLanguageByCode(code) {
  return SUPPORTED_LANGUAGES.find((l) => l.code === code);
}

export function loadLanguagePreference() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return 'system';
    const parsed = JSON.parse(raw);
    const pref = parsed?.preference;
    if (pref === 'system') return 'system';
    if (getLanguageByCode(pref)) return pref;
    return 'system';
  } catch {
    return 'system';
  }
}

export function saveLanguagePreference(preference) {
  const value = preference === 'system' ? 'system' : getLanguageByCode(preference)?.code;
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      preference: value || 'system',
    })
  );
}

export function resolveLanguage(preference) {
  if (preference === 'system') return detectSystemLanguage();
  return getLanguageByCode(preference)?.code || detectSystemLanguage();
}
