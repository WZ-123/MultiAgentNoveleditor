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

// ── Source registry ──────────────────────────────────────────────

const SOURCES = {
  moegirl: {
    id: 'moegirl', label: '萌娘百科',
    regions: ['zh-CN', 'zh-TW'],
    async search(query) {
      const url = `https://moegirl.icu/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&srlimit=3`;
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      const json = await res.json();
      return (json?.query?.search || []).map((p) => ({
        title: p.title, snippet: (p.snippet || '').replace(/<[^>]+>/g, ''),
        url: `https://moegirl.icu/${encodeURIComponent(p.title)}`, source: 'moegirl',
      }));
    },
    async fetchPage(title) {
      const url = `https://moegirl.icu/api.php?action=parse&page=${encodeURIComponent(title)}&prop=text&format=json`;
      const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
      const json = await res.json();
      const html = json?.parse?.text?.['*'] || '';
      return html.replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ').trim();
    },
  },

  bing: {
    id: 'bing', label: 'Bing 搜索',
    regions: ['zh-CN', 'zh-TW', 'en-US', 'ja-JP', 'ko-KR', '*'],
    async search(query) {
      const url = `https://cn.bing.com/search?q=${encodeURIComponent(query)}`;
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        },
        signal: AbortSignal.timeout(10000),
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
          results.push({
            title: titleMatch[2].replace(/<[^>]+>/g, '').trim(),
            snippet: (snippetMatch ? snippetMatch[1] : '').replace(/<[^>]+>/g, '').trim(),
            url: titleMatch[1],
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
    async search(query, userLang) {
      const lang = userLang ? (this._lang(query, userLang)) : 'en';
      const url = `https://${lang}.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&srlimit=3&origin=*`;
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      const json = await res.json();
      return (json?.query?.search || []).map((p) => ({
        title: p.title, snippet: (p.snippet || '').replace(/<[^>]+>/g, ''),
        url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(p.title)}`, source: 'wikipedia',
      }));
    },
    async fetchPage(title, userLang) {
      const lang = userLang || 'en';
      const url = `https://${lang}.wikipedia.org/w/api.php?action=query&prop=extracts&exintro&explaintext&titles=${encodeURIComponent(title)}&format=json&origin=*`;
      const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
      const json = await res.json();
      const pages = json?.query?.pages || {};
      return Object.values(pages)[0]?.extract || '';
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
    'east-asian-cn': ['moegirl', 'bing', 'wikipedia'],
    'east-asian-jp': ['wikipedia', 'moegirl', 'bing'],
    'east-asian-kr': ['wikipedia', 'bing', 'moegirl'],
    'western-en': ['wikipedia', 'bing'],
    'global': ['wikipedia', 'bing'],
  };
  const primary = sphereSources[fanworkSphere] || ['wikipedia'];
  const fallback = ['duckduckgo'];
  return [...primary, ...fallback.filter((s) => !primary.includes(s))];
}

// ── Public API ───────────────────────────────────────────────────

/**
 * Build source-specific search query that includes fanwork context.
 * This prevents ambiguous results (e.g. "HK416" → firearm vs "少女前线 HK416" → character).
 */
function buildQueries(sourceId, charName, fanworkName) {
  if (!fanworkName || !charName) return [charName || fanworkName || ''];
  if (sourceId === 'moegirl') {
    // Moegirl uses "Work:Character" naming convention (e.g. 碧蓝航线:爱宕)
    return [`${fanworkName}:${charName}`, `${fanworkName} ${charName}`];
  }
  if (sourceId === 'wikipedia') {
    return [`${charName} ${fanworkName} character`, `${charName} ${fanworkName}`];
  }
  // bing / duckduckgo
  return [`${charName} ${fanworkName} character wiki`, `${charName} ${fanworkName}`];
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
async function searchCharacter({ charName, fanworkName, userLang = 'zh-CN', fanworkSphere = 'east-asian-cn', preferredEngine = 'auto' }) {
  const ur = userRegion(userLang);

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
    const queries = buildQueries(id, charName, fanworkName);
    let gotResults = false;
    for (const q of queries) {
      if (gotResults) break;
      try {
        const results = await src.search(q.trim(), ur);
        if (results.length > 0) {
          const tagged = results.map((r) => ({ ...r, source: id }));
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
  console.error('[searchEngine] sources:', sourceMsgs.join(' | ') || '(none)', '→ total', allResults.length, 'results');
  return { results: allResults, errors: sourceMsgs, sourceDetails };
}

/**
 * Fetch the full page content of the best search result.
 * @returns {string} page text, or empty string
 */
async function fetchBestPage(results, userLang) {
  // Priority sources: wiki/encyclopedia sites that usually have character info.
  // Since parallel search may reorder results (fast engines like Bing resolve first),
  // we explicitly try higher-quality sources before generic search results.
  const wikiSources = ['moegirl', 'wikipedia', 'baike'];
  const wikiResults = results.filter((r) => wikiSources.includes(r.source));
  const otherResults = results.filter((r) => !wikiSources.includes(r.source));

  for (const r of [...wikiResults, ...otherResults]) {
    const src = SOURCES[r.source];
    if (!src?.fetchPage) continue;
    try {
      const text = await src.fetchPage(r.title, userLang);
      if (text && text.length > 200) return text;
    } catch { /* try next */ }
  }
  return '';
}

module.exports = { searchCharacter, fetchBestPage, SOURCES, sourcePriority, userRegion };
