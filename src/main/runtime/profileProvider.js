'use strict';

const modelConfig = require('../modelConfig');
const { resolveDirectCandidates } = require('./modelResolver');

function adapter(type) {
  if (type === 'anthropic') return require('./providers/anthropic');
  if (type === 'openai-compat') return require('./providers/openaiCompat');
  throw new Error(`Unsupported provider type: ${type}`);
}

function mergeTier(base, override = {}) {
  return {
    ...base,
    ...override,
    extra: { ...(base.extra || {}), ...(override.extra || {}) },
    thinking: override.thinking === undefined ? base.thinking : override.thinking,
  };
}

function parameterOverride(value = {}) {
  return {
    ...(value.extra ? { extra: value.extra } : {}),
    ...(value.thinking !== undefined ? { thinking: value.thinking } : {}),
  };
}

async function createProfileProvider(context, tierOverride = {}) {
  const candidates = await resolveDirectCandidates(context);
  if (!candidates.length) throw new Error('没有可用的模型档案目标');
  const primaryTier = mergeTier(candidates[0].tier, tierOverride);
  return {
    tier: primaryTier,
    candidates: candidates.map((candidate) => ({ ...candidate, tier: mergeTier(candidate.tier, tierOverride) })),
    provider: {
      async sendMessage(opts = {}) {
        let lastError = null;
        const mergedCandidates = candidates.map((candidate) => ({
          ...candidate,
          tier: mergeTier(candidate.tier, {
            ...parameterOverride(tierOverride),
            ...parameterOverride(opts.tier || {}),
            extra: { ...(tierOverride.extra || {}), ...(opts.tier?.extra || {}) },
          }),
        }));
        for (let index = 0; index < mergedCandidates.length; index += 1) {
          const candidate = mergedCandidates[index];
          let observable = false;
          try {
            return await adapter(candidate.tier.type).sendMessage({
              ...opts,
              tier: candidate.tier,
              onEvent: (event) => {
                if (['text', 'thinking', 'tool_use', 'tool_result'].includes(event?.kind)) observable = true;
                return opts.onEvent?.(event);
              },
            });
          } catch (err) {
            lastError = err;
            const next = mergedCandidates[index + 1];
            if (!next || observable || !modelConfig.shouldFallback(err)) throw err;
            await opts.onEvent?.({
              kind: 'model_fallback',
              data: { from: candidate.tier.provenance, to: next.tier.provenance, reason: err.message || String(err), fallbackIndex: index + 1 },
            });
          }
        }
        throw lastError || new Error('所有模型目标均不可用');
      },
    },
  };
}

module.exports = { createProfileProvider };
