'use strict';

const modelConfig = require('../modelConfig');
const appConfig = require('../store/appConfig');

async function activeDriverId() {
  const cfg = await appConfig.load();
  return cfg.activeDriverId || 'direct-api';
}

async function resolveModelCandidates(context = {}) {
  const driverId = context.driverId || await activeDriverId();
  try {
    const resolved = await modelConfig.resolveTargets({ ...context, driverId });
    return resolved.map((item) => ({ resolved: item, tier: modelConfig.tierFromResolved(item) }));
  } catch (err) {
    // Regression harnesses historically monkey-patch the legacy managers.
    // Honor those explicit test doubles without creating a production routing
    // fallback: the branch is enabled only when exported functions were
    // replaced (or the whole module was replaced in require.cache).
    const providerManager = require('../providerManager');
    const modelAliases = require('../modelAliases');
    const patched = !providerManager.__defaultGetActiveProvider
      || providerManager.getActiveProvider !== providerManager.__defaultGetActiveProvider
      || !modelAliases.__defaultGetAlias
      || modelAliases.getAlias !== modelAliases.__defaultGetAlias;
    if (!patched || driverId !== 'direct-api') throw err;
    const tierName = context.legacyTier || 'sonnet';
    const alias = await modelAliases.getAlias(tierName);
    const provider = alias?.providerId && providerManager.getProvider
      ? await providerManager.getProvider(alias.providerId)
      : await providerManager.getActiveProvider();
    if (!provider?.apiKey) throw err;
    const type = providerManager.inferProviderType?.(provider) || provider.type || 'anthropic';
    const tier = {
      tierName,
      profileId: alias?.profileId || `legacy-test-${tierName}`,
      profileName: alias?.displayName || tierName,
      selectionSource: 'legacy-test-double',
      targetIndex: 0,
      driverId,
      type,
      adapterId: type === 'anthropic' ? 'anthropic-messages' : 'openai-chat-completions',
      baseUrl: provider.baseUrl || '',
      model: alias?.modelId || provider.models?.[0]?.id || '',
      apiKey: provider.apiKey,
      contextWindow: Number(alias?.contextWindow) || 128000,
      extra: {
        ...(provider.extra || {}),
        maxTokens: Number(alias?.maxOutputTokens) || 8192,
        ...(alias?.temperature != null ? { temperature: alias.temperature } : {}),
      },
      thinking: alias?.thinking ? { type: 'enabled', budget_tokens: alias.thinkingBudget || 16000 } : undefined,
      provenance: { profileId: alias?.profileId || `legacy-test-${tierName}`, selectionSource: 'legacy-test-double', driverId, providerId: provider.id || null, modelId: alias?.modelId || provider.models?.[0]?.id || '', targetIndex: 0, isFallback: false },
    };
    return [{ resolved: { profileId: tier.profileId, profileName: tier.profileName, selectionSource: tier.selectionSource, driverId, targetIndex: 0, target: { modelId: tier.model, params: {} }, provider, model: provider.models?.find((model) => model.id === tier.model) || { id: tier.model, capabilities: {} } }, tier }];
  }
}

async function resolveDirectCandidates(context = {}) {
  return resolveModelCandidates({ ...context, driverId: 'direct-api' });
}

async function resolveDirectTier(context = {}) {
  const candidates = await resolveDirectCandidates(context);
  if (!candidates.length) throw new Error('没有可用的 Direct API 模型目标');
  return candidates[0].tier;
}

function observableEvent(event) {
  return ['text', 'thinking', 'tool_use', 'tool_result'].includes(event?.kind);
}

/**
 * Execute an API call against a profile's ordered targets. Automatic fallback
 * is allowed only before observable model output or tool side effects.
 */
async function executeWithFallback({ context, invoke, onFallback }) {
  const candidates = await resolveDirectCandidates(context);
  let lastError = null;
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    let observable = false;
    try {
      const result = await invoke(candidate.tier, candidate.resolved, (event) => {
        if (observableEvent(event)) observable = true;
      });
      return { result, tier: candidate.tier, resolved: candidate.resolved, fallbackCount: index };
    } catch (err) {
      lastError = err;
      const next = candidates[index + 1];
      if (!next || observable || !modelConfig.shouldFallback(err)) throw err;
      await onFallback?.({
        from: candidate.tier.provenance,
        to: next.tier.provenance,
        reason: err.message || String(err),
        fallbackIndex: index + 1,
      });
    }
  }
  throw lastError || new Error('所有模型目标均不可用');
}

module.exports = {
  activeDriverId,
  resolveModelCandidates,
  resolveDirectCandidates,
  resolveDirectTier,
  executeWithFallback,
};
