'use strict';

/**
 * Parse skin/costume blocks and follow-up wiki links from BWiki/Moegirl HTML or plain text.
 */

const SKIN_SECTION_RE = /(?:^|\n)\s*(?:#{1,4}\s*)?(皮肤|时装|换装|立绘|衣装|服装)(?:\s*[:：]|\s*$)/im;
const SKIN_NAME_RE = /(?:皮肤|时装|换装)[:：\s]*([^\n|；;]{2,40})/gi;
const MAX_SKIN_PAGES = 6;

function _normalizeText(htmlOrText) {
  return String(htmlOrText || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function _sentenceSlice(text, maxLen = 180) {
  const cleaned = String(text || '').replace(/\s+/g, ' ').trim();
  if (!cleaned) return '';
  const cut = cleaned.match(/^(.{8,}?[。！？!?])/);
  return (cut?.[1] || cleaned.slice(0, maxLen)).trim();
}

function _extractBetween(text, startRe, endRe) {
  const start = text.search(startRe);
  if (start < 0) return '';
  const rest = text.slice(start);
  const end = rest.search(endRe);
  return (end >= 0 ? rest.slice(0, end) : rest).trim();
}

function _fieldAfter(block, label, stopLabels) {
  const labels = stopLabels.join('|');
  const re = new RegExp(`${label}\\s+([\\s\\S]{1,160}?)(?=\\s+(?:${labels})\\s|$)`);
  const m = block.match(re);
  return (m?.[1] || '').replace(/\s+/g, ' ').trim();
}

/**
 * Deterministically parse the compact role profile used by 鸣潮 BWiki pages.
 * These pages often expose reliable basic facts but little/no visual metadata;
 * keep unknown visual fields explicit so downstream completeness checks do not
 * force the LLM to invent hair, eye, or height values.
 *
 * @param {string} htmlOrText
 * @param {string} charName
 * @returns {Partial<{appearance:string, personality:string, background:string, height:string, quotes:string}>}
 */
function parseWutheringWavesProfile(htmlOrText, charName) {
  const text = _normalizeText(htmlOrText);
  const name = String(charName || '').trim();
  if (!text || !name || !text.includes(name)) return {};

  if (/配装与信息\s*-\s*鸣潮|Wuthering\s*\.gg/i.test(text)) {
    const guideIntro = text.match(new RegExp(`介绍\\s+鸣潮中的\\s+${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+是\\s+([\\s\\S]{10,260}?)(?=\\s+${name}\\s+配装|\\s+${name}\\s+的最佳|$)`));
    const intro = _sentenceSlice(guideIntro?.[1] || '', 220);
    const attr = (text.match(new RegExp(`${name}\\s+\\d★\\s+[^\\s]+\\s+[^\\s]+\\s+([^\\s]+)\\s+等级`))?.[1] || '').trim();
    const weapon = (text.match(new RegExp(`${name}\\s+\\d★\\s+([^\\s]+)\\s+[^\\s]+\\s+[^\\s]+\\s+等级`))?.[1] || '').trim();
    const facts = [
      attr && `属性为${attr}`,
      weapon && `武器为${weapon}`,
    ].filter(Boolean).join('；');
    if (!intro && !facts) return {};
    return {
      appearance: [
        '页面未明确提及发色、瞳色、身高/体型。',
        facts ? `基本资料显示：${facts}。` : '',
      ].filter(Boolean).join(''),
      personality: [intro, facts ? `页面定位信息显示其${facts}。` : ''].filter(Boolean).join(''),
      background: intro,
      quotes: intro,
    };
  }

  if (!text.includes('共鸣者')) return {};

  const profile = _extractBetween(
    text,
    new RegExp(`角色名\\s+${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
    /\s+(?:##\s*)?(?:服饰|基础属性|出招说明|技能详情)\s/
  );
  const head = _extractBetween(
    text,
    new RegExp(`基本资料\\s+${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
    /\s+(?:##\s*)?(?:服饰|基础属性|出招说明|技能详情)\s/
  );
  const block = profile || head;
  if (!block || block.length < 20) return {};

  const labels = ['角色名', '属性', '武器', '星级', '战斗风格', '特殊料理', '出生', '势力', '共鸣能力', '简介'];
  const attr = _fieldAfter(block, '属性', labels);
  const weapon = _fieldAfter(block, '武器', labels);
  const style = _fieldAfter(block, '战斗风格', labels).replace(/特殊料理.*$/, '').trim();
  const origin = _fieldAfter(block, '出生', labels);
  const faction = _fieldAfter(block, '势力', labels);
  const ability = _fieldAfter(block, '共鸣能力', labels);
  const introRaw = _fieldAfter(block, '简介', labels) || head.replace(/^基本资料\s+/, '').replace(name, '').trim();
  const intro = _sentenceSlice(introRaw, 220);

  const facts = [
    attr && `属性为${attr}`,
    weapon && `武器为${weapon}`,
    style && `战斗风格包括${style}`,
    origin && `出生地为${origin}`,
    faction && `势力为${faction}`,
    ability && `共鸣能力为${ability}`,
  ].filter(Boolean).join('；');
  if (!intro && !facts) return {};

  const appearance = [
    'BWiki 页面未明确提及发色、瞳色、身高/体型。',
    facts ? `基本资料显示：${facts}。` : '',
  ].filter(Boolean).join('');
  const personality = [intro, facts ? `页面定位信息显示其${facts}。` : ''].filter(Boolean).join('');
  const background = [intro, faction || origin ? `关联地区/势力：${[origin, faction].filter(Boolean).join('、')}。` : ''].filter(Boolean).join('');

  return {
    appearance,
    personality,
    background,
    height: '身高未明确',
    quotes: intro,
  };
}

/**
 * @param {string} htmlOrText
 * @returns {Array<{ name: string, outfit: string, story: string, quotes: string }>}
 */
function parseSkinBlocks(htmlOrText) {
  const text = _normalizeText(htmlOrText);
  if (!text) return [];

  const skins = [];
  const sectionMatch = text.match(SKIN_SECTION_RE);
  const sectionStart = sectionMatch ? text.indexOf(sectionMatch[0]) : -1;
  const slice = sectionStart >= 0 ? text.slice(sectionStart) : text;

  if (!/(皮肤|时装|换装|立绘)/.test(slice)) return [];

  const rowRe = /([^\n|；;]{2,24}(?:泳装|礼服|皮肤|时装|换装|立绘|衣装)?)\s*[|｜]\s*([^\n|；;]{4,120})(?:\s*[|｜]\s*([^\n|；;]{0,200}))?/g;
  let m;
  while ((m = rowRe.exec(slice)) !== null) {
    const name = (m[1] || '').trim();
    if (!name || name.length < 2) continue;
    if (/^(名称|皮肤名|时装名)/.test(name)) continue;
    skins.push({
      name,
      outfit: (m[2] || '').trim(),
      story: (m[3] || '').trim(),
      quotes: '',
    });
  }

  if (skins.length === 0) {
    const blocks = slice.split(/[；;\n]/).filter((line) => /泳装|礼服|皮肤|时装|换装/.test(line));
    for (const block of blocks.slice(0, 8)) {
      const parts = block.split(/[|｜]/).map((p) => p.trim()).filter(Boolean);
      if (parts.length >= 2) {
        skins.push({
          name: parts[0],
          outfit: parts[1] || '',
          story: parts[2] || '',
          quotes: parts[3] || '',
        });
      } else {
        let nm;
        SKIN_NAME_RE.lastIndex = 0;
        const nmMatch = SKIN_NAME_RE.exec(block);
        if (nmMatch) nm = nmMatch[1].trim();
        if (nm) {
          skins.push({ name: nm, outfit: block.replace(nm, '').trim(), story: '', quotes: '' });
        }
      }
    }
  }

  const seen = new Set();
  return skins.filter((s) => {
    const key = s.name;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Collect same-wiki skin sub-page URLs from HTML.
 * @param {string} html
 * @param {string} baseUrl
 * @param {number} [maxN]
 */
function collectSkinFollowUpUrls(html, baseUrl, maxN = MAX_SKIN_PAGES) {
  const urls = [];
  if (!html || !baseUrl) return urls;

  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return urls;
  }

  const host = parsed.hostname;
  const pathPrefix = parsed.pathname.split('/').slice(0, 2).join('/');
  const skinKw = /泳装|礼服|皮肤|时装|换装|立绘|衣装|夏日|冬日|旗袍|校服/;
  const hrefRe = /href=["']([^"']+)["']/gi;
  let m;
  while ((m = hrefRe.exec(html)) !== null) {
    let href = m[1];
    if (!href || href.startsWith('#')) continue;
    try {
      const abs = new URL(href, baseUrl);
      if (abs.hostname !== host) continue;
      if (!abs.pathname.startsWith(pathPrefix) && !abs.pathname.includes(parsed.pathname.split('/')[1])) continue;
      const label = decodeURIComponent(abs.pathname.split('/').pop() || '').replace(/_/g, ' ');
      if (!skinKw.test(label) && !skinKw.test(href)) continue;
      const u = abs.toString();
      if (!urls.includes(u)) urls.push(u);
    } catch { /* skip */ }
  }
  return urls.slice(0, maxN);
}

function pageHasMultipleSkins(pageText) {
  const text = _normalizeText(pageText);
  if (!/(皮肤|时装|换装|立绘)/.test(text)) return false;
  const names = parseSkinBlocks(pageText);
  if (names.length >= 2) return true;
  const markers = text.match(/泳装|礼服|皮肤\d|时装\d|换装/gi) || [];
  return markers.length >= 2;
}

function mergeSkinArrays(pageSkins, llmSkins) {
  const byName = new Map();
  for (const s of pageSkins || []) {
    if (s?.name) byName.set(s.name, { ...s });
  }
  for (const s of llmSkins || []) {
    if (!s?.name) continue;
    const prev = byName.get(s.name) || {};
    byName.set(s.name, {
      name: s.name,
      outfit: prev.outfit || s.outfit || '',
      story: prev.story || s.story || '',
      quotes: prev.quotes || s.quotes || s.scenario || '',
    });
  }
  return [...byName.values()];
}

module.exports = {
  parseSkinBlocks,
  parseWutheringWavesProfile,
  collectSkinFollowUpUrls,
  pageHasMultipleSkins,
  mergeSkinArrays,
  MAX_SKIN_PAGES,
};
