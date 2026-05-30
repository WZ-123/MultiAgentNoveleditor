'use strict';

/**
 * Search Engine Framework — multi-source search with cultural routing.
 *
 * Sources indexed by cultural region with API details.
 * Route decisions: 用户语言 + 原作文化圈 → 最优搜索队列
 *
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║  搜索路由策略的单一真相源：knowledge-base/search-routing.md   ║
 * ║  Claude Code Skill 版本：.claude/skills/search-routing/      ║
 * ║  修改本文件时须同步更新上述两文件，反之亦然。                   ║
 * ╚═══════════════════════════════════════════════════════════════╝
 */

const { networkFetch, networkFetchJson } = require('./networkFetch');
const biligameWiki = require('./biligameWiki');
const fandomWiki = require('./fandomWiki');
const bangumiCharacter = require('./bangumiCharacter');
const {
  resolveNativeCharacterName,
  resolveNativeWorkName,
  sourceUsesNativeName,
} = require('./nativeSearchName');

// ── Source registry ──────────────────────────────────────────────

const BILIGAME_WIKI_ALIASES = biligameWiki.BILIGAME_WIKI_ALIASES;

const LIST_PAGE_TITLE_RE = /图鉴|一览|分类|列表|索引|人气投票|舰船图鉴|角色一览|模板:/;
const NON_CHARACTER_TITLE_RE = /（电影|（游戏|（剧集|（电视|\(film\)|\(movie\)|\(series\)|\(TV\)|list of/i;
const JUNK_URL_RE = /baidu\.com|pizza|dominos|reddit\.com\/r\/all|100xgj|qidian\.com|hanyuguoxue|andpizza|taptap\.cn|bilibili\.com|bilibili\.comhttps?|biligame\.comhttps?|opensearch|desc\.php|zhihu\.com|52pojie|autohome\.com|wuling\.com|zdic\.net|chagushici|gushici\.net|iqiyi\.com|newdu\.com|gatzs\.com|zgzzs\.com|nscc-gz\.cn|v\.qq\.com|news\.qq\.com|douban\.com\/movie|baike\.sogou|ced\.newdu/i;
const MERGED_HOST_URL_RE = /[a-z0-9]\.comhttps?:\/\//i;
const JUNK_TITLE_RE = /opensearch|desc\.php|特殊:|模板:|index\.php\?title=Special|bilibili\.comhttps?/i;
const PREFERRED_WIKI_URL_RE = /wiki\.biligame\.com|moegirl\.icu|wikipedia\.org|fandom\.com|chii\.in\/character|bgm\.tv\/character|bangumi\.tv\/character|bbs\.mihoyo|nga\.cn|miyoushe\.com/i;

const FETCH_TIMEOUT_MS = {
  search: 12000,
  parse: 15000,
  web: 15000,
};

const resolveBiligameWikiSlug = biligameWiki.resolveBiligameWikiSlug;

