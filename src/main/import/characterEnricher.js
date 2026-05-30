'use strict';

/**
 * Character Enricher — for fanworks, searches the web to auto-complete
 * character info using cultural-sphere-aware multi-source search.
 *
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║  搜索路由策略的单一真相源：knowledge-base/search-routing.md   ║
 * ║  Claude Code Skill 版本：.claude/skills/search-routing/      ║
 * ║  搜索引擎实现：searchEngine.js                                 ║
 * ║  修改本文件中的搜索逻辑时须同步更新上述文件，反之亦然。          ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * Flow:
 *   1. Detect cultural sphere of original work
 *   2. Route search to best sources per cultural routing rules
 *   3. Fetch page content from best result
 *   4. AI extract structured character info
 *   5. Merge with novel data (novel takes priority)
 *   6. Translate if source language ≠ user language
 */

const { searchCharacter, fetchBestPage, fetchWebPage, sourcePriority } = require('./searchEngine');
const { detectSphere, searchLanguage } = require('./culturalSphere');
const {
  parseSkinBlocks,
  parseWutheringWavesProfile,
  collectSkinFollowUpUrls,
  pageHasMultipleSkins,
  mergeSkinArrays,
} = require('./wikiContentParser');
const providerManager = require('../providerManager');
const modelAliases = require('../modelAliases');
const appConfig = require('../store/appConfig');

function pickProvider(type) {
  if (type === 'anthropic') return require('../runtime/providers/anthropic');
  if (type === 'openai-compat') return require('../runtime/providers/openaiCompat');
  throw new Error(`Unsupported provider: ${type}`);
}

async function _resolveProvider() {
  const alias = await modelAliases.getAlias('haiku');
  const providerId = alias?.providerId || null;
  const provider = providerId
    ? await providerManager.getProvider(providerId)
    : await providerManager.getActiveProvider();
  if (!provider) throw new Error('没有可用的 AI 服务商');
  const type = providerManager.inferProviderType(provider);
  return {
    provider: pickProvider(type),
    tier: { type, model: alias?.modelId || provider.models?.[0]?.id, apiKey: provider.apiKey, baseUrl: provider.baseUrl || '', extra: { maxTokens: 4096 } },
  };
}

function _parseJson(raw) {
  let cleaned = raw.replace(/```(?:json)?\s*/gi, '').replace(/```\s*$/g, '').trim();
  const brace = cleaned.indexOf('{');
  if (brace > 0) cleaned = cleaned.slice(brace);
  try { return JSON.parse(cleaned); } catch { /* fallback */ }
  const e = cleaned.lastIndexOf('}');
  if (e > 0) try { return JSON.parse(cleaned.slice(0, e + 1)); } catch { /* ignore */ }
  return null;
}

/** 提取结果与目标角色/作品明显不符时拒绝写入 */
function _validateWebInfo(charName, fanworkName, webInfo, pageMeta = {}) {
  if (!webInfo || typeof webInfo !== 'object') return false;
  const blob = JSON.stringify(webInfo);
  const quotes = String(webInfo.quotes || '');
  const appearance = String(webInfo.appearance || '');

  const rules = [
    { name: /尼可·?莱恩|尼可莱恩/, forbid: /莱卡恩|维多利亚家政|执事莱卡恩|狼希人/i },
    { name: /布伦妮/, forbid: /布伦希尔德|碧蓝航线/i },
    { name: /洛恩/, fanwork: /原神/, forbid: /冯·莱卡恩|绝区零/i },
  ];
  for (const rule of rules) {
    if (rule.name.test(charName) && rule.forbid.test(blob)) return false;
    if (rule.fanwork && rule.fanwork.test(fanworkName) && rule.forbid.test(blob)) return false;
  }

  if (/未明确提及|^[-—\s]*$/.test(appearance) && !webInfo.personality && !webInfo.hairColor) {
    return false;
  }

  const pageTitle = String(pageMeta.title || '');
  if (pageTitle && fanworkName && pageTitle === fanworkName && !pageTitle.includes(charName)) {
    return false;
  }

  if (quotes && charName) {
    const otherFranchise = [
      { work: '绝区零', token: '莱卡恩' },
      { work: '碧蓝航线', token: '布伦希尔德' },
    ];
    for (const item of otherFranchise) {
      if (fanworkName !== item.work && quotes.includes(item.token) && !charName.includes(item.token)) {
        return false;
      }
    }
  }

  return true;
}

function _normalizeForMatch(s) {
  return String(s || '')
    .replace(/[·・.\s]/g, '')
    .replace(/[（）()]/g, '')
    .toLowerCase();
}

function _fieldInPageText(fieldVal, pageText) {
  const val = String(fieldVal || '').trim();
  if (!val || val.length < 2) return true;
  const page = _normalizeForMatch(pageText);
  const core = _normalizeForMatch(val);
  if (page.includes(core)) return true;
  const tokens = val.split(/[、，,/\s]+/).filter((t) => t.length >= 2);
  return tokens.some((t) => page.includes(_normalizeForMatch(t)));
}

