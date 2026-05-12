'use strict';

const path = require('node:path');
const { paths } = require('./paths');
const { readJson, writeJson, listJsonFiles, deleteFile } = require('./jsonStore');
const { BUILTIN_SUBAGENTS, LEGACY_AGENT_TO_SUBAGENT } = require('../seeds/builtinSubagents');

const SCHEMA_VERSION = 1;

function builtinFile(id) {
  return path.join(paths().subagentsBuiltin, `${id}.json`);
}

function userFile(id) {
  return path.join(paths().subagentsUser, `${id}.json`);
}

async function ensureBuiltinSeeds() {
  for (const sa of BUILTIN_SUBAGENTS) {
    const file = builtinFile(sa.id);
    await writeJson(file, { ...sa, builtIn: true });
  }
}

async function listSubagents() {
  const out = [];
  for (const dir of [paths().subagentsBuiltin, paths().subagentsUser]) {
    const files = await listJsonFiles(dir);
    for (const f of files) {
      const obj = await readJson(f, null);
      if (obj && obj.id) out.push(obj);
    }
  }
  const seen = new Map();
  for (const sa of out) {
    if (!seen.has(sa.id) || sa.builtIn === false) seen.set(sa.id, sa);
  }
  return Array.from(seen.values());
}

async function getSubagent(id) {
  const all = await listSubagents();
  return all.find((s) => s.id === id) || null;
}

async function saveSubagent(sa) {
  if (!sa || !sa.id) throw new Error('subagent.id required');
  if (sa.builtIn) {
    throw new Error('Cannot overwrite builtin subagent; clone first.');
  }
  const next = { ...sa, builtIn: false, schemaVersion: SCHEMA_VERSION };
  await writeJson(userFile(sa.id), next);
  return next;
}

async function deleteSubagent(id) {
  await deleteFile(userFile(id));
}

async function cloneBuiltin(id, newId) {
  const all = await listSubagents();
  const src = all.find((s) => s.id === id && s.builtIn);
  if (!src) throw new Error(`builtin not found: ${id}`);
  const cloneId = newId || `${id}-copy-${Date.now().toString(36)}`;
  const clone = {
    ...src,
    id: cloneId,
    builtIn: false,
    displayName: `${src.displayName} (副本)`,
  };
  return saveSubagent(clone);
}

async function getSubagentByLegacyAgentId(legacyId) {
  const subagentId = LEGACY_AGENT_TO_SUBAGENT[legacyId];
  if (!subagentId) return null;
  return getSubagent(subagentId);
}

module.exports = {
  ensureBuiltinSeeds,
  listSubagents,
  getSubagent,
  saveSubagent,
  deleteSubagent,
  cloneBuiltin,
  getSubagentByLegacyAgentId,
  SCHEMA_VERSION,
};