function _sanitizeResultUrl(url) {
  const s = String(url || '').trim();
  if (!s) return '';
  const nested = s.match(/https?:\/\/[a-z0-9.-]+\.(?:com|cn|net)https?:\/\//i);
  if (nested) {
    const second = s.slice(s.indexOf('://') + 3).search(/https?:\/\//i);
    if (second >= 0) return s.slice(s.indexOf('://') + 3 + second);
  }
  const fandom = s.match(/(https?:\/\/[a-z0-9-]+\.fandom\.com\/[^\s"<>]+)/i);
  if (fandom) return fandom[1];
  const huiji = s.match(/(https?:\/\/[a-z0-9-]+\.huijiwiki\.com\/[^\s"<>]+)/i);
  if (huiji) return huiji[1];
  return s;
}

function _preferEnSearch(context = {}) {
  return context.fanworkSphere === 'western-en' || context.fanworkSphere === 'global';
}

const WIKI_FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json,text/plain,*/*',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
};

async function _fetchMediaWikiJson(url, timeoutMs = FETCH_TIMEOUT_MS.search) {
  return networkFetchJson(url, {
    headers: WIKI_FETCH_HEADERS,
    timeout: timeoutMs,
    retries: 1,
  });
}

function _compactName(name) {
  return String(name || '').replace(/[·・.\s]/g, '').toLowerCase();
}

function _titleCharacterSegment(title, fanworkName) {
  const t = String(title || '').trim();
  const fw = String(fanworkName || '').trim();
  if (fw) {
    const colonIdx = Math.max(t.lastIndexOf(':'), t.lastIndexOf('：'));
    if (colonIdx >= 0) return t.slice(colonIdx + 1).trim();
  }
  return t;
}

function _charNameInTitle(charName, title, fanworkName = '') {
  const core = _compactName(charName);
  if (!core) return false;
  const seg = _titleCharacterSegment(title, fanworkName);
  const segCore = _compactName(seg);
  if (segCore === core) return true;
  if (seg.includes(charName)) return true;
  if (segCore.startsWith(core)) {
    const rest = segCore.slice(core.length);
    if (!rest) return true;
    if (/^(meta|改|级|型|号|礼服|泳装)/i.test(rest)) return true;
    return false;
  }
  return title.includes(charName);
}

/**
 * Score a search hit for character enrichment (higher = better).
 */
function scoreSearchResult(result, { charName = '', fanworkName = '', nativeCharName = '' } = {}) {
  let score = 0;
  const title = String(result?.title || '');
  const url = String(result?.url || '');
  const source = String(result?.source || '');
  const matchName = nativeCharName || charName;
  const idealTitle = fanworkName && matchName ? `${fanworkName}:${matchName}` : '';

  if (idealTitle && (title === idealTitle || title.includes(idealTitle))) score += 120;
  if (_charNameInTitle(matchName, title, fanworkName)) score += 70;
  if (nativeCharName && nativeCharName !== charName && _charNameInTitle(nativeCharName, title, fanworkName)) score += 50;
  if (source === 'moegirl' || source === 'biligame' || source === 'fandom') score += 25;
  if (source === 'bangumi') score += 20;
  if (source === 'moegirl' && charName && (title === charName || title === `${fanworkName}:${charName}` || title.endsWith(`:${charName}`))) score += 95;
  if (source === 'fandom' && /fandom\.com/i.test(url) && _charNameInTitle(charName, title, fanworkName)) score += 90;
  if (source === 'bangumi' && /(?:chii|bgm|bangumi)\.(?:in|tv)\/character\/\d+/i.test(url)) score += 80;
  if (source === 'bangumi' && result?.workMatched) score += 90;
  const biliSlug = resolveBiligameWikiSlug(fanworkName);
  if (source === 'biligame' && biliSlug && url.includes(`wiki.biligame.com/${biliSlug}/`)) {
    score += 80;
    if (_charNameInTitle(charName, title, fanworkName)) score += 70;
    if (biliSlug === 'wutheringwaves' && title.includes(`共鸣者/${charName}`)) score += 90;
  }
  if (PREFERRED_WIKI_URL_RE.test(url)) score += 35;
  if (url && !JUNK_URL_RE.test(url)) score += 10;

  if (LIST_PAGE_TITLE_RE.test(title) && !_charNameInTitle(charName, title, fanworkName)) score -= 100;
  if (NON_CHARACTER_TITLE_RE.test(title)) score -= 85;
  if (fanworkName && (title === fanworkName || title.endsWith(fanworkName)) && !_charNameInTitle(charName, title, fanworkName)) {
    score -= 90;
  }
  if (JUNK_URL_RE.test(url)) score -= 120;
  if (JUNK_TITLE_RE.test(title)) score -= 150;
  if (charName && title && !_charNameInTitle(charName, title, fanworkName) && !PREFERRED_WIKI_URL_RE.test(url)) {
    score -= 40;
  }
  if (source === 'moegirl' && charName && !_charNameInTitle(charName, title, fanworkName)) score -= 70;

  return score;
}

function rankSearchResults(results, context = {}) {
  return [...(results || [])]
    .map((r, index) => ({ r, index, score: scoreSearchResult(r, context) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((item) => item.r);
}

function _pageTextRelevant(pageText, charName, fanworkName, pageTitle = '', nativeCharName = '') {
  const text = String(pageText || '');
  const title = String(pageTitle || '');
  const matchName = nativeCharName || charName;
  if (!charName && !matchName) return text.length >= 200;
  if (LIST_PAGE_TITLE_RE.test(title) && !_charNameInTitle(matchName, title, fanworkName)) return false;
  if (_charNameInTitle(matchName, title, fanworkName)) return true;
  if (text.includes(matchName)) {
    if (!fanworkName || text.includes(fanworkName)) return true;
    return text.length > 800;
  }
  if (nativeCharName && nativeCharName !== charName && text.includes(nativeCharName)) {
    return text.length > 400;
  }
  return false;
}

const SOURCES = {
  moegirl: {
    id: 'moegirl', label: '萌娘百科',
    regions: ['zh-CN', 'zh-TW'],
    async search(query) {
      const url = `https://moegirl.icu/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&srlimit=5`;
      const json = await _fetchMediaWikiJson(url, FETCH_TIMEOUT_MS.search);
      return (json?.query?.search || []).map((p) => ({
        title: p.title, snippet: (p.snippet || '').replace(/<[^>]+>/g, ''),
        url: `https://moegirl.icu/${encodeURIComponent(p.title)}`, source: 'moegirl',
      }));
    },
    async fetchPage(title, _userLang, context = {}) {
      const pageTitle = String(title || '').trim();
      if (!pageTitle) return '';
      try {
        const url = `https://moegirl.icu/api.php?action=parse&page=${encodeURIComponent(pageTitle)}&prop=text&format=json`;
        const json = await _fetchMediaWikiJson(url, FETCH_TIMEOUT_MS.parse);
        const html = json?.parse?.text?.['*'] || '';
        const text = _normalizeFetchText(html);
        if (text.length > 200) return text;
      } catch { /* fallback below */ }
      try {
        const pageUrl = `https://moegirl.icu/${encodeURIComponent(pageTitle)}`;
        const payload = await fetchWebPage(pageUrl, { maxChars: 12000 });
        if (payload.ok && payload.text.length > 200) return payload.text;
      } catch { /* ignore */ }
      return '';
    },
  },

  fandom: {
    id: 'fandom', label: 'Fandom Wiki',
    regions: ['en-US', 'zh-CN', 'zh-TW', '*'],
    async search(_query, _userRegionCode, context = {}) {
      const { fanworkName, charName } = context;
      return fandomWiki.fandomSearchResults(charName || _query, fanworkName, context);
    },
    async fetchPage(title, _userLang, context = {}) {
      const pageTitle = String(title || '').trim();
      if (!pageTitle) return '';
      let html = await fandomWiki.fandomFetchPage(pageTitle, context);
      if (html) {
        const text = _normalizeFetchText(html);
        if (text.length > 200) return text;
      }
      if (context.fandomHost) {
        try {
          const lang = context.fandomLang || 'en';
          const pageUrl = `https://${context.fandomHost}/${lang === 'en' ? 'wiki' : `${lang}/wiki`}/${encodeURIComponent(pageTitle.replace(/ /g, '_'))}`;
          const payload = await fetchWebPage(pageUrl, { maxChars: 20000 });
          if (payload.ok && payload.text.length > 200) return payload.text;
        } catch { /* ignore */ }
      }
      return '';
    },
  },

  bangumi: {
    id: 'bangumi', label: 'Bangumi',
    regions: ['zh-CN', 'zh-TW', 'ja-JP', 'ko-KR'],
    async search(query, _userRegionCode, context = {}) {
      const { fanworkName } = context;
      return bangumiCharacter.bangumiSearchResults(query, fanworkName, context);
    },
    async fetchPage(title, _userLang, context = {}) {
      return bangumiCharacter.bangumiFetchPage(title, context);
    },
  },

  biligame: {
    id: 'biligame', label: 'Biligame Wiki',
    regions: ['zh-CN', 'zh-TW'],
    async search(query, _userRegionCode, context = {}) {
      const { fanworkName, charName } = context;
      return biligameWiki.biligameSearchResults(charName || query, fanworkName, context);
    },
    async fetchPage(title, _userLang, context = {}) {
      const pageTitle = String(title || '').trim();
      const fanworkName = context?.fanworkName || '';
      let html = await biligameWiki.biligameFetchPage(pageTitle, fanworkName, context);
      if (html) {
        const text = _normalizeFetchText(html);
        if (text.length > 200) return text;
      }
      const slug = resolveBiligameWikiSlug(fanworkName);
      if (!slug || !pageTitle) return '';
      try {
        const pageUrl = biligameWiki.buildBiligamePageUrl(slug, pageTitle);
        const payload = await fetchWebPage(pageUrl, { maxChars: 24000 });
        if (payload.ok && payload.text.length > 200) return payload.text;
      } catch { /* ignore */ }
      return '';
    },
  },

  bing: {
    id: 'bing', label: 'Bing 搜索',
    regions: ['zh-CN', 'zh-TW', 'en-US', 'ja-JP', 'ko-KR', '*'],
    async search(query, _userRegionCode, context = {}) {
      const preferEn = _preferEnSearch(context);
      const url = preferEn
        ? `https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=en-US`
        : `https://cn.bing.com/search?q=${encodeURIComponent(query)}`;
      const res = await networkFetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept-Language': preferEn ? 'en-US,en;q=0.9' : 'zh-CN,zh;q=0.9,en;q=0.8',
        },
        timeout: 10000,
      });
      const html = await res.text();
      // Parse organic results from Bing HTML
      const results = [];
      // Bing result blocks: <li class="b_algo">...</li>
      const blockRe = /<li class="b_algo"[^>]*>([\s\S]*?)<\/li>/gi;
      let bm;
      while ((bm = blockRe.exec(html)) !== null) {
        const block = bm[1];
        const titleMatch = block.match(/<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
        const snippetMatch = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
        if (titleMatch) {
          const href = _sanitizeResultUrl(titleMatch[1]);
          if (!href || JUNK_URL_RE.test(href)) continue;
          results.push({
            title: titleMatch[2].replace(/<[^>]+>/g, '').trim(),
            snippet: (snippetMatch ? snippetMatch[1] : '').replace(/<[^>]+>/g, '').trim(),
            url: href,
            source: 'bing',
          });
        }
      }
      return results.slice(0, 5);
    },
    async fetchPage(title) { return null; },
  },

  wikipedia: {
    id: 'wikipedia', label: 'Wikipedia',
    regions: ['en-US', 'ja-JP', 'zh-CN', 'zh-TW', 'ko-KR', '*'],
    _lang(query, userLang) {
      const map = { 'zh-CN': 'zh', 'zh-TW': 'zh', 'ja-JP': 'ja', 'ko-KR': 'ko' };
      return map[userLang] || 'en';
    },
    async search(query, userLang, context = {}) {
      const langs = [];
      const ur = userLang || 'zh-CN';
      const western = context.fanworkSphere === 'western-en' || context.fanworkSphere === 'global';
      if (western) {
        langs.push('en');
        if (ur.startsWith('zh')) langs.push('zh');
      } else {
        const primary = this._lang(query, ur);
        langs.push(primary);
        if (primary !== 'zh') langs.push('zh');
        if (primary !== 'en') langs.push('en');
      }
      for (const lang of langs.filter((v, i, a) => a.indexOf(v) === i)) {
        try {
          const url = `https://${lang}.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&srlimit=3&origin=*`;
          const json = await networkFetchJson(url, { timeout: 20000, retries: 2 });
          const hits = (json?.query?.search || []).map((p) => ({
            title: p.title, snippet: (p.snippet || '').replace(/<[^>]+>/g, ''),
            url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(p.title)}`, source: 'wikipedia',
          }));
          if (hits.length) return hits;
        } catch { /* try next lang */ }
      }
      return [];
    },
    async fetchPage(title, userLang) {
      const lang = userLang ? this._lang(null, userLang) : 'en';
      const langs = [lang, 'zh', 'en'].filter((v, i, a) => a.indexOf(v) === i);
      for (const lg of langs) {
        try {
          const url = `https://${lg}.wikipedia.org/w/api.php?action=query&prop=extracts&exintro&explaintext&titles=${encodeURIComponent(title)}&format=json&origin=*`;
          const json = await networkFetchJson(url, { timeout: 20000, retries: 2 });
          const pages = json?.query?.pages || {};
          const extract = Object.values(pages)[0]?.extract || '';
          if (extract && extract.length > 80) return extract;
        } catch { /* next */ }
      }
      return '';
    },
  },

  duckduckgo: {
    id: 'duckduckgo', label: 'DuckDuckGo',
    regions: ['*'],
    async search(query) {
      const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
      const html = await res.text();
      const snippetRe = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
      const titleRe = /<a[^>]*class="result__a"[^>]*>([\s\S]*?)<\/a>/gi;
      const snippets = [...html.matchAll(snippetRe)].map((m) => m[1].replace(/<[^>]+>/g, '').trim()).slice(0, 5);
      const titles = [...html.matchAll(titleRe)].map((m) => m[1].replace(/<[^>]+>/g, '').trim()).slice(0, 5);
      const results = [];
      for (let i = 0; i < Math.max(snippets.length, titles.length); i++) {
        results.push({ title: titles[i] || '', snippet: snippets[i] || '', source: 'duckduckgo' });
      }
      return results.filter((r) => r.title || r.snippet);
    },
    async fetchPage(title) { return null; },
  },
};

// ── Cultural routing ─────────────────────────────────────────────

/**
 * Map user language code to cultural region.
 */
function userRegion(userLang) {
  if (!userLang) return 'en-US';
  if (userLang.startsWith('zh')) return 'zh-CN';
  if (userLang.startsWith('ja')) return 'ja-JP';
  if (userLang.startsWith('ko')) return 'ko-KR';
  return 'en-US';
}

/**
 * Determine source priority for a given cultural sphere and user language.
 * Returns ordered list of source ids.
 */
function sourcePriority(fanworkSphere, userLang) {
  const ur = userRegion(userLang);
  // Map cultural sphere to preferred source order
  const sphereSources = {
    'east-asian-cn': ['biligame', 'bangumi', 'moegirl', 'bing', 'wikipedia'],
    'east-asian-jp': ['bangumi', 'moegirl', 'wikipedia', 'bing'],
    'east-asian-kr': ['wikipedia', 'bangumi', 'bing', 'moegirl'],
    'western-en': ['fandom', 'wikipedia', 'moegirl', 'bing'],
    'global': ['fandom', 'wikipedia', 'moegirl', 'bing'],
  };
  return sphereSources[fanworkSphere] || ['wikipedia'];
}

function _dedupeResults(results) {
  const seen = new Set();
  const out = [];
  for (const result of results || []) {
    const key = `${result?.url || ''}::${result?.title || ''}::${result?.snippet || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(result);
  }
  return out;
}

function _sortResultsBySourcePriority(results, sourceIds) {
  const order = new Map((sourceIds || []).map((id, index) => [id, index]));
  return [...(results || [])].sort((left, right) => {
    const leftRank = order.has(left?.source) ? order.get(left.source) : Number.MAX_SAFE_INTEGER;
    const rightRank = order.has(right?.source) ? order.get(right.source) : Number.MAX_SAFE_INTEGER;
    if (leftRank !== rightRank) return leftRank - rightRank;
    return 0;
  });
}

function _sortSourceDetailsByPriority(sourceDetails, sourceIds) {
  const order = new Map((sourceIds || []).map((id, index) => [id, index]));
  return [...(sourceDetails || [])].sort((left, right) => {
    const leftRank = order.has(left?.source) ? order.get(left.source) : Number.MAX_SAFE_INTEGER;
    const rightRank = order.has(right?.source) ? order.get(right.source) : Number.MAX_SAFE_INTEGER;
    if (leftRank !== rightRank) return leftRank - rightRank;
    return 0;
  });
}

function _normalizeFetchText(raw) {
  return String(raw || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--([\s\S]*?)-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

async function searchWeb({ query, userLang = 'zh-CN', preferredEngine = 'auto', fanworkSphere = 'global' }) {
  const trimmed = String(query || '').trim();
  if (!trimmed) return { results: [], errors: ['查询为空'], sourceDetails: [] };

  const ur = userRegion(userLang);
  let sourceIds;
  if (preferredEngine !== 'auto' && preferredEngine !== 'all') {
    sourceIds = [preferredEngine].filter((id) => SOURCES[id]);
    if (!sourceIds.includes('duckduckgo')) sourceIds.push('duckduckgo');
  } else if (preferredEngine === 'all') {
    sourceIds = Object.keys(SOURCES);
  } else {
    sourceIds = sourcePriority(fanworkSphere, userLang);
  }

  const allResults = [];
  const sourceDetails = [];
  const sourceMsgs = [];

  await Promise.allSettled(sourceIds.map(async (id) => {
    const src = SOURCES[id];
    if (!src?.search) return;
    try {
      const results = await src.search(trimmed, ur);
      const tagged = (results || []).map((result) => ({ ...result, source: result?.source || id }));
      allResults.push(...tagged);
      sourceDetails.push({
        source: id,
        sourceLabel: src.label,
        query: trimmed,
        count: tagged.length,
        topResults: tagged.slice(0, 5).map((result) => ({
          title: result.title || '',
          snippet: result.snippet || '',
          url: result.url || '',
        })),
      });
      sourceMsgs.push(`${src.label}: ${tagged.length}条`);
    } catch (err) {
      sourceDetails.push({ source: id, sourceLabel: src.label, query: trimmed, count: 0, error: err.message || 'unknown' });
      sourceMsgs.push(`${src.label}: 错误(${err.message || 'unknown'})`);
    }
  }));

  // Last-resort fallback: DuckDuckGo only if primary sources returned nothing
  if (allResults.length === 0 && preferredEngine === 'auto') {
    try {
      const ddResults = await SOURCES.duckduckgo.search(trimmed, ur);
      const tagged = (ddResults || []).map((r) => ({ ...r, source: 'duckduckgo' }));
      allResults.push(...tagged);
      sourceDetails.push({
        source: 'duckduckgo',
        sourceLabel: SOURCES.duckduckgo.label,
        query: trimmed,
        count: tagged.length,
        topResults: tagged.slice(0, 5).map((r) => ({ title: r.title || '', snippet: r.snippet || '', url: r.url || '' })),
      });
      sourceMsgs.push(`${SOURCES.duckduckgo.label}: ${tagged.length}条 (last-resort fallback)`);
    } catch (err) {
      sourceDetails.push({ source: 'duckduckgo', sourceLabel: SOURCES.duckduckgo.label, query: trimmed, count: 0, error: err.message || 'unknown' });
      sourceMsgs.push(`${SOURCES.duckduckgo.label}: 错误(${err.message || 'unknown'})`);
    }
  }

  return {
    results: _sortResultsBySourcePriority(_dedupeResults(allResults), sourceIds),
    errors: sourceMsgs,
    sourceDetails: _sortSourceDetailsByPriority(sourceDetails, sourceIds),
  };
}

async function fetchWebPage(url, { maxChars = 12000 } = {}) {
  const target = String(url || '').trim();
  if (!target) throw new Error('url is required');
  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    throw new Error(`invalid url: ${target}`);
  }
  if (!/^https?:$/i.test(parsed.protocol)) {
    throw new Error(`unsupported protocol: ${parsed.protocol}`);
  }

  const res = await networkFetch(parsed.toString(), {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    },
    timeout: FETCH_TIMEOUT_MS.web,
  });
  const raw = await res.text();
  const contentType = res.headers.get('content-type') || '';
  const isMarkup = /html|xml/i.test(contentType) || /^\s*</.test(raw);
  const text = isMarkup ? _normalizeFetchText(raw) : String(raw || '').trim();

  return {
    url: parsed.toString(),
    ok: res.ok,
    status: res.status,
    contentType,
    text: text.slice(0, Math.max(256, Number(maxChars) || 12000)),
  };
}

// ── Public API ───────────────────────────────────────────────────

/**
 * Build source-specific search query that includes fanwork context.
 * This prevents ambiguous results (e.g. "HK416" → firearm vs "少女前线 HK416" → character).
 */
function buildQueries(sourceId, charName, fanworkName, queryOpts = {}) {
  const {
    nativeCharName = charName,
    nativeWorkName = fanworkName,
    fanworkSphere = '',
  } = queryOpts;
  const useNative = sourceUsesNativeName(sourceId, fanworkSphere);
  const qChar = useNative ? nativeCharName : charName;
  const qWork = useNative ? nativeWorkName : fanworkName;

  if (!qWork || !qChar) return [qChar || qWork || ''];
  if (sourceId === 'moegirl') {
    return [`${fanworkName}:${charName}`, `${fanworkName} ${charName}`];
  }
  if (sourceId === 'biligame') {
    return [charName, `${fanworkName} ${charName}`];
  }
  if (sourceId === 'fandom') {
    return [qChar, `${qWork} ${qChar}`];
  }
  if (sourceId === 'bangumi') {
    return [`${qChar} ${qWork}`, qChar];
  }
  if (sourceId === 'wikipedia') {
    return [`${qChar} ${qWork} character`, `${qChar} ${qWork}`];
  }
  const queries = [`${qChar} ${qWork} character wiki`, `${qWork} ${qChar}`];
  const slug = resolveBiligameWikiSlug(fanworkName);
  if (slug && !useNative) queries.unshift(`${charName} site:wiki.biligame.com/${slug}`);
  return queries;
}

/**
 * Search for a character across appropriate sources based on cultural routing.
 *
 * @param {string} charName - raw character name (without fanwork prefix)
 * @param {string} fanworkName - original work / fanwork name (e.g. '碧蓝航线')
 * @param {string} userLang - user's language code (e.g. 'zh-CN')
 * @param {string} fanworkSphere - detected cultural sphere of the original work
 * @param {string} preferredEngine - user setting: 'auto' | 'moegirl' | 'wikipedia' | 'duckduckgo' | 'all'
 * @returns {{results: Array, errors: Array}} search results and per-source status messages
 */
async function searchCharacter({
  charName,
  fanworkName,
  userLang = 'zh-CN',
  fanworkSphere = 'east-asian-cn',
  preferredEngine = 'auto',
  originalName = '',
}) {
  const ur = userRegion(userLang);
  const nativeCharName = await resolveNativeCharacterName(charName, fanworkName, fanworkSphere, { originalName });
  const nativeWorkName = await resolveNativeWorkName(fanworkName, fanworkSphere);
  const queryOpts = { nativeCharName, nativeWorkName, fanworkSphere };
  const searchCtx = {
    fanworkName,
    charName,
    userLang,
    fanworkSphere,
    nativeCharName,
    nativeWorkName,
    originalName,
  };

  if (nativeCharName !== charName) {
    console.error(`[searchEngine] native name: ${charName} → ${nativeCharName} (sphere=${fanworkSphere})`);
  }

  // If user picked a specific engine, only use that + fallback
  let sourceIds;
  if (preferredEngine !== 'auto' && preferredEngine !== 'all') {
    sourceIds = [preferredEngine].filter((id) => SOURCES[id]);
    if (!sourceIds.includes('duckduckgo')) sourceIds.push('duckduckgo');
  } else if (preferredEngine === 'all') {
    sourceIds = Object.keys(SOURCES);
  } else {
    sourceIds = sourcePriority(fanworkSphere, userLang);
  }

  const allResults = [];
  const sourceDetails = []; // Detailed per-source log for UI
  const sourceMsgs = [];

  // Search in parallel across sources
  const promises = sourceIds.map(async (id) => {
    const src = SOURCES[id];
    if (!src) return;
    const queries = buildQueries(id, charName, fanworkName, queryOpts);
    let gotResults = false;
    for (const q of queries) {
      if (gotResults) break;
      try {
        const results = await src.search(q.trim(), ur, searchCtx);
        if (results.length > 0) {
          const tagged = results.map((r) => ({ ...r, source: id, fanworkName }));
          allResults.push(...tagged);
          // Build detailed log entry with query, source, and top result snippets
          const detail = {
            source: id,
            sourceLabel: src.label,
            query: q.trim(),
            count: results.length,
            topResults: results.slice(0, 3).map((r) => ({
              title: r.title,
              snippet: r.snippet,
              url: r.url,
            })),
          };
          sourceDetails.push(detail);
          sourceMsgs.push(`${src.label}: ${results.length}条`);
          gotResults = true;
        }
      } catch (err) {
        sourceDetails.push({ source: id, sourceLabel: src.label, query: queries[0] || '', count: 0, error: err.message || 'unknown' });
        sourceMsgs.push(`${src.label}: 错误(${err.message || 'unknown'})`);
        break; // don't retry other formats if this source is failing
      }
    }
    if (!gotResults && !sourceMsgs.some((m) => m.startsWith(`${src.label}:`))) {
      sourceDetails.push({ source: id, sourceLabel: src.label, query: queries[0] || '', count: 0 });
      sourceMsgs.push(`${src.label}: 0条`);
    }
  });

  await Promise.allSettled(promises);

  // Last-resort fallback: DuckDuckGo only if primary sources returned nothing
  if (allResults.length === 0 && preferredEngine === 'auto') {
    try {
      const ddQueries = buildQueries('duckduckgo', charName, fanworkName, queryOpts);
      let gotResults = false;
      for (const q of ddQueries) {
        if (gotResults) break;
        const results = await SOURCES.duckduckgo.search(q.trim(), ur);
        if (results.length > 0) {
          const tagged = results.map((r) => ({ ...r, source: 'duckduckgo', fanworkName }));
          allResults.push(...tagged);
          sourceDetails.push({
            source: 'duckduckgo',
            sourceLabel: SOURCES.duckduckgo.label,
            query: q.trim(),
            count: results.length,
            topResults: results.slice(0, 3).map((r) => ({ title: r.title, snippet: r.snippet, url: r.url })),
          });
          sourceMsgs.push(`${SOURCES.duckduckgo.label}: ${results.length}条 (last-resort fallback)`);
          gotResults = true;
        }
      }
      if (!gotResults) {
        sourceDetails.push({ source: 'duckduckgo', sourceLabel: SOURCES.duckduckgo.label, query: ddQueries[0] || '', count: 0 });
        sourceMsgs.push(`${SOURCES.duckduckgo.label}: 0条`);
      }
    } catch (err) {
      sourceDetails.push({ source: 'duckduckgo', sourceLabel: SOURCES.duckduckgo.label, query: charName, count: 0, error: err.message || 'unknown' });
      sourceMsgs.push(`${SOURCES.duckduckgo.label}: 错误(${err.message || 'unknown'})`);
    }
  }

  const dedupedResults = _dedupeResults(allResults);
  const sortedResults = _sortResultsBySourcePriority(dedupedResults, sourceIds);
  const rankedResults = rankSearchResults(sortedResults, { charName, fanworkName, nativeCharName });
  const sortedSourceDetails = _sortSourceDetailsByPriority(sourceDetails, sourceIds);
  console.error('[searchEngine] sources:', sourceMsgs.join(' | ') || '(none)', '→ total', rankedResults.length, 'results');
  return {
    results: rankedResults,
    errors: sourceMsgs,
    sourceDetails: sortedSourceDetails,
    nativeCharName,
    nativeWorkName,
  };
}

/**
 * Fetch the full page content of the best search result.
 * @returns {{ text: string, title: string, url: string, source: string }}
 */
async function fetchBestPage(results, userLang, context = {}) {
  const { charName = '', fanworkName = '', nativeCharName = '' } = context;
  const ranked = rankSearchResults(results, { charName, fanworkName, nativeCharName });
  const minLen = 200;

  for (const r of ranked) {
    if (JUNK_TITLE_RE.test(String(r.title || '')) || JUNK_URL_RE.test(String(r.url || ''))) continue;
    const fetchCtx = {
      fanworkName: r.fanworkName || fanworkName || r.sourceWork || '',
      charName,
      fandomHost: r.fandomHost,
      fandomLang: r.fandomLang,
      bangumiId: r.bangumiId,
    };
    let text = '';
    const src = SOURCES[r.source];

    if (src?.fetchPage && ['moegirl', 'biligame', 'wikipedia', 'fandom', 'bangumi'].includes(r.source)) {
      try {
        text = await src.fetchPage(r.title, userLang, fetchCtx);
      } catch { /* try URL fallback */ }
    }

    const candidateUrl = r.url && !JUNK_URL_RE.test(r.url) && !MERGED_HOST_URL_RE.test(r.url) ? r.url : '';
    if ((!text || text.length < minLen) && candidateUrl) {
      try {
        const maxChars = r.source === 'biligame' ? 24000 : (r.source === 'fandom' ? 20000 : 12000);
        const payload = await fetchWebPage(candidateUrl, { maxChars });
        if (payload.ok && payload.text.length >= minLen) text = payload.text;
      } catch { /* try next result */ }
    }

    if (text.length >= minLen && _pageTextRelevant(text, charName, fetchCtx.fanworkName, r.title, nativeCharName)) {
      return { text, title: r.title || '', url: r.url || '', source: r.source || '' };
    }
  }

  return { text: '', title: '', url: '', source: '' };
}

module.exports = {
  searchCharacter,
  searchWeb,
  fetchBestPage,
  fetchWebPage,
  SOURCES,
  sourcePriority,
  userRegion,
  scoreSearchResult,
  rankSearchResults,
  resolveBiligameWikiSlug,
};