/** 完整度与页面锚定校验 */
function _validateCompleteness(charName, webInfo, pageText) {
  if (!webInfo) return { ok: false, reason: 'extract-empty' };
  const appearance = String(webInfo.appearance || '').trim();
  const quotes = String(webInfo.quotes || '').trim();
  const hair = String(webInfo.hairColor || '').trim();
  const eyes = String(webInfo.eyeColor || '').trim();
  const height = String(webInfo.height || '').trim();

  if (!appearance && !hair && !eyes && !String(webInfo.personality || '').trim()) {
    return { ok: false, reason: 'extract-empty' };
  }
  const hasQuotes = quotes || /台词|语录|口癖/.test(appearance);
  const hasPersonality = String(webInfo.personality || '').trim().length > 20;
  if (!hasQuotes && !hasPersonality && !appearance) return { ok: false, reason: 'extract-empty' };

  const hasHeight = height || String(webInfo.figure || '').trim() || /身高|体型|cm|米|体重/.test(appearance);
  const hairUnknown = /发型未明确|发色未明确|发色未知/.test(appearance);
  const eyeUnknown = /瞳色未明确|眼色未明确|眼睛.*未明确|未明确.*瞳色|未明确.*眼色/.test(appearance);
  const heightUnknown = /身高.*未明确|未明确.*身高|体型未明确/.test(appearance);
  if (!hair && !/发|毛色|发色|头发/.test(appearance) && !hairUnknown) {
    return { ok: false, reason: 'incomplete-base' };
  }
  if (!eyes && !/瞳|眼色|眼睛|眸|眼眸/.test(appearance) && !eyeUnknown) return { ok: false, reason: 'incomplete-base' };
  if (!hasHeight && !heightUnknown) return { ok: false, reason: 'incomplete-base' };
  if (!hasQuotes && !hasPersonality) return { ok: false, reason: 'incomplete-base' };

  for (const [field, val] of [['hairColor', hair], ['eyeColor', eyes], ['height', height]]) {
    if (!val || val.length < 2) continue;
    if (/未明确|未知|不详/.test(val)) continue;
    if (_fieldInPageText(val, pageText)) continue;
    if (appearance.includes(val) || (appearance.length > 40 && _fieldInPageText(val, appearance))) continue;
    return { ok: false, reason: 'extract-rejected' };
  }

  const webSkins = _parseSkins(webInfo.skins);
  const parsedPageSkins = parseSkinBlocks(pageText);
  if (pageHasMultipleSkins(pageText) && parsedPageSkins.length >= 2) {
    if (webSkins.length < 2) return { ok: false, reason: 'incomplete-skins' };
    for (const skin of webSkins) {
      if (!skin.name || !skin.outfit) return { ok: false, reason: 'incomplete-skins' };
      if (!skin.story && !skin.quotes) return { ok: false, reason: 'incomplete-skins' };
    }
  }

  return { ok: true, reason: 'success' };
}

function _mergeMissingWebInfo(webInfo, fallback) {
  const merged = { ...(webInfo || {}) };
  for (const [field, val] of Object.entries(fallback || {})) {
    const curr = String(merged[field] || '').trim();
    const next = String(val || '').trim();
    if (!curr && next) merged[field] = next;
  }
  const fallbackAppearance = String(fallback?.appearance || '').trim();
  const appearance = String(merged.appearance || '').trim();
  if (fallbackAppearance && appearance && !/未明确.*(?:发色|瞳色|身高)|(?:发色|瞳色|身高).*未明确/.test(appearance)) {
    merged.appearance = `${appearance}\n${fallbackAppearance}`;
  }
  return merged;
}

function _dropUnanchoredScalarFields(webInfo, pageText) {
  const next = { ...(webInfo || {}) };
  for (const field of ['hairColor', 'eyeColor', 'height']) {
    const val = String(next[field] || '').trim();
    if (!val || val.length < 2) continue;
    if (_fieldInPageText(val, pageText)) continue;
    if (String(next.appearance || '').includes(val)) continue;
    next[field] = '';
  }
  return next;
}

function _countSparseCoreFields(webInfo) {
  const fields = ['hairColor', 'eyeColor', 'height', 'personality', 'background', 'quotes'];
  return fields.filter((field) => !String(webInfo?.[field] || '').trim()).length;
}

function _needsSupplementalSources(primarySource, webInfo, completeness) {
  if (!webInfo) return true;
  if (!completeness?.ok && ['incomplete-base', 'extract-empty'].includes(completeness.reason)) return true;
  if (primarySource === 'bangumi' && _countSparseCoreFields(webInfo) >= 2) return true;
  return false;
}

function _mergeSupplementalWebInfo(baseInfo, supplementalInfo) {
  const merged = { ...(baseInfo || {}) };
  for (const field of ['appearance', 'personality', 'background', 'hairColor', 'eyeColor', 'height', 'figure', 'moeTraits', 'quotes']) {
    const curr = String(merged[field] || '').trim();
    const next = String(supplementalInfo?.[field] || '').trim();
    if (!curr && next) merged[field] = next;
  }

  const baseSkins = _parseSkins(merged.skins);
  const supplementalSkins = _parseSkins(supplementalInfo?.skins);
  if (baseSkins.length === 0 && supplementalSkins.length > 0) {
    merged.skins = supplementalSkins;
  }

  const baseAppearance = String(baseInfo?.appearance || '').trim();
  const nextAppearance = String(supplementalInfo?.appearance || '').trim();
  if (baseAppearance && nextAppearance && baseAppearance !== nextAppearance && !baseAppearance.includes(nextAppearance)) {
    merged.appearance = `${baseAppearance}\n${nextAppearance}`;
  }
  return merged;
}

