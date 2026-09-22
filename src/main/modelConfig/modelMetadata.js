'use strict';

const registry = require('./modelMetadataSnapshot.json');
const { templateById } = require('./providerTemplates');
const providersByHost = {
  'api.openai.com': 'openai', 'api.deepseek.com': 'deepseek',
  'api.anthropic.com': 'anthropic', 'api.moonshot.ai': 'moonshotai',
  'api.moonshot.cn': 'moonshotai-cn', 'api.kimi.com': 'moonshotai-cn',
};
// Exact origin/model matching: a relay or a similarly named model can impose
// different limits. Registry metadata is a declaration, never a probe result.
function enrichModel(model, baseUrl) {
  let host;
  try { const url = new URL(baseUrl); if (url.protocol !== 'https:' || url.port) return model; host = url.hostname; } catch { return model; }
  const provider = providersByHost[host];
  if (!provider) return model;
  const metadata = registry.providers[provider]?.[model.id];
  const contract = provider === 'deepseek' ? templateById('deepseek').codexModels?.[model.id] : null;
  const capabilities = { ...model.capabilities };
  const fieldSources = { ...model.fieldSources };
  const defaults = { ...metadata };
  // Effort names are protocol-specific: use the existing Responses contract,
  // not a generic registry's Chat Completions reasoning options.
  if (contract) { defaults.contextWindow = contract.contextWindow; defaults.reasoningEfforts = contract.reasoningEfforts; }
  for (const [field, value] of Object.entries(defaults)) {
    if (value == null || (Array.isArray(value) && !value.length) || fieldSources[field] === 'manual') continue;
    const current = capabilities[field];
    if (current != null && (!Array.isArray(current) || current.length)) continue;
    capabilities[field] = value;
    fieldSources[field] = contract && ['contextWindow', 'reasoningEfforts'].includes(field) ? 'official-catalog' : 'models.dev';
  }
  return { ...model, capabilities, fieldSources };
}
module.exports = { enrichModel };
