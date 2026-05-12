'use strict';

/**
 * Model alias manager — maps user-editable aliases (opus / sonnet / haiku)
 * to {providerId, modelId, params} so the same model can be assigned to
 * multiple aliases with different effort / thinking / token settings.
 */

const path = require('node:path');
const { readJson, writeJson } = require('../store/jsonStore');
const { paths: appPaths } = require('../store/paths');

const SCHEMA_VERSION = 1;

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

async function _load() {
  if (cache) return cache;
  const state = await readJson(_file(), null) || _defaultState();
  if (!Array.isArray(state.aliases)) state.aliases = [];
  state.schemaVersion = SCHEMA_VERSION;
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
  const idx = state.aliases.findIndex((a) => a.id === alias.id);
  if (idx >= 0) {
    state.aliases[idx] = { ...state.aliases[idx], ...alias };
  } else {
    state.aliases.push(alias);
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