async function _extractViaSpecificSource(sourceId, ch, { charName, fanworkName, sphere, srchLang, userLang, onProgress }) {
  const searchRes = await _retry(() => searchCharacter({
    charName,
    fanworkName,
    userLang: srchLang,
    fanworkSphere: sphere,
    preferredEngine: sourceId,
    originalName: ch.originalName || '',
  }), 1, `searchCharacter-${sourceId}(${charName})`);
  const results = searchRes.results || [];
  if (!results.length) return null;

  const pagePayload = await _retry(
    () => fetchBestPage(results, srchLang, {
      charName,
      fanworkName,
      nativeCharName: searchRes.nativeCharName || charName,
    }),
    1,
    `fetchBestPage-${sourceId}(${charName})`
  );
  if (!pagePayload?.text) return null;

  const fullPageText = await _appendSkinPages(pagePayload, fanworkName);
  const pageSkins = parseSkinBlocks(fullPageText);
  let webInfo = await _retry(
    () => _extractFromPage(charName, fullPageText, userLang, pageSkins),
    1,
    `extractFromPage-${sourceId}(${charName})`
  );
  const wutheringFallback = parseWutheringWavesProfile(fullPageText, charName);
  if (!webInfo && Object.keys(wutheringFallback).length) {
    webInfo = wutheringFallback;
  }
  if (!webInfo) return null;
  if (Object.keys(wutheringFallback).length) {
    webInfo = _mergeMissingWebInfo(webInfo, wutheringFallback);
  }
  webInfo = _dropUnanchoredScalarFields(webInfo, fullPageText);
  if (!_validateWebInfo(charName, fanworkName, webInfo, pagePayload)) return null;

  const completeness = _validateCompleteness(charName, webInfo, fullPageText);
  onProgress?.({ charName, status: 'extracting', message: `补源检测 ${sourceId}: ${completeness.reason}` });
  return { sourceId, searchRes, results, pagePayload, fullPageText, webInfo, completeness };
}

async function _supplementFromAlternateSources(ch, primary, ctx = {}) {
  const {
    fanworkName, sphere, srchLang, userLang, onProgress, charName,
  } = ctx;
  const ordered = sourcePriority(sphere, srchLang)
    .filter((id) => !['bing', 'duckduckgo'].includes(id))
    .filter((id) => id !== primary.pagePayload?.source);

  let mergedInfo = { ...(primary.webInfo || {}) };
  let evidencePages = [{ source: primary.pagePayload?.source || '', url: primary.pagePayload?.url || '' }];
  let latestCompleteness = primary.completeness;

  for (const sourceId of ordered) {
    if (!_needsSupplementalSources(primary.pagePayload?.source, mergedInfo, latestCompleteness)) break;
    onProgress?.({ charName, status: 'searching', message: `字段偏少，尝试补源: ${sourceId}` });
    let supplemental;
    try {
      supplemental = await _extractViaSpecificSource(sourceId, ch, { charName, fanworkName, sphere, srchLang, userLang, onProgress });
    } catch {
      supplemental = null;
    }
    if (!supplemental) continue;
    mergedInfo = _mergeSupplementalWebInfo(mergedInfo, supplemental.webInfo);
    latestCompleteness = _validateCompleteness(charName, mergedInfo, `${primary.fullPageText}\n${supplemental.fullPageText}`);
    evidencePages.push({ source: supplemental.pagePayload?.source || sourceId, url: supplemental.pagePayload?.url || '' });
  }

  return { webInfo: mergedInfo, completeness: latestCompleteness, evidencePages };
}

async function _appendSkinPages(pagePayload, fanworkName) {
  const base = pagePayload?.text || '';
  const url = pagePayload?.url || '';
  if (!base || !url) return base;

  let htmlSource = base;
  try {
    const raw = await fetchWebPage(url, { maxChars: 48000 });
    if (raw.ok && raw.text) htmlSource = raw.text;
  } catch { /* use existing text */ }

  const followUrls = collectSkinFollowUpUrls(htmlSource, url);
  const chunks = [base.slice(0, 12000)];
  for (const skinUrl of followUrls) {
    try {
      const sub = await fetchWebPage(skinUrl, { maxChars: 4000 });
      if (sub.ok && sub.text.length > 80) {
        chunks.push(`\n--- 时装子页 ${skinUrl} ---\n${sub.text}`);
      }
    } catch { /* skip */ }
  }
  return chunks.join('\n').slice(0, 24000);
}

