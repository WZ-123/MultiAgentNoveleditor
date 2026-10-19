'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const data = require('../store/novelData');
const { assignEntityIds, entityFileName } = require('../store/entityIdentity');
const { readJson } = require('../store/jsonStore');
const { snapshot } = require('./resourcePlan');
const { assertNotAborted } = require('./asyncTasks');
function equal(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function mergeEdited(base, candidate, current, location = '', conflicts = []) {
  if (equal(base, candidate)) return current;
  if (equal(base, current)) return candidate;
  if (equal(candidate, current)) return current;
  if ([base, candidate, current].every((value) => value && typeof value === 'object' && !Array.isArray(value))) {
    const result = { ...current };
    for (const key of Object.keys(candidate).filter((key) => !['__proto__', 'constructor', 'prototype'].includes(key))) result[key] = mergeEdited(base[key], candidate[key], current[key], location ? `${location}.${key}` : key, conflicts);
    return result;
  }
  conflicts.push({ field: location, base, candidate, current });
  return current;
}
async function prepareRegeneration(root, extract, fullText) {
  const captured = await require('../store/projectTransactions').transaction(root, async () => {
  const initial = await data.listCharacters(root);
  const files = (await fs.readdir(path.join(root, 'characters'))).filter((file) => file.endsWith('.json') && !file.endsWith('.memory.json')).sort();
  const baselines = [];
  for (const file of files) baselines.push(await snapshot(root, `characters/${file}`));
  return { initial, files, baselines };
  });
  const { initial, files, baselines } = captured;
  // No card, index or memory has been touched before a valid candidate exists.
  const candidates = assignEntityIds(await extract(fullText), 'character');
  if (!candidates.length) throw new Error('未提取到有效角色，保留现有角色卡');
  const used = new Set();
  const changes = [];
  for (const card of candidates) {
    const matches = initial.filter((old) => old.id === card.id || old.name === card.name);
    if (matches.length > 1) throw new Error(`ambiguous regenerated character: ${card.name}`);
    const old = matches[0];
    if (old) card.id = old.id;
    const relative = `characters/${entityFileName(card.id)}`;
    if (used.has(relative)) throw new Error('regenerated characters map to duplicate identities');
    used.add(relative);
    const prior = baselines.find((item) => item.relative === relative);
    const baseline = prior || await snapshot(root, relative);
    if (!prior && baseline.before !== null) throw new Error('提取期间目标角色已新增，请重新准备候选');
    changes.push({ ...baseline, group: card.id, logicalBefore: old ? JSON.stringify(old) : null, after: JSON.stringify({ schemaVersion: 1, ...card }, null, 2) });
  }
  for (const baseline of baselines) if (!used.has(baseline.relative)) changes.push({ ...baseline, group: JSON.parse(baseline.before).id, after: null });
  const review = await require('./reviewStore').create(root, { kind: 'regeneration', candidates, files, fields: require('./reviewStore').fieldsForChanges(changes),
    plan: { changes, state: 'prepared' } });
  return { ...review, reviewId: review.id, characters: candidates.length, removed: changes.filter((c) => c.after === null).length, needReview: true };
}
async function commitRegeneration(root, id, approved) {
  return require('../store/projectTransactions').transaction(root, async () => {
    const reviews = require('./reviewStore');
    const review = await reviews.get(root, id);
    if (review.kind !== 'regeneration') throw new Error('review kind mismatch');
    const result = await reviews.finish(root, id, approved);
    return { characters: review.candidates.length, receipt: result.receipt, cancelled: result.state === 'cancelled' };
  });
}
async function buildEnrichment(root, initial, candidates, { runId, abortSignal } = {}) {
  assertNotAborted(abortSignal);
  const changes = [], fields = [], conflicts = [], failures = [];
  for (const candidate of candidates) {
    const base = initial.find((c) => c.id === candidate.id);
    if (!base) continue;
    if (!['success', 'partial'].includes(candidate._enrichmentStatus)) { failures.push({ characterId: base.id, status: candidate._enrichmentStatus || 'no_candidate', error: candidate._enrichmentError || '未形成可审阅的补全候选' }); continue; }
    const current = await data.readCharacter(root, base.id);
    if (!current) { failures.push({ characterId: base.id, error: '角色已删除' }); continue; }
    const fieldConflicts = [];
    const merged = mergeEdited(base, candidate, current, '', fieldConflicts);
    merged._enrichmentRunId = runId;
    if (fieldConflicts.length) merged._enrichmentConflicts = fieldConflicts;
    conflicts.push(...fieldConflicts.map((c) => ({ characterId: base.id, ...c })));
    const relative = `characters/${entityFileName(base.id)}`;
    const before = await snapshot(root, relative);
    // Legacy filename migration is prepared with both paths in the same plan.
    const identityFiles = (await fs.readdir(path.join(root, 'characters'))).filter((n) => n.endsWith('.json') && !n.endsWith('.memory.json'));
    for (const name of identityFiles) {
      const old = await readJson(path.join(root, 'characters', name), null);
      if (old?.id === base.id && `characters/${name}` !== relative) changes.push({ ...await snapshot(root, `characters/${name}`), group: base.id, after: null });
    }
    changes.push({ ...before, group: base.id, after: JSON.stringify({ schemaVersion: 1, ...merged }, null, 2) });
    fields.push({ id: `${base.id}:identity`, relative, group: base.id, keys: ['_enrichmentIdentityReviewed'], identity: true, label: `${base.name}：确认网页主体及所属作品`, candidates: [{ value: true, sources: [candidate._enrichmentEvidence || {}] }] });
    for (const [key, value] of Object.entries(merged)) {
      if (key.startsWith('_') || ['id', 'name', 'schemaVersion'].includes(key) || equal(value, current[key])) continue;
      fields.push({ id: `${base.id}:${key}`, relative, group: base.id, keys: [key], originalValue: current[key], label: `${base.name} · ${require('./reviewStore').fieldLabel(key)}`, candidates: [{ value, sources: [candidate._enrichmentEvidence?.fields?.[key] || candidate._enrichmentEvidence || {}] }] });
    }
    for (const [key, proposals] of Object.entries(candidate._proposedFacts || {})) {
      if (!['appearance', 'personality', 'background', 'hairColor', 'eyeColor', 'height', 'figure', 'moeTraits', 'quotes'].includes(key) || !proposals.length || fieldConflicts.some((c) => c.field === key)) continue;
      const id = `${base.id}:${key}`;
      const existing = fields.find((f) => f.id === id);
      const fact = { id, relative, group: base.id, keys: [key], originalValue: current[key], hasOriginalValue: true,
        label: `${base.name} · ${require('./reviewStore').fieldLabel(key)}`, candidates: proposals.map((proposal) => ({ value: proposal.value, sources: [proposal] })) };
      if (existing) fields[fields.indexOf(existing)] = fact; else fields.push(fact);
    }
  }
  if (!changes.length) return { written: 0, saved: [], failures, conflicts, runId };
  const review = await require('./reviewStore').create(root, { kind: 'enrichment', runId, fields, candidates, conflicts, plan: { state: 'prepared', changes } });
  return { written: 0, saved: [], failures, conflicts, runId, needReview: true, reviewId: review.id, review };
}
async function prepareEnrichment(root, initial, candidates, options) {
  return require('../store/projectTransactions').transaction(root, () => buildEnrichment(root, initial, candidates, options));
}
module.exports = { mergeEdited, saveEnrichment: prepareEnrichment, prepareRegeneration, commitRegeneration };
