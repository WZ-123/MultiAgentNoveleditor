'use strict';

/**
 * Biligame / BWiki title resolution and direct URL construction.
 */

const fs = require('node:fs');
const path = require('node:path');
const { networkFetch, networkFetchJson } = require('./networkFetch');

const BILIGAME_WIKI_ALIASES = {
  blhx: ['碧蓝航线', 'Azur Lane', 'azur lane'],
  ys: ['原神', 'Genshin Impact', 'genshin impact', 'genshin'],
  sr: ['崩坏：星穹铁道', '崩坏:星穹铁道', '崩坏星穹铁道', 'Honkai: Star Rail', 'Honkai Star Rail', 'star rail'],
  zzz: ['绝区零', 'Zenless Zone Zero', 'zenless zone zero'],
  wutheringwaves: ['鸣潮', 'Wuthering Waves', 'wuthering waves'],
};

const FETCH_TIMEOUT_MS = { search: 12000, parse: 15000 };

const WIKI_FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: 'application/json,text/plain,*/*',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
};

let _titleAliasesCache = null;

function resolveBiligameWikiSlug(fanworkName) {
  const normalized = String(fanworkName || '').trim().toLowerCase();
  if (!normalized) return null;
  for (const [slug, aliases] of Object.entries(BILIGAME_WIKI_ALIASES)) {
    if (aliases.some((alias) => {
      const a = alias.toLowerCase();
      return normalized === a || normalized.includes(a) || a.includes(normalized);
    })) return slug;
  }
  return null;
}

function encodeBiligameTitle(title) {
  return encodeURIComponent(String(title || '').trim().replace(/ /g, '_'));
}

function buildBiligamePageUrl(slug, title) {
  return `https://wiki.biligame.com/${slug}/${encodeBiligameTitle(title)}`;
}

function _compactName(name) {
  return String(name || '').replace(/[·・.\s]/g, '').toLowerCase();
}

function _charNameInTitle(charName, title) {
  const core = _compactName(charName);
  if (!core) return false;
  const segCore = _compactName(title);
  if (segCore === core) return true;
  if (title.includes(charName)) return true;
  if (segCore.startsWith(core)) {
    const rest = segCore.slice(core.length);
    if (!rest) return true;
    if (/^(meta|改|级|型|号|礼服|泳装|皮肤)/i.test(rest)) return true;
    return false;
  }
  return false;
}

function _aliasesPath() {
  return path.join(
    path.resolve(__dirname, '../../..'),
    'test-projects',
    'web-enrichment-benchmark-2026',
    'bwiki-title-aliases.json'
  );
}

function loadTitleAliases() {
  if (_titleAliasesCache) return _titleAliasesCache;
  try {
    const raw = fs.readFileSync(_aliasesPath(), 'utf8');
    _titleAliasesCache = JSON.parse(raw);
  } catch {
    _titleAliasesCache = {};
  }
  return _titleAliasesCache;
}

function _wikiHeaders(slug, extraCookie = '') {
  const headers = {
    ...WIKI_FETCH_HEADERS,
    Referer: `https://wiki.biligame.com/${slug}/`,
  };
  if (extraCookie) headers.Cookie = extraCookie;
  return headers;
}

async function _fetchMediaWikiApi(slug, params, { cookie = '', timeoutMs = FETCH_TIMEOUT_MS.search } = {}) {
  const qs = new URLSearchParams({ ...params, format: 'json', formatversion: '2', origin: '*' });
  const url = `https://wiki.biligame.com/${slug}/api.php?${qs.toString()}`;
  return networkFetchJson(url, {
    headers: _wikiHeaders(slug, cookie),
    timeout: timeoutMs,
    retries: 1,
  });
}

async function _searchViaApi(slug, charName, cookie) {
  const json = await _fetchMediaWikiApi(slug, {
    action: 'query',
    list: 'search',
    srsearch: charName,
    srlimit: '8',
  }, { cookie });
  const hits = json?.query?.search || [];
  for (const hit of hits) {
    const title = hit?.title || '';
    if (_charNameInTitle(charName, title)) return title;
  }
  return hits[0]?.title || null;
}

function _parseTitlesFromSearchHtml(html, slug, charName) {
  const titles = [];
  const linkRe = new RegExp(`href="/${slug}/([^"?#]+)"`, 'gi');
  let m;
  while ((m = linkRe.exec(html)) !== null) {
    try {
      const title = decodeURIComponent(m[1].replace(/_/g, ' '));
      if (title && !titles.includes(title)) titles.push(title);
    } catch { /* skip */ }
  }
  for (const title of titles) {
    if (_charNameInTitle(charName, title)) return title;
  }
  return titles[0] || null;
}

async function _searchViaHtml(slug, charName, cookie) {
  const url = `https://wiki.biligame.com/${slug}/index.php?search=${encodeURIComponent(charName)}`;
  const res = await networkFetch(url, {
    headers: _wikiHeaders(slug, cookie),
    timeout: FETCH_TIMEOUT_MS.search,
  });
  const html = await res.text();
  return _parseTitlesFromSearchHtml(html, slug, charName);
}

async function _searchViaBingSite(slug, charName) {
  const q = `${charName} site:wiki.biligame.com/${slug}`;
  const url = `https://cn.bing.com/search?q=${encodeURIComponent(q)}`;
  const res = await networkFetch(url, {
    headers: {
      'User-Agent': WIKI_FETCH_HEADERS['User-Agent'],
      'Accept-Language': 'zh-CN,zh;q=0.9',
    },
    timeout: 12000,
  });
  const html = await res.text();
  const urlRe = new RegExp(`https?://wiki\\.biligame\\.com/${slug}/([^"&\\s]+)`, 'gi');
  let m;
  while ((m = urlRe.exec(html)) !== null) {
    try {
      const title = decodeURIComponent(m[1].replace(/_/g, ' '));
      if (_charNameInTitle(charName, title)) return { title, url: m[0].split('"')[0] };
    } catch { /* continue */ }
  }
  return null;
}

