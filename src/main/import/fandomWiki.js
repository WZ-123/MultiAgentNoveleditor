'use strict';

/**
 * Generic Fandom wiki discovery, search, and page fetch.
 * No per-franchise slug table — discovers *.fandom.com host via site-restricted search.
 */

const { networkFetch, networkFetchJson } = require('./networkFetch');
const { workSynonyms } = require('./workSynonyms');

const FETCH_TIMEOUT_MS = { search: 12000, parse: 15000, discover: 12000 };

const WIKI_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: 'application/json,text/plain,*/*',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
};

/** @type {Map<string, { host: string, langs: string[] } | null>} */
const _hostCache = new Map();
/** @type {Map<string, string | null>} */
const _enWorkHintCache = new Map();
/** @type {Map<string, string | null>} */
const _enCharHintCache = new Map();

function _compactName(name) {
  return String(name || '').replace(/[·・.\s_]/g, '').toLowerCase();
}

function _charNameInTitle(charName, title) {
  const core = _compactName(charName);
  if (!core) return false;
  const segCore = _compactName(title);
  if (segCore === core) return true;
  if (String(title || '').includes(charName)) return true;
  if (segCore.includes(core) && core.length >= 2) return true;
  return false;
}

function _wikiPath(lang) {
  return lang === 'en' ? 'wiki' : `${lang}/wiki`;
}

function _buildPageUrl(host, lang, title) {
  const slug = encodeURIComponent(String(title || '').trim().replace(/ /g, '_'));
  return `https://${host}/${_wikiPath(lang)}/${slug}`;
}

async function _englishWorkHintFromWikipedia(fanworkName) {
  const key = String(fanworkName || '').trim().toLowerCase();
  if (!key) return null;
  if (_enWorkHintCache.has(key)) return _enWorkHintCache.get(key);

  let hint = null;
  try {
    const searchUrl = `https://zh.wikipedia.org/w/api.php?${new URLSearchParams({
      action: 'query',
      list: 'search',
      srsearch: fanworkName,
      srlimit: '3',
      format: 'json',
      origin: '*',
    })}`;
    const searchJson = await networkFetchJson(searchUrl, { headers: WIKI_HEADERS, timeout: 20000, retries: 2 });
    const titles = (searchJson?.query?.search || []).map((h) => h?.title).filter(Boolean);
    for (const zhTitle of titles) {
      try {
        const llUrl = `https://zh.wikipedia.org/w/api.php?${new URLSearchParams({
          action: 'query',
          prop: 'langlinks',
          lllang: 'en',
          titles: zhTitle,
          format: 'json',
          origin: '*',
        })}`;
        const llJson = await networkFetchJson(llUrl, { headers: WIKI_HEADERS, timeout: 20000, retries: 2 });
        const pages = llJson?.query?.pages || {};
        const links = Object.values(pages)[0]?.langlinks || [];
        const enTitle = links.find((l) => l?.lang === 'en')?.title;
        if (enTitle) {
          hint = enTitle.replace(/\s*\([^)]*\)\s*$/, '').trim() || enTitle;
          break;
        }
      } catch { /* try next title */ }
    }
  } catch { /* no hint */ }

  _enWorkHintCache.set(key, hint);
  return hint;
}

async function _englishCharacterHintFromWikipedia(charName, fanworkName) {
  const key = `${String(fanworkName || '').trim().toLowerCase()}::${String(charName || '').trim().toLowerCase()}`;
  if (_enCharHintCache.has(key)) return _enCharHintCache.get(key);

  let hint = null;
  try {
    const searchUrl = `https://zh.wikipedia.org/w/api.php?${new URLSearchParams({
      action: 'query',
      list: 'search',
      srsearch: `${charName} ${fanworkName}`,
      srlimit: '5',
      format: 'json',
      origin: '*',
    })}`;
    const searchJson = await networkFetchJson(searchUrl, { headers: WIKI_HEADERS, timeout: 20000, retries: 2 });
    const titles = (searchJson?.query?.search || []).map((h) => h?.title).filter(Boolean);
    for (const zhTitle of titles) {
      if (!zhTitle.includes(charName) && !_charNameInTitle(charName, zhTitle)) continue;
      try {
        const llUrl = `https://zh.wikipedia.org/w/api.php?${new URLSearchParams({
          action: 'query',
          prop: 'langlinks',
          lllang: 'en',
          titles: zhTitle,
          format: 'json',
          origin: '*',
        })}`;
        const llJson = await networkFetchJson(llUrl, { headers: WIKI_HEADERS, timeout: 20000, retries: 2 });
        const pages = llJson?.query?.pages || {};
        const links = Object.values(pages)[0]?.langlinks || [];
        const enTitle = links.find((l) => l?.lang === 'en')?.title;
        if (enTitle) {
          hint = enTitle.replace(/\s*\([^)]*\)\s*$/, '').trim() || enTitle;
          break;
        }
      } catch { /* try next */ }
    }
  } catch { /* no hint */ }

  _enCharHintCache.set(key, hint);
  return hint;
}

