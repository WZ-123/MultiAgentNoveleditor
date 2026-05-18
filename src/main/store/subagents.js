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
  const builtinFiles = await listJsonFiles(paths().subagentsBuiltin);
  const userFiles = await listJsonFiles(paths().subagentsUser);

  const builtinMap = new Map();
  for (const f of builtinFiles) {
    const obj = await readJson(f, null);
    if (obj && obj.id) builtinMap.set(obj.id, obj);
  }

  const userMap = new Map();
  for (const f of userFiles) {
    const obj = await readJson(f, null);
    if (obj && obj.id) userMap.set(obj.id, obj);
  }

  const result = [];
  for (const [id, sa] of builtinMap) {
    if (userMap.has(id)) {
      // User has overridden this builtin — return the overridden data
      result.push({
        ...userMap.get(id),
        builtIn: true,
        isOverridden: true,
      });
    } else {
      result.push({
        ...sa,
        isOverridden: false,
      });
    }
  }
  for (const [id, sa] of userMap) {
    if (!builtinMap.has(id)) {
      result.push({ ...sa, isOverridden: false });
    }
  }

  return result;
}

async function getSubagent(id) {
  const all = await listSubagents();
  return all.find((s) => s.id === id) || null;
}

async function saveSubagent(sa) {
  if (!sa || !sa.id) throw new Error('subagent.id required');
  const next = { ...sa, schemaVersion: SCHEMA_VERSION };
  await writeJson(userFile(sa.id), next);
  return next;
}

async function deleteSubagent(id) {
  await deleteFile(userFile(id));
}

async function resetSubagent(id) {
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
  resetSubagent,
  cloneBuiltin,
  getSubagentByLegacyAgentId,
  SCHEMA_VERSION,
};