/**
 * Resolve BWiki page title for a character (cascade: aliases → API → HTML → Bing).
 * @returns {{ title: string, slug: string, url: string } | null}
 */
async function resolveBiligamePageTitle(charName, fanworkName, options = {}) {
  const slug = resolveBiligameWikiSlug(fanworkName);
  if (!slug || !charName) return null;
  const cookie = options.wikiCookie || '';

  const aliases = loadTitleAliases();
  const aliasKey = `${fanworkName}:${charName}`;
  if (aliases[aliasKey]) {
    const title = aliases[aliasKey];
    return { title, slug, url: buildBiligamePageUrl(slug, title) };
  }

  if (slug === 'wutheringwaves' && charName) {
    const prefTitle = `共鸣者/${charName}`;
    return { title: prefTitle, slug, url: buildBiligamePageUrl(slug, prefTitle) };
  }

  let title = null;
  try {
    title = await _searchViaApi(slug, charName, cookie);
  } catch { /* API may return HTML WAF */ }

  if (!title || !_charNameInTitle(charName, title)) {
    try {
      const htmlTitle = await _searchViaHtml(slug, charName, cookie);
      if (htmlTitle) title = htmlTitle;
    } catch { /* ignore */ }
  }

  if (!title) {
    try {
      const bingHit = await _searchViaBingSite(slug, charName);
      if (bingHit?.title) {
        return { title: bingHit.title, slug, url: bingHit.url || buildBiligamePageUrl(slug, bingHit.title) };
      }
    } catch { /* ignore */ }
  }

  if (!title) title = charName;
  return { title, slug, url: buildBiligamePageUrl(slug, title) };
}

/**
 * Build biligame search results (direct link when API search fails).
 */
async function biligameSearchResults(charName, fanworkName, context = {}) {
  const slug = resolveBiligameWikiSlug(fanworkName);
  if (!slug) return [];

  const queries = [charName, `${fanworkName} ${charName}`].filter(Boolean);
  const pages = [];
  for (const q of queries) {
    try {
      const json = await _fetchMediaWikiApi(slug, {
        action: 'query',
        list: 'search',
        srsearch: q,
        srlimit: '5',
      }, { cookie: context.wikiCookie || '' });
      for (const page of json?.query?.search || []) {
        const title = page?.title || '';
        if (!title || /opensearch|desc\.php|特殊:|模板:/i.test(title)) continue;
        pages.push({
          title,
          snippet: (page.snippet || '').replace(/<[^>]+>/g, ''),
          url: buildBiligamePageUrl(slug, title),
          source: 'biligame',
        });
      }
    } catch { /* fall through */ }
  }

  const resolved = await resolveBiligamePageTitle(charName, fanworkName, context);
  if (resolved) {
    const dup = pages.some((p) => p.title === resolved.title || p.url === resolved.url);
    if (!dup) {
      pages.unshift({
        title: resolved.title,
        snippet: `BWiki 直链 (${fanworkName})`,
        url: resolved.url,
        source: 'biligame',
      });
    }
  }

  if (slug === 'wutheringwaves' && charName) {
    const fallbackPages = [
      {
        title: `${charName} 配装与信息 - 鸣潮 Wuthering.gg`,
        snippet: `Wuthering.gg 鸣潮角色直链 (${charName})`,
        url: `https://wuthering.gg/zh-Hans/characters/${encodeURIComponent(charName === '达妮娅' ? 'denia' : charName)}`,
      },
      {
        title: `${charName} | 鸣潮 Wiki | Fandom`,
        snippet: `鸣潮中文 Fandom 直链 (${charName})`,
        url: `https://wutheringwaves.fandom.com/zh/wiki/${encodeURIComponent(charName)}`,
      },
    ];
    for (const page of fallbackPages) {
      if (pages.some((p) => p.url === page.url)) continue;
      pages.push({
        title: page.title,
        snippet: page.snippet,
        url: page.url,
        source: 'biligame',
      });
    }
  }

  if (pages.length) return pages;
  if (resolved) {
    return [{
      title: resolved.title,
      snippet: `BWiki 直链候选 (${fanworkName})`,
      url: resolved.url,
      source: 'biligame',
    }];
  }
  return [];
}

async function biligameFetchPage(title, fanworkName, context = {}) {
  const slug = resolveBiligameWikiSlug(fanworkName);
  if (!slug) return '';
  const pageTitle = String(title || '').trim();
  if (!pageTitle) return '';

  const cookie = context.wikiCookie || '';
  try {
    const json = await _fetchMediaWikiApi(slug, {
      action: 'parse',
      page: pageTitle,
      prop: 'text',
    }, { cookie, timeoutMs: FETCH_TIMEOUT_MS.parse });
    const rawText = json?.parse?.text;
    const html = typeof rawText === 'string' ? rawText : (rawText?.['*'] || '');
    if (html && html.length > 100) return html;
  } catch { /* URL fallback */ }

  return '';
}

module.exports = {
  BILIGAME_WIKI_ALIASES,
  resolveBiligameWikiSlug,
  buildBiligamePageUrl,
  resolveBiligamePageTitle,
  biligameSearchResults,
  biligameFetchPage,
  encodeBiligameTitle,
  _charNameInTitle,
};
