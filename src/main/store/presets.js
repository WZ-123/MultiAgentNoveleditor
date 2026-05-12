'use strict';

const path = require('node:path');
const { paths, generateId } = require('./paths');
const { readJson, writeJson, listJsonFiles, deleteFile } = require('./jsonStore');

const SCHEMA_VERSION = 1;

function defaultPreset() {
  return {
    id: generateId('preset'),
    name: '默认 Preset',
    schemaVersion: SCHEMA_VERSION,
    tiers: {
      opus: { type: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-opus-4-7', apiKeyRef: '', extra: {} },
      sonnet: { type: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-4-6', apiKeyRef: '', extra: {} },
      haiku: { type: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-haiku-4-5-20251001', apiKeyRef: '', extra: {} },
    },
  };
}

function presetFile(id) {
  return path.join(paths().presets, `${id}.json`);
}

async function listPresets() {
  const files = await listJsonFiles(paths().presets);
  const out = [];
  for (const f of files) {
    const obj = await readJson(f, null);
    if (obj && obj.id) out.push(obj);
  }
  return out;
}

async function getPreset(id) {
  return readJson(presetFile(id), null);
}

async function savePreset(preset) {
  if (!preset || !preset.id) throw new Error('preset.id required');
  const next = { ...preset, schemaVersion: SCHEMA_VERSION };
  await writeJson(presetFile(preset.id), next);
  return next;
}

async function deletePreset(id) {
  await deleteFile(presetFile(id));
}

async function ensureSeed() {
  const list = await listPresets();
  if (list.length > 0) return list[0];
  const seed = defaultPreset();
  await savePreset(seed);
  return seed;
}

module.exports = {
  defaultPreset,
  listPresets,
  getPreset,
  savePreset,
  deletePreset,
  ensureSeed,
  SCHEMA_VERSION,
};