async function _extractFromPage(charName, pageText, targetLang, pageSkins = []) {
  if (!pageText || pageText.length < 100) return null;
  const { provider, tier } = await _resolveProvider();
  const needTranslate = targetLang && !targetLang.startsWith('zh');
  const prompt = `从以下百科页面提取角色「${charName}」的详细信息，并整理为客观、结构化、专业的角色卡摘要。只输出 JSON 对象（${needTranslate ? `用${targetLang}输出` : ''}）：

{
  "appearance": "完整外貌描写（必须包含：发色、瞳色、身高/体型、常服/默认服装描述）",
  "hairColor": "发色",
  "eyeColor": "瞳色",
  "height": "身高/体型（如有官方数据）",
  "figure": "身材特点（如萌点中提及的体型特征）",
  "personality": "性格特征（具体表现，不要标签）",
  "background": "角色背景故事",
  "moeTraits": "萌点列表（逗号分隔，如：黑长直、腹黑、巨乳、傲娇）",
  "quotes": "常服/默认形态代表性台词（分号分隔，最多3句）",
  "skins": [{"name":"皮肤名","outfit":"妆造与服装","story":"剧情背景","quotes":"该皮肤代表性台词"}]
}

也可将 skins 输出为字符串：皮肤名|妆造|故事|台词；多套用分号分隔（与 JSON 数组二选一）。

注意：
- 重点关注官方设定，包括性格、发色、瞳色、萌点、台词、背景故事
- 如果角色有多个皮肤/形态，每个都要记录（名称、服装、故事、适用场景）
- 身材信息优先从官方公布的身高三维获取，没有时从萌点描述推断
- 只输出JSON，不要额外文字
- 输出必须客观、严谨、结构化，使用专业角色卡口径，不要使用口语化、段子风、吐槽式或玩梗式表达
- 只保留页面中已经明确确认的事实；不允许脑补、扩写、文学化润色或把弱线索包装成确定事实
- 若页面信息不完整或存在歧义，仅可提取页面中能直接确认的内容；不能自行推断未被明确写出的设定
- 优先从页面实际内容提取；未明确提及的信息留空

页面内容：
${pageText.slice(0, 24000)}`;

  try {
    const result = await provider.sendMessage({
      system: '', messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }], tools: [], tier,
    });
    const textBlock = (result.content || []).find((b) => b.type === 'text');
    const parsed = _parseJson(textBlock?.text || '');
    if (!parsed) return null;
    const llmSkins = _parseSkins(parsed.skins);
    if (pageSkins.length || llmSkins.length) {
      parsed.skins = mergeSkinArrays(pageSkins, llmSkins);
    }
    return parsed;
  } catch (err) {
    console.error('[enricher] AI extraction failed for', charName, ':', err.message);
    return null;
  }
}

// ── LLM-driven smart search (Phase 2) ────────────────────────────

const webSearchTool = {
  name: 'web_search',
  description: '在网络上搜索角色或作品的百科/维基信息。查询必须包含作品名和角色名以避免同名混淆（如"碧蓝航线 爱宕"）。',
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '搜索查询，建议格式："作品名 角色名" 或 "作品名:角色名"' }
    },
    required: ['query']
  }
};

function _parseSkins(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  const skins = [];
  for (const seg of String(raw).split(/[；;]/)) {
    const parts = seg.split('|');
    if (parts.length >= 2) {
      skins.push({
        name: parts[0]?.trim() || '',
        outfit: parts[1]?.trim() || '',
        story: parts[2]?.trim() || '',
        scenario: parts[3]?.trim() || '',
      });
    }
  }
  return skins;
}

function _mergeWebInfo(ch, webInfo, sourceTag, charName, onProgress, fanworkName) {
  const merged = { ...ch };
  let filledCount = 0;
  for (const field of ['appearance', 'personality', 'background', 'hairColor', 'eyeColor', 'height', 'figure', 'moeTraits', 'quotes']) {
    const novelVal = String(ch[field] || '').trim();
    const webVal = String(webInfo[field] || '').trim();
    if (!novelVal && webVal) {
      merged[field] = webVal;
      filledCount++;
    } else if (novelVal && webVal && novelVal !== webVal) {
      merged[field] = `${novelVal}\n（参考原作设定: ${webVal}）`;
      filledCount++;
    }
  }
  const novelSkins = Array.isArray(ch.skins) ? ch.skins : [];
  const webSkins = _parseSkins(webInfo.skins);
  if (novelSkins.length === 0 && webSkins.length > 0) {
    merged.skins = webSkins;
    filledCount++;
  }

  // 如果 webInfo 没有任何实质内容，标记为 extract-empty 而非 success
  if (filledCount === 0) {
    merged._enrichmentSource = sourceTag;
    merged._enrichmentStatus = 'extract-empty';
    onProgress?.({ charName, status: 'failed', message: 'AI提取结果为空（页面可能不含角色信息）' });
    return merged;
  }

  // 写入来源信息
  if (!merged.sourceWork && fanworkName) merged.sourceWork = fanworkName;
  if (!merged.originalName && charName !== merged.name) merged.originalName = charName;

  merged._enrichmentSource = sourceTag;
  merged._enrichmentStatus = 'success';
  onProgress?.({ charName, status: 'success', message: `补全成功 appearance=${!!webInfo.appearance} personality=${!!webInfo.personality} hair=${!!webInfo.hairColor} eyes=${!!webInfo.eyeColor} skins=${webSkins.length}` });
  return merged;
}

