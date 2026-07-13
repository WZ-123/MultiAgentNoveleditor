'use strict';

/** Legacy Alias facade backed by semantic model profiles. */

const modelConfig = require('../modelConfig');

const TIERS = ['opus', 'sonnet', 'haiku'];

async function aliasForTier(tier) {
  const state = await modelConfig.load();
  const profileId = state.routing.legacyTierProfileMap?.[tier];
  const profile = state.profiles.find((item) => item.id === profileId);
  const target = profile?.targetsByDriver?.['direct-api']?.primary;
  if (!profile || !target) return null;
  const params = target.params || {};
  return {
    id: tier,
    displayName: profile.name,
    profileId: profile.id,
    providerId: target.providerId || null,
    modelId: target.modelId || '',
    contextWindow: params.contextLimit,
    maxOutputTokens: params.maxOutputTokens,
    thinking: !!params.thinking,
    thinkingBudget: params.thinkingBudget || 0,
    temperature: params.temperature,
    effortLevel: params.effortLevel,
  };
}

async function list() {
  return (await Promise.all(TIERS.map(aliasForTier))).filter(Boolean);
}

async function getAlias(id) {
  return aliasForTier(id);
}

async function saveAlias(alias) {
  if (!alias?.id || !TIERS.includes(alias.id)) throw new Error('saveAlias: legacy tier id required');
  const state = await modelConfig.load();
  const profileId = state.routing.legacyTierProfileMap?.[alias.id];
  const profile = state.profiles.find((item) => item.id === profileId);
  if (!profile) throw new Error(`Legacy profile for '${alias.id}' not found`);
  const next = JSON.parse(JSON.stringify(profile));
  const target = next.targetsByDriver?.['direct-api']?.primary;
  if (!target) throw new Error(`Legacy profile '${profile.name}' has no Direct API target`);
  target.providerId = alias.providerId || target.providerId;
  target.modelId = alias.modelId || target.modelId;
  target.params = {
    ...(target.params || {}),
    ...(alias.contextWindow != null ? { contextLimit: Number(alias.contextWindow) } : {}),
    ...(alias.maxOutputTokens != null ? { maxOutputTokens: Number(alias.maxOutputTokens) } : {}),
    ...(alias.temperature != null ? { temperature: Number(alias.temperature) } : {}),
    thinking: !!alias.thinking,
    thinkingBudget: Number(alias.thinkingBudget) || 0,
    effortLevel: alias.effortLevel || target.params?.effortLevel,
  };
  await modelConfig.saveProfile(next);
  return { ok: true };
}

async function deleteAlias(id) {
  throw new Error(`Alias '${id}' 是兼容映射，不能删除；请在模型中心修改或删除对应模型档案`);
}

async function resetToDefaults() {
  const state = await modelConfig.load();
  const defaults = {
    opus: ['claude-opus-4-7', { maxOutputTokens: 8192, temperature: 0.7, thinking: true, thinkingBudget: 32000, effortLevel: 'max' }],
    sonnet: ['claude-sonnet-4-6', { maxOutputTokens: 8192, temperature: 0.7, thinking: false, thinkingBudget: 0, effortLevel: 'high' }],
    haiku: ['claude-haiku-4-5-20251001', { maxOutputTokens: 4096, temperature: 0.9, thinking: false, thinkingBudget: 0, effortLevel: 'low' }],
  };
  await modelConfig.transaction((draft) => {
    for (const tier of TIERS) {
      const profileId = draft.routing.legacyTierProfileMap[tier];
      const profile = draft.profiles.find((item) => item.id === profileId);
      const target = profile?.targetsByDriver?.['direct-api']?.primary;
      if (!target) continue;
      target.providerId = 'anthropic';
      target.modelId = defaults[tier][0];
      target.params = { ...target.params, ...defaults[tier][1], contextLimit: 200000 };
    }
    return draft;
  }, state.revision);
  return { ok: true };
}

module.exports = { list, getAlias, saveAlias, deleteAlias, resetToDefaults, __defaultGetAlias: getAlias };