function _discoveryQueries(fanworkName, enHint) {
  const names = [...new Set([fanworkName, enHint, ...workSynonyms(fanworkName)].filter(Boolean))];
  const queries = [];
  for (const name of names) {
    queries.push(
      `"${name}" site:fandom.com`,
      `${name} wiki site:fandom.com`,
      `${name} fandom.com`,
      `${name} fandom wiki`,
    );
  }
  return [...new Set(queries)];
}

function _extractFandomHosts(html) {
  const hosts = new Set();
  const re = /https?:\/\/([a-z0-9-]+)\.fandom\.com/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    if (m[1] && m[1] !== 'www' && m[1] !== 'community') hosts.add(`${m[1]}.fandom.com`);
  }
  return [...hosts];
}

async function _bingHtml(query, preferEn = false) {
  const base = preferEn ? 'https://www.bing.com/search' : 'https://cn.bing.com/search';
  const url = `${base}?q=${encodeURIComponent(query)}${preferEn ? '&setlang=en-US' : ''}`;
  const res = await networkFetch(url, {
    headers: {
      'User-Agent': WIKI_HEADERS['User-Agent'],
      'Accept-Language': preferEn ? 'en-US,en;q=0.9' : 'zh-CN,zh;q=0.9,en;q=0.8',
    },
    timeout: FETCH_TIMEOUT_MS.discover,
  });
  return res.text();
}

/**
 * Discover a franchise Fandom host for a work name (cached).
 * @returns {{ host: string, langs: string[] } | null}
 */
async function discoverFandomHost(fanworkName, { preferEn = false, charName = '', nativeCharName = '' } = {}) {
  const searchChar = nativeCharName || charName;
  const cacheKey = `${String(fanworkName || '').trim().toLowerCase()}::${preferEn ? 'en' : 'zh'}::${String(searchChar || '').trim().toLowerCase()}`;
  if (_hostCache.has(cacheKey)) return _hostCache.get(cacheKey);

  const enHint = preferEn ? await _englishWorkHintFromWikipedia(fanworkName) : null;
  const queries = _discoveryQueries(fanworkName, enHint);
  if (searchChar) {
    queries.unshift(
      `${searchChar} site:fandom.com`,
      `${searchChar} ${enHint || fanworkName} site:fandom.com`,
    );
  }

  const hostCounts = new Map();
  for (const q of queries) {
    try {
      const html = await _bingHtml(q, preferEn);
      for (const h of _extractFandomHosts(html)) {
        hostCounts.set(h, (hostCounts.get(h) || 0) + 1);
      }
    } catch { /* try next query */ }
  }

  const ranked = [...hostCounts.entries()].sort((a, b) => b[1] - a[1]);
  const host = ranked[0]?.[0] || null;
  const result = host ? { host, langs: preferEn ? ['en', 'zh'] : ['zh', 'en'] } : null;
  _hostCache.set(cacheKey, result);
  return result;
}

async function _fandomApi(host, lang, params, timeoutMs = FETCH_TIMEOUT_MS.search) {
  const qs = new URLSearchParams({ ...params, format: 'json', origin: '*' });
  const base = lang === 'en' ? `https://${host}/api.php` : `https://${host}/${lang}/api.php`;
  const url = `${base}?${qs.toString()}`;
  return networkFetchJson(url, {
    headers: { ...WIKI_HEADERS, Referer: `https://${host}/` },
    timeout: timeoutMs,
    retries: 1,
  });
}