async function _enrichOneCharacterWithLLM(ch, { fanworkName, userLang, onProgress }) {
  const charName = ch.name || '';
  if (!charName) {
    onProgress?.({ charName: ch.id || '?', status: 'skipped', message: '无角色名' });
    return { ch, merged: null, status: 'no-name' };
  }

  onProgress?.({ charName, status: 'searching', message: `LLM智能搜索: ${charName} @《${fanworkName}》` });

  let provider, tier;
  try {
    const resolved = await _resolveProvider();
    provider = resolved.provider;
    tier = resolved.tier;
  } catch (err) {
    onProgress?.({ charName, status: 'failed', message: `无法获取AI服务商: ${err.message}` });
    return { ch, merged: null, status: 'llm-no-provider' };
  }

  const systemPrompt = `你是一个ACGN角色信息检索专家。用户会提供角色名和作品名。

任务：
1. 调用一次 web_search 搜索该角色（查询必须包含作品名）
2. 页面内容会自动抓取并提取为结构化数据
3. 搜索完成后，直接输出"搜索完成"，不需要额外内容

注意事项：
- 搜索查询不能是纯作品名或纯角色名，必须包含两者
- 只搜索一次`;

  const messages = [{
    role: 'user',
    content: [{ type: 'text', text: `作品：《${fanworkName}》\n角色：${charName}\n请搜索该角色的详细信息。` }]
  }];

  const maxTurns = 2;
  for (let turn = 0; turn < maxTurns; turn++) {
    try {
      const result = await provider.sendMessage({ system: systemPrompt, messages, tools: [webSearchTool], tier });
      messages.push({ role: 'assistant', content: result.content || [] });

      const toolUses = (result.content || []).filter((b) => b.type === 'tool_use');
      if (!toolUses.length) {
        onProgress?.({ charName, status: 'failed', message: 'LLM未执行联网搜索，已拒绝无证据补全' });
        return { ch, merged: null, status: 'llm-tool-required' };
      }

      // Process all tool calls — auto-extract page content after search
      let pageText = '';
      let lastSearchResults = [];
      for (const use of toolUses) {
        if (use.name === 'web_search') {
          const query = use.input?.query || '';
          onProgress?.({ charName, status: 'searching', message: `LLM搜索: ${query}` });
          const searchRes = await searchCharacter({
            charName: query,
            fanworkName: '',
            userLang,
            fanworkSphere: 'global',
            preferredEngine: 'all'
          });
          lastSearchResults = searchRes.results || [];
          const pagePayload = lastSearchResults.length > 0
            ? await fetchBestPage(lastSearchResults, userLang, { charName, fanworkName })
            : { text: '' };
          pageText = pagePayload?.text || '';
          const resultContent = pageText
            ? `页面内容（来源: ${lastSearchResults[0]?.source || '?'} | 标题: ${lastSearchResults[0]?.title || '?'}）:\n${pageText.slice(0, 8000)}`
            : `未找到相关页面。`;
          messages.push({
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: use.id, content: [{ type: 'text', text: resultContent }] }]
          });
        }
      }

      // Auto-extract: use _extractFromPage on the fetched page content
      // instead of relying on the LLM to produce JSON (which it often fails to do).
      if (pageText) {
        onProgress?.({ charName, status: 'extracting', message: 'AI提取角色信息' });
        const webInfo = await _extractFromPage(charName, pageText, userLang);
        if (webInfo) {
          const sourceTag = `llm-sphere=global sources=${lastSearchResults.map(r => r.source).filter((v,i,a)=>a.indexOf(v)===i).join(',')}`;
          const merged = _mergeWebInfo(ch, webInfo, sourceTag, charName, onProgress, fanworkName);
          const mergeStatus = merged._enrichmentStatus === 'extract-empty' ? 'extract-empty' : 'success';
          return { ch: merged, merged, status: mergeStatus };
        }
      }
    } catch (err) {
      console.error('[enricher] LLM search failed for', charName, ':', err.message);
      onProgress?.({ charName, status: 'failed', message: `LLM搜索错误: ${err.message}` });
      return { ch, merged: null, status: 'llm-error' };
    }
  }

  onProgress?.({ charName, status: 'failed', message: 'LLM搜索轮次超限' });
  return { ch, merged: null, status: 'llm-timeout' };
}

/**
 * Get fanwork name from world analysis output.
 */
function _getFanworkName(worldOutput) {
  if (!worldOutput) return null;
  try {
    const clean = worldOutput.replace(/```json\s*/gi, '').replace(/```\s*$/g, '').trim();
    const b = clean.indexOf('{'), e = clean.lastIndexOf('}');
    if (b >= 0 && e > b) {
      const p = JSON.parse(clean.slice(b, e + 1));
      if (p.possibleFanworkOf && p.possibleFanworkOf !== 'null' && p.possibleFanworkOf !== '原创作品') {
        return typeof p.possibleFanworkOf === 'string' ? p.possibleFanworkOf : String(p.possibleFanworkOf);
      }
    }
  } catch { /* ignore */ }
  return null;
}

/**
 * Run async tasks with a concurrency limit.
 * @param {Array<()=>Promise<any>>} tasks
 * @param {number} limit
 */
/**
 * Retry an async function with exponential backoff.
 * @param {()=>Promise<any>} fn
 * @param {number} maxRetries
 * @param {string} label - for logging
 */
async function _retry(fn, maxRetries = 2, label = '') {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries) {
        const delay = 1000 * Math.pow(2, attempt);
        console.error(`[enricher] ${label || 'retry'} failed (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${delay}ms:`, err.message);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastError;
}

