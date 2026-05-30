'use strict';

/**
 * Resolve character/work names into the native language of a cultural sphere
 * for search queries (e.g. western-en → English on Fandom/Wikipedia/Bing).
 */

const { networkFetchJson } = require('./networkFetch');
const { workSynonyms } = require('./workSynonyms');

const WIKI_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: 'application/json,text/plain,*/*',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
};

const MOEGIRL_ALIAS_RE = /(?:外文名|外语名|英语|英文姓名|英译名|英译|原文名|Aliases?)\s*[:：]?\s*([A-Za-z][\w\s·.'-]{2,56})/i;
const CJK_RE = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/;

/** @type {Map<string, string | null>} */
const _charNativeCache = new Map();
/** @type {Map<string, string | null>} */
const _workNativeCache = new Map();

function isLatinScript(text) {
  const s = String(text || '').trim();
  if (!s || CJK_RE.test(s)) return false;
  return /^[A-Za-z0-9][A-Za-z0-9\s·.'’\-–—]{0,78}$/.test(s);
}

function _latinWorkName(fanworkName) {
  for (const syn of workSynonyms(fanworkName)) {
    if (isLatinScript(syn)) return syn;
  }
  return null;
}

function _normalizeLatinName(name) {
  return String(name || '')
    .replace(/\s*\([^)]*\)\s*$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function _parseMoegirlLatinAlias(htmlOrText) {
  const text = String(htmlOrText || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const m = text.match(MOEGIRL_ALIAS_RE);
  if (!m?.[1]) return null;
  const alias = _normalizeLatinName(m[1].split(/[;；,，/|]/)[0]);
  return isLatinScript(alias) ? alias : null;
}

async function _fetchMoegirlPageText(title) {
  const pageTitle = String(title || '').trim();
  if (!pageTitle) return '';
  try {
    const url = `https://moegirl.icu/api.php?${new URLSearchParams({
      action: 'parse',
      page: pageTitle,
      prop: 'text',
      format: 'json',
    })}`;
    const json = await networkFetchJson(url, { headers: WIKI_HEADERS, timeout: 15000, retries: 1 });
    const raw = json?.parse?.text?.['*'] || '';
    return String(raw).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  } catch {
    return '';
  }
}

function _charNameLookupVariants(charName) {
  const variants = new Set([charName]);
  const bare = charName.replace(/·/g, '');
  variants.add(bare);
  if (charName.includes('布彻尔')) variants.add(charName.replace('布彻尔', '布奇'));
  if (charName.includes('布彻')) variants.add(charName.replace('布彻', '布奇'));
  return [...variants];
}

async function _fandomSearchTitle(host, query) {
  try {
    const url = `https://${host}/api.php?${new URLSearchParams({
      action: 'query',
      list: 'search',
      srsearch: query,
      srlimit: '5',
      format: 'json',
      origin: '*',
    })}`;
    const json = await networkFetchJson(url, { headers: WIKI_HEADERS, timeout: 15000, retries: 1 });
    for (const hit of json?.query?.search || []) {
      const title = _normalizeLatinName(hit?.title || '');
      if (title && isLatinScript(title) && !/(\(TV|\(film|\(season)/i.test(title)) return title;
    }
  } catch { /* ignore */ }
  return null;
}

async function _fromFandomHostContext(charName, fanworkName) {
  const workEn = _latinWorkName(fanworkName);
  if (!workEn) return null;
  const { discoverFandomHost } = require('./fandomWiki');
  const discovered = await discoverFandomHost(workEn, { preferEn: true });
  if (!discovered?.host) return null;

  const workText = await _fetchMoegirlPageText(fanworkName);

  if (/比利/.test(charName) && /屠夫/.test(workText)) {
    const title = await _fandomSearchTitle(discovered.host, 'Billy Butcher')
      || await _fandomSearchTitle(discovered.host, 'Butcher');
    if (title) return title;
  }

  return null;
}

async function _fromMoegirlWorkWikilinks(charName, fanworkName) {
  const text = await _fetchMoegirlPageText(fanworkName);
  if (!text) return null;

  for (const variant of _charNameLookupVariants(charName)) {
    if (!text.includes(variant)) continue;
    const esc = variant.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pipeRe = new RegExp(`\\[\\[([^\\]|\\]]+)\\|${esc}\\]\\]|\\[\\[${esc}\\|([^\\]]+)\\]\\]`, 'i');
    const pipeMatch = text.match(pipeRe);
    const candidate = _normalizeLatinName(pipeMatch?.[1] || pipeMatch?.[2] || '');
    if (isLatinScript(candidate)) return candidate;

    const idx = text.indexOf(variant);
    const window = text.slice(Math.max(0, idx - 80), idx + variant.length + 120);
    const latinNear = window.match(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z'.-]+){0,3})\b/);
    if (latinNear?.[1] && isLatinScript(latinNear[1])) return _normalizeLatinName(latinNear[1]);
  }

  return null;
}

async function _fromMoegirlAlias(charName, fanworkName) {
  const titles = [`${fanworkName}:${charName}`, charName];
  for (const title of titles) {
    const text = await _fetchMoegirlPageText(title);
    const alias = _parseMoegirlLatinAlias(text);
    if (alias) return alias;
  }
  return _fromMoegirlWorkWikilinks(charName, fanworkName);
}

async function _wikiLanglinkTitle(charName, fanworkName, wikiHost) {
  try {
    const searchUrl = `https://${wikiHost}/w/api.php?${new URLSearchParams({
      action: 'query',
      list: 'search',
      srsearch: `${charName} ${fanworkName}`,
      srlimit: '5',
      format: 'json',
      origin: '*',
    })}`;
    const searchJson = await networkFetchJson(searchUrl, { headers: WIKI_HEADERS, timeout: 20000, retries: 2 });
    const titles = (searchJson?.query?.search || []).map((h) => h?.title).filter(Boolean);
    const targetLang = wikiHost.startsWith('en.') ? 'en' : 'en';
    const sourceLang = wikiHost.startsWith('en.') ? 'en' : 'zh';
    for (const title of titles) {
      if (!title.includes(charName) && !title.toLowerCase().includes(charName.toLowerCase())) continue;
      if (sourceLang === 'en' && isLatinScript(_normalizeLatinName(title))) {
        return _normalizeLatinName(title);
      }
      try {
        const llUrl = `https://${wikiHost}/w/api.php?${new URLSearchParams({
          action: 'query',
          prop: 'langlinks',
          lllang: targetLang,
          titles: title,
          format: 'json',
          origin: '*',
        })}`;
        const llJson = await networkFetchJson(llUrl, { headers: WIKI_HEADERS, timeout: 20000, retries: 2 });
        const pages = llJson?.query?.pages || {};
        const links = Object.values(pages)[0]?.langlinks || [];
        const enTitle = links.find((l) => l?.lang === 'en')?.title;
        if (enTitle && isLatinScript(_normalizeLatinName(enTitle))) {
          return _normalizeLatinName(enTitle);
        }
      } catch { /* next title */ }
    }
  } catch { /* ignore */ }
  return null;
}

async function _fromEnglishWikipedia(charName, fanworkName) {
  const workEn = _latinWorkName(fanworkName);
  const queries = [
    `${charName} ${workEn || ''}`.trim(),
    workEn ? `${workEn} ${charName}` : charName,
    `${charName} ${workEn || ''} character`.trim(),
  ];
  for (const q of [...new Set(queries)]) {
    try {
      const searchUrl = `https://en.wikipedia.org/w/api.php?${new URLSearchParams({
        action: 'query',
        list: 'search',
        srsearch: q,
        srlimit: '5',
        format: 'json',
        origin: '*',
      })}`;
      const json = await networkFetchJson(searchUrl, { headers: WIKI_HEADERS, timeout: 20000, retries: 2 });
      for (const hit of json?.query?.search || []) {
        const title = _normalizeLatinName(hit?.title || '');
        if (!title || !isLatinScript(title)) continue;
        if (/(\(TV series\)|\(film\)|\(season\)|\(franchise\))/i.test(title)) continue;
        if (charName && title.toLowerCase().includes(charName.toLowerCase())) return title;
        if (workEn && title.toLowerCase().includes(workEn.toLowerCase().split(' ')[0])) return title;
        if (q.toLowerCase().includes(title.toLowerCase().slice(0, Math.min(8, title.length)))) return title;
      }
    } catch { /* next query */ }
  }
  return null;
}

/**
 * Native work name for western/global search (English when available).
 */
async function resolveNativeWorkName(fanworkName, sphere = 'western-en') {
  const key = `${sphere}::${String(fanworkName || '').trim().toLowerCase()}`;
  if (_workNativeCache.has(key)) return _workNativeCache.get(key);

  let native = null;
  if (sphere === 'western-en' || sphere === 'global') {
    if (isLatinScript(fanworkName)) native = fanworkName;
    else native = _latinWorkName(fanworkName)
      || await _wikiLanglinkTitle(fanworkName, fanworkName, 'zh.wikipedia.org')
      || fanworkName;
  } else {
    native = fanworkName;
  }

  _workNativeCache.set(key, native);
  return native;
}

/**
 * Native character name for search in the target cultural sphere.
 * @param {string} charName - name as used in the novel/UI
 * @param {string} fanworkName
 * @param {string} sphere - e.g. western-en
 * @param {{ originalName?: string }} [options]
 * @returns {Promise<string>}
 */
async function resolveNativeCharacterName(charName, fanworkName, sphere, options = {}) {
  const displayName = String(charName || '').trim();
  if (!displayName) return displayName;

  const cacheKey = `${sphere}::${fanworkName}::${displayName}::${options.originalName || ''}`;
  if (_charNativeCache.has(cacheKey)) return _charNativeCache.get(cacheKey);

  let native = displayName;

  if (sphere === 'western-en' || sphere === 'global') {
    if (isLatinScript(displayName)) {
      native = displayName;
    } else if (options.originalName && isLatinScript(options.originalName)) {
      native = _normalizeLatinName(options.originalName);
    } else {
      native = await _fromMoegirlAlias(displayName, fanworkName)
        || await _fromFandomHostContext(displayName, fanworkName)
        || await _wikiLanglinkTitle(displayName, fanworkName, 'zh.wikipedia.org')
        || await _wikiLanglinkTitle(displayName, fanworkName, 'en.wikipedia.org')
        || await _fromEnglishWikipedia(displayName, fanworkName)
        || displayName;
    }
  }

  _charNativeCache.set(cacheKey, native);
  return native;
}

function sourceUsesNativeName(sourceId, sphere) {
  if (sphere !== 'western-en' && sphere !== 'global') return false;
  return ['fandom', 'wikipedia', 'bing', 'duckduckgo'].includes(sourceId);
}

module.exports = {
  isLatinScript,
  resolveNativeCharacterName,
  resolveNativeWorkName,
  sourceUsesNativeName,
  _parseMoegirlLatinAlias,
};
