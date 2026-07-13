'use strict';

const path = require('node:path');
const { paths } = require('./paths');
const { readJson, writeJson, listJsonFiles, deleteFile } = require('./jsonStore');
const { BUILTIN_DAGS, SCHEMA_VERSION } = require('../seeds/builtinDags');

const LEGACY_PROFILE_MAP = {
  opus: 'profile-deep-reasoning',
  sonnet: 'profile-longform-writing',
  haiku: 'profile-fast-utility',
};

function normalizeDag(dag) {
  if (!dag || typeof dag !== 'object') return dag;
  return {
    ...dag,
    nodes: (dag.nodes || []).map((node) => ({
      ...node,
      modelProfileId: node.modelProfileId || LEGACY_PROFILE_MAP[node.tierOverride] || undefined,
    })),
    schemaVersion: SCHEMA_VERSION,
  };
}

function builtinFile(id) {
  return path.join(paths().pipelinesBuiltin, `${id}.json`);
}

function userFile(id) {
  return path.join(paths().pipelinesUser, `${id}.json`);
}

async function ensureBuiltinSeeds() {
  for (const dag of BUILTIN_DAGS) {
    const file = builtinFile(dag.id);
    const existing = await readJson(file, null);
    if (!existing || existing.schemaVersion !== dag.schemaVersion) {
      await writeJson(file, normalizeDag({ ...dag, builtIn: true }));
    }
  }
}

async function listDags() {
  const out = [];
  for (const dir of [paths().pipelinesBuiltin, paths().pipelinesUser]) {
    const files = await listJsonFiles(dir);
    for (const f of files) {
      const obj = await readJson(f, null);
      if (obj && obj.id) out.push(normalizeDag(obj));
    }
  }
  // user override > builtin if same id (clones use new ids so this rarely matters)
  const seen = new Map();
  for (const d of out) {
    if (!seen.has(d.id) || d.builtIn === false) seen.set(d.id, d);
  }
  return Array.from(seen.values());
}

async function getDag(id) {
  const all = await listDags();
  return all.find((d) => d.id === id) || null;
}

async function saveDag(dag) {
  if (!dag || !dag.id) throw new Error('dag.id required');
  if (dag.builtIn) {
    throw new Error('Cannot overwrite builtin DAG; clone first.');
  }
  const next = normalizeDag({ ...dag, builtIn: false });
  await writeJson(userFile(dag.id), next);
  return next;
}

async function deleteDag(id) {
  await deleteFile(userFile(id));
}

async function cloneDag(id, newId, newName) {
  const all = await listDags();
  const src = all.find((d) => d.id === id);
  if (!src) throw new Error(`dag not found: ${id}`);
  const cloneId = newId || `dag-copy-${Date.now().toString(36)}`;
  const clone = {
    ...src,
    id: cloneId,
    builtIn: false,
    name: newName || `${src.name} (副本)`,
  };
  return saveDag(clone);
}

async function listDagsByStage(stage) {
  const all = await listDags();
  if (!stage) return all;
  return all.filter((d) => d.stage === stage);
}

module.exports = {
  ensureBuiltinSeeds,
  listDags,
  listDagsByStage,
  getDag,
  saveDag,
  deleteDag,
  cloneDag,
  SCHEMA_VERSION,
};