async function _runWithConcurrency(tasks, limit) {
  if (limit <= 0) limit = 1;
  const results = [];
  const executing = [];
  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    const p = Promise.resolve().then(() => task());
    results.push(p);
    const e = p.then(() => {
      const idx = executing.indexOf(e);
      if (idx >= 0) executing.splice(idx, 1);
    });
    executing.push(e);
    if (executing.length >= limit) {
      await Promise.race(executing);
    }
  }
  return Promise.all(results);
}

/**
 * Enrich a single character. Isolated for concurrent execution.
 */
function _formatSourceDetails(sourceDetails) {
  if (!sourceDetails || !sourceDetails.length) return '';
  const lines = [];
  for (const d of sourceDetails) {
    if (d.error) {
      lines.push(`  [${d.sourceLabel}] 查询"${d.query}" → 错误: ${d.error}`);
    } else if (d.count === 0) {
      lines.push(`  [${d.sourceLabel}] 查询"${d.query}" → 0条结果`);
    } else {
      const top = d.topResults?.map((r, i) => `    #${i + 1} "${r.title}" — ${(r.snippet || '').slice(0, 80)}...`).join('\n') || '';
      lines.push(`  [${d.sourceLabel}] 查询"${d.query}" → ${d.count}条结果\n${top}`);
    }
  }
  return lines.join('\n');
}

