'use strict';

/**
 * Model alias manager — maps user-editable aliases (opus / sonnet / haiku)
 * to {providerId, modelId, params} so the same model can be assigned to
 * multiple aliases with different effort / thinking / token settings.
 */

const path = require('node:path');
const providerManager = require('../providerManager');
const { readJson, writeJson } = require('../store/jsonStore');
const { paths: appPaths } = require('../store/paths');

const SCHEMA_VERSION = 2;

let cache = null;

function _file() {
  return path.join(appPaths().root, 'modelAliases.json');
}

function _defaultAliases() {
  return [
    {
      id: 'opus',
      displayName: 'Opus',
      providerId: 'anthropic',
      modelId: 'claude-opus-4-7',
      contextWindow: 200000,
      maxOutputTokens: 8192,
      thinking: true,
      thinkingBudget: 32000,
      temperature: 0.7,
      effortLevel: 'max',
    },
    {
      id: 'sonnet',
      displayName: 'Sonnet',
      providerId: 'anthropic',
      modelId: 'claude-sonnet-4-6',
      contextWindow: 200000,
      maxOutputTokens: 8192,
      thinking: false,
      thinkingBudget: 0,
      temperature: 0.7,
      effortLevel: 'high',
    },
    {
      id: 'haiku',
      displayName: 'Haiku',
      providerId: 'anthropic',
      modelId: 'claude-haiku-4-5-20251001',
      contextWindow: 200000,
      maxOutputTokens: 4096,
      thinking: false,
      thinkingBudget: 0,
      temperature: 0.9,
      effortLevel: 'low',
    },
  ];
}

function _defaultState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    aliases: _defaultAliases(),
  };
}

function _defaultAliasById(id) {
  return _defaultAliases().find((alias) => alias.id === id) || null;
}

async function _normalizeAlias(alias) {
  if (!alias || typeof alias !== 'object' || !alias.id) return null;
  const defaults = _defaultAliasById(alias.id);
  const normalized = {
    ...(defaults || {}),
    ...alias,
  };

  if (typeof normalized.providerId === 'string' && normalized.providerId.trim()) {
    const provider = await providerManager.getProvider(normalized.providerId);
    normalized.providerId = provider?.id || normalized.providerId.trim();
  } else if (defaults?.providerId) {
    normalized.providerId = defaults.providerId;
  }

  if (!normalized.displayName && defaults?.displayName) normalized.displayName = defaults.displayName;
  if (!normalized.modelId && defaults?.modelId) normalized.modelId = defaults.modelId;
  if (normalized.contextWindow == null && defaults?.contextWindow != null) normalized.contextWindow = defaults.contextWindow;
  if (normalized.maxOutputTokens == null && defaults?.maxOutputTokens != null) normalized.maxOutputTokens = defaults.maxOutputTokens;
  if (normalized.thinking == null && defaults?.thinking != null) normalized.thinking = defaults.thinking;
  if (normalized.thinkingBudget == null && defaults?.thinkingBudget != null) normalized.thinkingBudget = defaults.thinkingBudget;
  if (normalized.temperature == null && defaults?.temperature != null) normalized.temperature = defaults.temperature;
  if (!normalized.effortLevel && defaults?.effortLevel) normalized.effortLevel = defaults.effortLevel;

  return normalized;
}

async function _load() {
  if (cache) return cache;
  const file = _file();
  const savedState = await readJson(file, null);
  const state = savedState || _defaultState();
  let changed = !savedState || savedState.schemaVersion !== SCHEMA_VERSION;
  if (!Array.isArray(state.aliases)) {
    state.aliases = [];
    changed = true;
  }
  const normalizedAliases = [];
  for (const alias of state.aliases) {
    const normalized = await _normalizeAlias(alias);
    if (!normalized) {
      changed = true;
      continue;
    }
    if (JSON.stringify(normalized) !== JSON.stringify(alias)) changed = true;
    normalizedAliases.push(normalized);
  }
  state.aliases = normalizedAliases;
  state.schemaVersion = SCHEMA_VERSION;
  if (changed) {
    await writeJson(file, state);
  }
  cache = state;
  return state;
}

async function _save(state) {
  await writeJson(_file(), state);
  cache = state;
}

// ---------- Public API ----------

async function list() {
  const state = await _load();
  return state.aliases;
}

async function getAlias(id) {
  const state = await _load();
  return state.aliases.find((a) => a.id === id) || null;
}

async function saveAlias(alias) {
  if (!alias || !alias.id) throw new Error('saveAlias: alias.id required');
  const state = await _load();
  const normalizedAlias = await _normalizeAlias(alias);
  if (!normalizedAlias) throw new Error('saveAlias: alias.id required');
  const idx = state.aliases.findIndex((a) => a.id === alias.id);
  if (idx >= 0) {
    state.aliases[idx] = { ...state.aliases[idx], ...normalizedAlias };
  } else {
    state.aliases.push(normalizedAlias);
  }
  await _save(state);
  return { ok: true };
}

async function deleteAlias(id) {
  const state = await _load();
  const idx = state.aliases.findIndex((a) => a.id === id);
  if (idx === -1) throw new Error(`Alias '${id}' not found`);
  state.aliases.splice(idx, 1);
  await _save(state);
  return { ok: true };
}

async function resetToDefaults() {
  const state = { schemaVersion: SCHEMA_VERSION, aliases: _defaultAliases() };
  await _save(state);
  return { ok: true };
}

module.exports = {
  list,
  getAlias,
  saveAlias,
  deleteAlias,
  resetToDefaults,
};
