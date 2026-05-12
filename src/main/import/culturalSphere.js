'use strict';

/**
 * Cultural Sphere Detection — determines which cultural region(s) an
 * original work is most popular in, based on web search results and
 * known IP databases.
 */

const { SOURCES } = require('./searchEngine');

// Known IP → sphere mapping (baked-in for speed, updated via search results)
const KNOWN_IPS = new Map([
  // 碧蓝航线 / Azur Lane — Chinese-developed, popular in CN/JP/KR
  ['azur lane', 'east-asian-cn'],
  ['碧蓝航线', 'east-asian-cn'],
  // 明日方舟 / Arknights
  ['arknights', 'east-asian-cn'],
  ['明日方舟', 'east-asian-cn'],
  // 原神 / Genshin Impact
  ['genshin impact', 'east-asian-cn'],
  ['原神', 'east-asian-cn'],
  // 蔚蓝档案 / Blue Archive — Korean-developed, popular in JP/KR/CN
  ['blue archive', 'east-asian-kr'],
  ['蔚蓝档案', 'east-asian-kr'],
  ['ブルーアーカイブ', 'east-asian-jp'],
  // Fate series
  ['fate', 'east-asian-jp'],
  ['fate/stay night', 'east-asian-jp'],
  // 东方Project / Touhou
  ['touhou', 'east-asian-jp'],
  ['東方', 'east-asian-jp'],
  // 舰娘 / Kantai Collection
  ['kantai collection', 'east-asian-jp'],
  ['艦隊これくしょん', 'east-asian-jp'],
  // 崩坏系列 / Honkai
  ['honkai', 'east-asian-cn'],
  ['崩坏', 'east-asian-cn'],
  // 鬼灭之刃 / Demon Slayer
  ['demon slayer', 'east-asian-jp'],
  ['鬼滅の刃', 'east-asian-jp'],
  // 原神 / Genshin
  ['genshin', 'east-asian-cn'],
  // 赛马娘 / Uma Musume
  ['uma musume', 'east-asian-jp'],
  ['ウマ娘', 'east-asian-jp'],
  // 崩坏星穹铁道 / Honkai Star Rail
  ['star rail', 'east-asian-cn'],
  ['星穹铁道', 'east-asian-cn'],
  // 进击的巨人 / Attack on Titan
  ['attack on titan', 'east-asian-jp'],
  ['進撃の巨人', 'east-asian-jp'],
  // 最终幻想 / Final Fantasy
  ['final fantasy', 'east-asian-jp'],
  // 塞尔达 / Zelda
  ['zelda', 'east-asian-jp'],
  ['塞尔达', 'east-asian-jp'],
  // 宝可梦 / Pokemon
  ['pokemon', 'east-asian-jp'],
  ['宝可梦', 'east-asian-jp'],
  // LOL / League of Legends
  ['league of legends', 'global'],
  ['英雄联盟', 'global'],
  // 魔兽世界 / World of Warcraft
  ['world of warcraft', 'western-en'],
  ['魔兽世界', 'western-en'],
  // 哈利波特 / Harry Potter
  ['harry potter', 'western-en'],
  // 漫威 / Marvel
  ['marvel', 'western-en'],
  ['漫威', 'western-en'],
  // DC
  ['dc comics', 'western-en'],
  // 星球大战 / Star Wars
  ['star wars', 'western-en'],
  // 巫师 / The Witcher
  ['witcher', 'western-en'],
  ['巫师', 'western-en'],
  // 黑神话悟空 / Black Myth Wukong
  ['black myth', 'east-asian-cn'],
  ['黑神话', 'east-asian-cn'],
]);

// Sphere metadata
const SPHERE_INFO = {
  'east-asian-cn': { label: '东亚（中国）', regions: ['zh-CN', 'zh-TW'] },
  'east-asian-jp': { label: '东亚（日本）', regions: ['ja-JP'] },
  'east-asian-kr': { label: '东亚（韩国）', regions: ['ko-KR'] },
  'western-en': { label: '欧美', regions: ['en-US'] },
  'global': { label: '全球', regions: ['en-US', 'zh-CN', 'ja-JP'] },
};

/**
 * Check known IP database first.
 * @returns {string|null} sphere id or null
 */
function lookupKnown(fanworkName) {
  if (!fanworkName) return null;
  const lower = fanworkName.toLowerCase().trim();
  for (const [key, sphere] of KNOWN_IPS) {
    if (lower.includes(key) || key.includes(lower)) return sphere;
  }
  return null;
}

/**
 * Search the web to determine which cultural sphere a work belongs to.
 * Uses Wikipedia and DuckDuckGo to find popularity signals.
 * @returns {string} sphere id
 */
async function detectFromWeb(fanworkName) {
  // Try Wikipedia first for language coverage
  try {
    const wp = SOURCES.wikipedia;
    const results = await wp.search(fanworkName, 'en');
    if (results.length > 0) {
      const extract = await wp.fetchPage(results[0].title, 'en');
      // Check for language-specific signals in the extract
      const lowercase = extract.toLowerCase();
      if (lowercase.includes('japanese') || lowercase.includes('manga') || lowercase.includes('anime')) {
        return 'east-asian-jp';
      }
      if (lowercase.includes('chinese') || lowercase.includes('manhua') || lowercase.includes('donghua')) {
        return 'east-asian-cn';
      }
      if (lowercase.includes('korean') || lowercase.includes('manhwa') || lowercase.includes('webtoon')) {
        return 'east-asian-kr';
      }
    }
  } catch { /* fallback */ }

  // Try DuckDuckGo as fallback
  try {
    const ddg = SOURCES.duckduckgo;
    const results = await ddg.search(`${fanworkName} origin country wiki`);
    const text = results.map((r) => r.snippet).join(' ').toLowerCase();
    if (text.includes('japan') || text.includes('japanese')) return 'east-asian-jp';
    if (text.includes('china') || text.includes('chinese')) return 'east-asian-cn';
    if (text.includes('korea') || text.includes('korean')) return 'east-asian-kr';
    if (text.includes('american') || text.includes('europe')) return 'western-en';
  } catch { /* fallback */ }

  return 'global';
}

/**
 * Determine the cultural sphere of a fanwork.
 * Checks known IP database first, then falls back to web detection.
 *
 * @param {string} fanworkName - the identified original work name
 * @returns {{ sphere: string, source: 'known'|'detected', label: string }}
 */
async function detectSphere(fanworkName) {
  // 1. Check known database
  const known = lookupKnown(fanworkName);
  if (known) {
    return { sphere: known, source: 'known', label: SPHERE_INFO[known]?.label || known };
  }

  // 2. Try web detection
  const detected = await detectFromWeb(fanworkName);
  return { sphere: detected, source: 'detected', label: SPHERE_INFO[detected]?.label || detected };
}

/**
 * Get the recommended search language for a character based on cultural
 * routing. If the work's cultural sphere overlaps with the user's region,
 * use user's language. Otherwise use the sphere's primary language.
 */
function searchLanguage(userLang, sphere) {
  const info = SPHERE_INFO[sphere];
  if (!info) return userLang || 'zh-CN';
  const ur = userLang || 'zh-CN';
  if (info.regions.some((r) => ur.startsWith(r.split('-')[0]))) {
    return ur;
  }
  return info.regions[0] || 'en-US';
}

module.exports = { detectSphere, searchLanguage, lookupKnown, SPHERE_INFO };