async function _enrichOneCharacter(ch, { fanworkName, sphere, srchLang, preferredEngine, userLang, onProgress, searchCache }) {
  const charName = ch.name || '';
  if (!charName) {
    onProgress?.({ charName: ch.id || '?', status: 'skipped', message: '无角色名' });
    return { ch, merged: null, status: 'no-name' };
  }

  onProgress?.({ charName, status: 'searching', message: `搜索: ${charName} @《${fanworkName}》` });

  // Check in-memory cache for this batch
  const cacheKey = `${fanworkName}:${charName}:${srchLang}:${preferredEngine}`;
  let searchRes;
  if (searchCache?.has(cacheKey)) {
    searchRes = searchCache.get(cacheKey);
    onProgress?.({ charName, status: 'searching', message: `命中缓存: ${charName}` });
  } else {
    searchRes = await _retry(() => searchCharacter({
      charName,
      fanworkName,
      userLang: srchLang,
      fanworkSphere: sphere,
      preferredEngine,
      originalName: ch.originalName || '',
    }), 2, `searchCharacter(${charName})`);
    if (searchCache) searchCache.set(cacheKey, searchRes);
  }
  let results = searchRes.results || [];
  let searchErrors = searchRes.errors || [];
  let allSourceDetails = searchRes.sourceDetails || [];

  // Log detailed search results to UI
  const primaryLog = _formatSourceDetails(searchRes.sourceDetails);
  if (primaryLog) {
    onProgress?.({ charName, status: 'searching', message: `搜索结果详情:\n${primaryLog}` });
  }

  // Fallback 1: neighboring sphere
  if (!results.length || results.every(r => r.source === 'duckduckgo')) {
    const fallbackSpheres = { 'east-asian-cn': 'east-asian-jp', 'east-asian-jp': 'east-asian-cn', 'east-asian-kr': 'east-asian-jp', 'western-en': 'global' };
    const fbSphere = fallbackSpheres[sphere] || 'global';
    console.error(`[enricher] ${charName}: primary sphere returned ${results.length} results, trying fallback sphere ${fbSphere}`);
    onProgress?.({ charName, status: 'searching', message: `回退搜索 sphere=${fbSphere}` });
    const fbRes = await _retry(() => searchCharacter({ charName, fanworkName, userLang: 'en', fanworkSphere: fbSphere, preferredEngine: 'all' }), 2, `searchCharacter-fb(${charName})`);
    if (fbRes.results.length > 0) results = fbRes.results;
    searchErrors = searchErrors.concat(fbRes.errors || []);
    if (fbRes.sourceDetails?.length) {
      allSourceDetails = allSourceDetails.concat(fbRes.sourceDetails);
      const fbLog = _formatSourceDetails(fbRes.sourceDetails);
      onProgress?.({ charName, status: 'searching', message: `回退搜索结果:\n${fbLog}` });
    }
  }

  // Fallback 2: global DuckDuckGo
  if (!results.length) {
    console.error(`[enricher] ${charName}: all cultural sources failed, trying global DuckDuckGo`);
    onProgress?.({ charName, status: 'searching', message: '回退搜索 DuckDuckGo' });
    const ddRes = await _retry(() => searchCharacter({ charName, fanworkName, userLang: 'en', fanworkSphere: 'global', preferredEngine: 'duckduckgo' }), 2, `searchCharacter-ddg(${charName})`);
    results = ddRes.results;
    searchErrors = searchErrors.concat(ddRes.errors || []);
    if (ddRes.sourceDetails?.length) {
      allSourceDetails = allSourceDetails.concat(ddRes.sourceDetails);
      const ddLog = _formatSourceDetails(ddRes.sourceDetails);
      onProgress?.({ charName, status: 'searching', message: `DuckDuckGo结果:\n${ddLog}` });
    }
  }

  if (!results.length) {
    const errDetail = searchErrors.length ? ` (${searchErrors.join('; ')})` : '';
    const fullLog = _formatSourceDetails(allSourceDetails);
    console.error(`[enricher] ${charName}: all sources returned 0 results for "${charName}"${errDetail}\n${fullLog}`);
    onProgress?.({ charName, status: 'failed', message: `搜索无结果${errDetail}\n${fullLog}` });
    return { ch, merged: null, status: 'search-failed' };
  }

  onProgress?.({ charName, status: 'fetching', message: `获取页面: ${results[0]?.source} | 标题: ${results[0]?.title || '?'}` });

  let pagePayload = await _retry(
    () => fetchBestPage(results, srchLang, {
      charName,
      fanworkName,
      nativeCharName: searchRes.nativeCharName || charName,
    }),
    2,
    `fetchBestPage(${charName})`
  );
  if (!pagePayload?.text) {
    try {
      onProgress?.({ charName, status: 'searching', message: '页面为空，回退 Bing 精确搜索' });
      const bingRes = await _retry(
        () => searchCharacter({ charName, fanworkName, userLang: srchLang, fanworkSphere: sphere, preferredEngine: 'bing' }),
        1,
        `searchCharacter-bing(${charName})`
      );
      if (bingRes.results?.length) {
        pagePayload = await _retry(
          () => fetchBestPage(bingRes.results, srchLang, { charName, fanworkName }),
          1,
          `fetchBestPage-bing(${charName})`
        );
        if (pagePayload?.text) results = results.concat(bingRes.results || []);
      }
    } catch { /* keep original failure */ }
  }
  if (!pagePayload?.text) {
    onProgress?.({ charName, status: 'failed', message: '页面获取失败' });
    return { ch, merged: null, status: 'fetch-failed' };
  }

  const fullPageText = await _appendSkinPages(pagePayload, fanworkName);
  const pageSkins = parseSkinBlocks(fullPageText);

  onProgress?.({
    charName,
    status: 'fetching',
    message: `已抓取: ${pagePayload.source} | ${pagePayload.title || '?'} | 时装块=${pageSkins.length}`,
  });

  onProgress?.({ charName, status: 'extracting', message: 'AI提取角色信息' });

  let webInfo = await _retry(
    () => _extractFromPage(charName, fullPageText, userLang, pageSkins),
    2,
    `extractFromPage(${charName})`
  );
  const wutheringFallback = parseWutheringWavesProfile(fullPageText, charName);
  if (!webInfo) {
    if (Object.keys(wutheringFallback).length) {
      webInfo = wutheringFallback;
    } else {
      onProgress?.({ charName, status: 'failed', message: 'AI提取失败' });
      return { ch, merged: null, status: 'extract-failed' };
    }
  }
  if (Object.keys(wutheringFallback).length) {
    webInfo = _mergeMissingWebInfo(webInfo, wutheringFallback);
  }
  webInfo = _dropUnanchoredScalarFields(webInfo, fullPageText);

  if (!_validateWebInfo(charName, fanworkName, webInfo, pagePayload)) {
    onProgress?.({ charName, status: 'failed', message: '提取内容与角色/作品不匹配，已拒绝写入' });
    const rejected = { ...ch, _enrichmentStatus: 'extract-rejected', _enrichmentSource: pagePayload.source || '' };
    return { ch: rejected, merged: null, status: 'extract-rejected' };
  }

  let completeness = _validateCompleteness(charName, webInfo, fullPageText);
  let supplementalSources = [];
  if (_needsSupplementalSources(pagePayload.source, webInfo, completeness)) {
    const supplemented = await _supplementFromAlternateSources(ch, {
      webInfo,
      completeness,
      pagePayload,
      fullPageText,
    }, {
      fanworkName,
      sphere,
      srchLang,
      userLang,
      onProgress,
      charName,
    });
    webInfo = supplemented.webInfo;
    completeness = supplemented.completeness;
    supplementalSources = supplemented.evidencePages
      .map((p) => p.source)
      .filter(Boolean)
      .filter((v, i, a) => a.indexOf(v) === i)
      .filter((v) => v !== pagePayload.source);
    if (supplemented.evidencePages.length > 1) {
      onProgress?.({
        charName,
        status: 'extracting',
        message: `已进行交叉补源: ${supplemented.evidencePages.map((p) => p.source).join(' -> ')}`,
      });
    }
  }
  if (!completeness.ok && completeness.reason === 'extract-rejected') {
    onProgress?.({ charName, status: 'failed', message: '字段无法在页面中锚定，已拒绝' });
    const rejected = { ...ch, _enrichmentStatus: 'extract-rejected', _enrichmentSource: pagePayload.source || '' };
    return { ch: rejected, merged: null, status: 'extract-rejected' };
  }
  if (!completeness.ok && completeness.reason === 'incomplete-skins') {
    onProgress?.({ charName, status: 'failed', message: '页面含多套时装但提取不完整' });
    const rejected = { ...ch, _enrichmentStatus: 'incomplete-skins', _enrichmentSource: pagePayload.source || '' };
    return { ch: rejected, merged: null, status: 'incomplete-skins' };
  }
  if (!completeness.ok) {
    onProgress?.({ charName, status: 'failed', message: `字段不完整: ${completeness.reason}` });
    const rejected = { ...ch, _enrichmentStatus: completeness.reason, _enrichmentSource: pagePayload.source || '' };
    return { ch: rejected, merged: null, status: completeness.reason };
  }

  const sourceTag = `sphere=${sphere} sources=${results.map(r => r.source).filter((v,i,a)=>a.indexOf(v)===i).join(',')} page=${pagePayload.source}${supplementalSources.length ? ` supplement=${supplementalSources.join(',')}` : ''}`;
  const merged = _mergeWebInfo(ch, webInfo, sourceTag, charName, onProgress, fanworkName);
  merged._pageSnapshot = fullPageText.slice(0, 8000);
  merged._pageUrl = pagePayload.url || '';
  const mergeStatus = merged._enrichmentStatus === 'extract-empty' ? 'extract-empty' : 'success';
  return { ch, merged, status: mergeStatus };
}