async function _searchOnHost(host, searchName, langs) {
  const results = [];
  for (const lang of langs) {
    try {
      const json = await _fandomApi(host, lang, {
        action: 'query',
        list: 'search',
        srsearch: searchName,
        srlimit: '8',
      });
      for (const hit of json?.query?.search || []) {
        const title = hit?.title || '';
        if (!title || /特殊:|模板:|分类:/i.test(title)) continue;
        if (!NON_CHARACTER_FANDOM_TITLE(title) && _charNameInTitle(searchName, title)) {
          results.push({
            title,
            snippet: (hit.snippet || '').replace(/<[^>]+>/g, ''),
            url: _buildPageUrl(host, lang, title),
            source: 'fandom',
            fandomHost: host,
            fandomLang: lang,
          });
        }
      }
      if (results.length) return results;
    } catch { /* try next lang */ }
  }
  return results;
}

function NON_CHARACTER_FANDOM_TITLE(title) {
  return /（电影|（游戏|（剧集|\(film\)|\(movie\)|\(series\)/i.test(String(title || ''));
}

async function _bingSiteWikiPages(host, searchName, fanworkName, preferEn) {
  const queries = [
    `${searchName} site:${host}`,
    `${searchName} ${fanworkName} site:${host}`,
    `"${searchName}" site:${host}`,
  ];
  const pages = [];
  const hostEsc = host.replace(/\./g, '\\.');
  const pathRe = new RegExp(`https?://${hostEsc}/((?:zh|en)/)?wiki/([^"\\s&?#]+)`, 'gi');
  for (const q of queries) {
    try {
      const html = await _bingHtml(q, preferEn);
      let m;
      while ((m = pathRe.exec(html)) !== null) {
        const lang = m[1]?.startsWith('zh') ? 'zh' : 'en';
        let title;
        try {
          title = decodeURIComponent(m[2].replace(/_/g, ' '));
        } catch {
          title = m[2].replace(/_/g, ' ');
        }
        if (!title || /特殊:|模板:|分类:/i.test(title)) continue;
        if (!_charNameInTitle(searchName, title)) continue;
        const url = _buildPageUrl(host, lang, title);
        if (!pages.some((p) => p.url === url)) {
          pages.push({
            title,
            snippet: `Bing site:${host}`,
            url,
            source: 'fandom',
            fandomHost: host,
            fandomLang: lang,
          });
        }
      }
      if (pages.length) return pages;
    } catch { /* next query */ }
  }
  return pages;
}

/**
 * Search character on discovered Fandom wiki.
 */
async function fandomSearchResults(charName, fanworkName, context = {}) {
  if (!charName || !fanworkName) return [];
  const preferEn = context.fanworkSphere === 'western-en' || context.fanworkSphere === 'global';
  const searchName = context.nativeCharName || charName;
  const workName = context.nativeWorkName || fanworkName;
  const latinNative = /^[A-Za-z]/.test(String(searchName || '').trim()) && !/[\u4e00-\u9fff]/.test(searchName);
  const discovered = await discoverFandomHost(workName, { preferEn, charName, nativeCharName: searchName });
  if (!discovered?.host) return [];
  const langs = preferEn && latinNative ? ['en'] : discovered.langs;
  const apiHits = await _searchOnHost(discovered.host, searchName, langs);
  if (apiHits.length) return apiHits;
  return _bingSiteWikiPages(discovered.host, searchName, workName, preferEn);
}

async function fandomFetchPage(title, context = {}) {
  const host = context.fandomHost;
  const pageTitle = String(title || '').trim();
  if (!host || !pageTitle) return '';

  const langs = [context.fandomLang, 'zh', 'en'].filter((v, i, a) => v && a.indexOf(v) === i);
  for (const lang of langs) {
    try {
      const json = await _fandomApi(host, lang, {
        action: 'parse',
        page: pageTitle,
        prop: 'text',
      }, FETCH_TIMEOUT_MS.parse);
      const raw = json?.parse?.text;
      const html = typeof raw === 'string' ? raw : (raw?.['*'] || '');
      if (html && html.length > 100) return html;
    } catch { /* next lang */ }
  }
  return '';
}

module.exports = {
  discoverFandomHost,
  fandomSearchResults,
  fandomFetchPage,
  _charNameInTitle,
};
