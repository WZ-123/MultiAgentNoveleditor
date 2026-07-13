'use strict';

const path = require('node:path');
const { paths } = require('./paths');
const { readJson, writeJson } = require('./jsonStore');

const SCHEMA_VERSION = 2;
const STEP_NAMES = ['chapterWrite', 'harnessState', 'summary', 'timeline', 'outline', 'characterMemory', 'deAiReview'];
let writeQueue = Promise.resolve();

function storePath() {
  return path.join(paths().root, 'chapter-post-write-jobs.json');
}

function emptyStore() {
  return { schemaVersion: SCHEMA_VERSION, jobs: [] };
}

function normalizeStep(value, fallback = 'pending') {
  const status = ['pending', 'running', 'done', 'failed', 'skipped'].includes(value?.status)
    ? value.status
    : fallback;
  return {
    status,
    attempts: Number.isInteger(Number(value?.attempts)) ? Math.max(0, Number(value.attempts)) : 0,
    updatedAt: value?.updatedAt || '',
    error: value?.error || '',
    result: value?.result && typeof value.result === 'object' ? value.result : null,
  };
}

function normalizeJob(value = {}) {
  const steps = {};
  for (const name of STEP_NAMES) steps[name] = normalizeStep(value?.steps?.[name]);
  return {
    draftId: String(value.draftId || '').trim(),
    chapterName: String(value.chapterName || value?.draft?.name || '').trim(),
    status: ['pending', 'running', 'complete', 'failed'].includes(value.status) ? value.status : 'pending',
    createdAt: value.createdAt || new Date().toISOString(),
    updatedAt: value.updatedAt || new Date().toISOString(),
    draft: value.draft && typeof value.draft === 'object' ? value.draft : {},
    roleplayContext: value.roleplayContext && typeof value.roleplayContext === 'object' ? value.roleplayContext : null,
    steps,
  };
}

async function loadStore() {
  const loaded = await readJson(storePath(), emptyStore());
  return {
    schemaVersion: SCHEMA_VERSION,
    jobs: (Array.isArray(loaded?.jobs) ? loaded.jobs : []).map(normalizeJob).filter((job) => job.draftId),
  };
}

async function mutate(mutator) {
  const operation = writeQueue.then(async () => {
    const store = await loadStore();
    const result = await mutator(store);
    store.jobs = store.jobs.slice(-100);
    await writeJson(storePath(), store);
    return result;
  });
  writeQueue = operation.catch(() => {});
  return operation;
}

async function ensureJob({ draftId, draft, roleplayContext }) {
  if (!String(draftId || '').trim()) throw new Error('post-write job requires draftId');
  return mutate((store) => {
    let job = store.jobs.find((item) => item.draftId === draftId);
    if (!job) {
      job = normalizeJob({
        draftId,
        chapterName: draft?.name,
        draft,
        roleplayContext,
        status: 'pending',
      });
      store.jobs.push(job);
    } else {
      job.draft = draft && typeof draft === 'object' ? draft : job.draft;
      job.roleplayContext = roleplayContext && typeof roleplayContext === 'object' ? roleplayContext : job.roleplayContext;
      job.chapterName = draft?.name || job.chapterName;
      job.updatedAt = new Date().toISOString();
    }
    return normalizeJob(job);
  });
}

async function updateStep(draftId, stepName, status, { error = '', result = null } = {}) {
  if (!STEP_NAMES.includes(stepName)) throw new Error(`unknown post-write step: ${stepName}`);
  return mutate((store) => {
    const job = store.jobs.find((item) => item.draftId === draftId);
    if (!job) throw new Error(`post-write job not found: ${draftId}`);
    const previous = normalizeStep(job.steps[stepName]);
    job.steps[stepName] = {
      status,
      attempts: previous.attempts + (status === 'running' ? 1 : 0),
      updatedAt: new Date().toISOString(),
      error: String(error || ''),
      result: result && typeof result === 'object' ? result : null,
    };
    const statuses = STEP_NAMES.map((name) => job.steps[name]?.status || 'pending');
    job.status = statuses.every((item) => item === 'done' || item === 'skipped')
      ? 'complete'
      : statuses.some((item) => item === 'failed')
        ? 'failed'
        : statuses.some((item) => item === 'running') ? 'running' : 'pending';
    job.updatedAt = new Date().toISOString();
    return normalizeJob(job);
  });
}

async function getJob(draftId) {
  const store = await loadStore();
  return store.jobs.find((item) => item.draftId === draftId) || null;
}

async function getLatestRetryableJob() {
  const store = await loadStore();
  return [...store.jobs].reverse().find((job) => (
    job.status !== 'complete' && job.steps.chapterWrite?.status === 'done'
  )) || null;
}

module.exports = {
  STEP_NAMES,
  ensureJob,
  getJob,
  getLatestRetryableJob,
  updateStep,
  _testLoadStore: loadStore,
};