/**
 * Enrich characters with web-searched info for fanworks.
 * Uses cultural sphere detection + multi-source search.
 * Characters are processed concurrently with a configurable limit.
 *
 * @param {Array} characters
 * @param {string} worldOutput - raw world analysis output (or null)
 * @param {string} userLang - user's language (e.g. 'zh-CN')
 * @param {Object} options
 * @param {string} [options.fanworkNameOverride] - override auto-detected fanwork name
 * @param {Function} [options.onProgress] - ({ charName, status, message }) => void
 */
async function enrichCharacters(characters, worldOutput, userLang = 'zh-CN', options = {}) {
  const { fanworkNameOverride, onProgress } = options;
  let fanworkName = fanworkNameOverride || _getFanworkName(worldOutput);

  if (!fanworkName) {
    console.error('[enricher] no fanwork detected, skipping');
    onProgress?.({ charName: '_all', status: 'skipped', message: '未检测到同人作品，跳过补全' });
    return characters;
  }

  onProgress?.({ charName: '_all', status: 'start', message: `开始补全 ${characters.length} 个角色`, total: characters.length });

  // 1. Detect cultural sphere
  const { sphere, source, label } = await detectSphere(fanworkName);
  console.error(`[enricher] fanwork="${fanworkName}" sphere="${sphere}" (${label}, ${source})`);
  onProgress?.({ charName: '_all', status: 'searching', message: `检测文化圈: ${sphere} (${label})` });

  // 2. Get user search engine preference and enrichment mode
  let preferredEngine = 'auto';
  let concurrency = 10;
  let enrichmentMode = 'traditional';
  try {
    const cfg = await appConfig.load();
    preferredEngine = cfg?.searchEngine || 'auto';
    concurrency = cfg?.enrichmentConcurrency ?? 3;
    enrichmentMode = cfg?.enrichmentMode || 'traditional';
  } catch { /* use default */ }

  // 3. Determine search language for this sphere+user combination
  const srchLang = searchLanguage(userLang, sphere);

  console.error(`[enricher] mode=${enrichmentMode} processing ${characters.length} characters with concurrency=${concurrency}`);
  onProgress?.({ charName: '_all', status: 'searching', message: `使用${enrichmentMode === 'llm' ? 'LLM智能' : '传统'}搜索模式` });

  // 4. In-memory search cache for this batch (avoids duplicate searches within the same enrichment run)
  const searchCache = new Map();

  // 5. Skip original characters and process the rest concurrently
  const enrichFn = enrichmentMode === 'llm'
    ? (ch) => _enrichOneCharacterWithLLM(ch, { fanworkName, userLang, onProgress })
    : (ch) => _enrichOneCharacter(ch, { fanworkName, sphere, srchLang, preferredEngine, userLang, onProgress, searchCache });
  const tasks = characters.map((ch) => () => {
    if (ch.isOriginal === true) {
      onProgress?.({ charName: ch.name || ch.id || '?', status: 'skipped', message: '原创角色，跳过补全' });
      return { ch, merged: null, status: 'skipped' };
    }
    if (ch._enrichmentStatus === 'success') {
      onProgress?.({ charName: ch.name || ch.id || '?', status: 'skipped', message: '已补全过，跳过重复补全' });
      return { ch, merged: null, status: 'already-enriched' };
    }
    return enrichFn(ch);
  });
  const results = await _runWithConcurrency(tasks, concurrency);

  // 5. Build enriched array preserving order
  const enriched = [];
  let successCount = 0;
  for (const res of results) {
    if (res.status === 'success' && res.merged) {
      enriched.push(res.merged);
      successCount++;
    } else if (res.status === 'already-enriched') {
      enriched.push({ ...res.ch });
      successCount++;
    } else {
      const ch = { ...res.ch };
      ch._enrichmentStatus = res.status;
      enriched.push(ch);
    }
  }

  const summaryMsg = `${characters.length} 个角色 → ${successCount} 补全成功, ${characters.length - successCount} 失败/跳过`;
  console.error(`[enricher] ${summaryMsg}`);
  onProgress?.({ charName: '_all', status: 'complete', message: summaryMsg, successCount, failCount: characters.length - successCount });
  return enriched;
}

module.exports = {
  enrichCharacters,
  _validateWebInfo,
  _validateCompleteness,
  _parseSkins,
  _fieldInPageText,
};
