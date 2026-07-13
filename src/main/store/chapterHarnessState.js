'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs').promises;
const path = require('node:path');
const { ensureNovelLayout, novelPaths } = require('./paths');
const { readJson, writeJson } = require('./jsonStore');
const { normalizeChapterExitState } = require('../../domain/chapterHarness.cjs');
const novelData = require('./novelData');

const SCHEMA_VERSION = 1;

function stateRoot(novelDir) {
  return path.join(novelPaths(novelDir).mana, 'harness-state', 'chapters');
}

function safeChapterName(chapterRef) {
  return String(chapterRef || '').trim().replace(/[^\w.\-\u4e00-\u9fff]+/gu, '_') || 'unknown';
}

function statePath(novelDir, chapterRef) {
  return path.join(stateRoot(novelDir), `${safeChapterName(chapterRef)}.json`);
}

function contentHash(content) {
  return crypto.createHash('sha256').update(String(content || '').replace(/\r\n/g, '\n').trim()).digest('hex');
}

async function readChapterState(novelDir, chapterRef, { expectedContent } = {}) {
  if (!novelDir || !chapterRef) return null;
  const raw = await readJson(statePath(novelDir, chapterRef), null);
  if (!raw) return null;
  const state = normalizeChapterExitState(raw);
  if (expectedContent != null && state.contentHash && state.contentHash !== contentHash(expectedContent)) {
    state.status = 'stale';
  }
  return state;
}

function mergeObjects(base, patch) {
  if (Array.isArray(patch)) return patch;
  if (!patch || typeof patch !== 'object') return patch == null ? base : patch;
  const out = base && typeof base === 'object' && !Array.isArray(base) ? { ...base } : {};
  for (const [key, value] of Object.entries(patch)) out[key] = mergeObjects(out[key], value);
  return out;
}

function buildChapterExitState({ draft, verifiedStateDeltas = [] } = {}) {
  let merged = {};
  for (const verification of Array.isArray(verifiedStateDeltas) ? verifiedStateDeltas : []) {
    merged = mergeObjects(merged, verification?.merged || verification?.extracted || {});
  }
  if (!verifiedStateDeltas.length) {
    for (const delta of Object.values(draft?.pendingStateDelta || {})) merged = mergeObjects(merged, delta);
  }
  return normalizeChapterExitState({
    schemaVersion: SCHEMA_VERSION,
    chapterRef: draft?.name,
    contentHash: contentHash(draft?.text),
    status: 'valid',
    extractedAt: new Date().toISOString(),
    characters: merged.characters || [],
    assets: merged.assets || [],
    worldState: merged.worldState || {},
    unresolvedThreads: merged.unresolvedThreads || [],
    events: draft?.eventLedger?.events || merged.events || [],
    evidence: verifiedStateDeltas.flatMap((item) => item?.evidenceParagraphIds || []),
    sourceRefs: [{ ref: `chapter:${draft?.name || ''}`, type: 'chapter', priority: 2, deterministic: true }],
  });
}

async function saveConfirmedChapterState(novelDir, draft, verifiedStateDeltas = []) {
  if (!novelDir || !draft?.name || !draft?.text) throw new Error('confirmed harness state requires novelDir, chapter name and text');
  ensureNovelLayout(novelDir);
  await fs.mkdir(stateRoot(novelDir), { recursive: true });
  const state = buildChapterExitState({ draft, verifiedStateDeltas });
  await writeJson(statePath(novelDir, draft.name), state);
  return state;
}

async function listChapterStates(novelDir) {
  let names = [];
  try { names = await fs.readdir(stateRoot(novelDir)); } catch (err) {
    if (err?.code === 'ENOENT') return [];
    throw err;
  }
  const states = [];
  for (const name of names.filter((item) => item.endsWith('.json'))) {
    const state = normalizeChapterExitState(await readJson(path.join(stateRoot(novelDir), name), {}));
    if (state.chapterRef) states.push(state);
  }
  return states;
}

async function markDownstreamStale(novelDir, chapterRef) {
  const displays = await novelData.listChaptersWithDisplay(novelDir);
  const order = new Map(displays.map((item, index) => [item.name, index]));
  const changedIndex = order.get(chapterRef);
  if (!Number.isInteger(changedIndex)) return { marked: 0 };
  const states = await listChapterStates(novelDir);
  let marked = 0;
  for (const state of states) {
    const index = order.get(state.chapterRef);
    if (!Number.isInteger(index) || index <= changedIndex || state.status === 'stale') continue;
    await writeJson(statePath(novelDir, state.chapterRef), { ...state, status: 'stale' });
    marked += 1;
  }
  return { marked };
}

async function rebuildStateIndex(novelDir) {
  const chapters = await novelData.listChapters(novelDir);
  const timeline = await novelData.listTimeline(novelDir);
  const rebuilt = [];
  for (const chapter of chapters) {
    const text = await novelData.readChapter(novelDir, chapter.name);
    const events = timeline.filter((event) => event?.chapterRef === chapter.name);
    const state = await saveConfirmedChapterState(novelDir, {
      name: chapter.name,
      text,
      eventLedger: { events },
      pendingStateDelta: {},
    }, []);
    rebuilt.push({ chapterRef: state.chapterRef, status: state.status, eventCount: state.events.length });
  }
  return { rebuilt: rebuilt.length, chapters: rebuilt };
}

module.exports = {
  buildChapterExitState,
  contentHash,
  listChapterStates,
  markDownstreamStale,
  readChapterState,
  rebuildStateIndex,
  saveConfirmedChapterState,
  statePath,
};
