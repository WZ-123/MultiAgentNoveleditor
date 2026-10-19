'use strict';
// One durable review state for analysis facts, web facts and regeneration.
const path = require('node:path');
const fs = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const { readJson, writeJson } = require('../store/jsonStore');
const storage = require('../store/projectTransactions');
const { commitPlan } = require('./resourcePlan');
function file(root, id) {
  if (!/^review-[a-f0-9-]+$/u.test(id)) throw new Error('invalid review id');
  return path.join(root, '.mana', 'reviews', `${id}.json`);
}
async function create(root, input) {
  const review = { ...input, schemaVersion: 2, id: `review-${randomUUID()}`, root: path.resolve(root), state: 'review', decisions: {}, createdAt: new Date().toISOString() };
  review.fields = require('./reviewOperations').bindFields(review.plan.changes, review.fields);
  review.plan.id = review.id;
  await writeJson(file(root, review.id), review);
  return review;
}
async function readReview(root, id) {
  const review = await readJson(file(root, id), null);
  if (!review || review.root !== path.resolve(root)) throw new Error('review target mismatch');
  return review;
}
async function get(root, id) { return storage.transaction(root, () => readReview(root, id)); }
async function list(root) {
  return storage.transaction(root, async () => {
    let names; try { names = await fs.readdir(path.join(root, '.mana', 'reviews')); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
    const reviews = [];
    for (const name of names.filter((n) => n.endsWith('.json'))) {
      const r = await get(root, name.slice(0, -5));
      if (r.state === 'review') reviews.push(r);
    }
    return reviews.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  });
}
function valueAt(object, keys) { return keys.reduce((v, k) => v?.[k], object); }
async function decide(root, id, decisions) {
  return storage.transaction(root, async () => {
    const review = await get(root, id);
    if (review.state !== 'review') throw new Error(review.state === 'cancelled' ? 'review was cancelled' : 'review is closed');
    for (const [key, choice] of Object.entries(decisions || {})) {
      const field = review.fields.find((f) => f.id === key);
      if (!field || !(choice === 'reject' || Number.isInteger(choice) && choice >= 0 && choice < field.candidates.length)) throw new Error('invalid fact decision');
      review.decisions[key] = choice;
    }
    await writeJson(file(root, id), review); return review;
  });
}
async function finish(root, id, approved) {
  return storage.transaction(root, async () => {
    const review = await get(root, id);
    if (review.state === 'committed') return review;
    if (review.state !== 'review') throw new Error(review.state === 'cancelled' ? 'review was cancelled' : 'review is closed');
    if (!approved) {
      review.state = 'cancelled'; await writeJson(file(root, id), review);
      if (review.kind === 'analysis') { const f = path.join(root, '.mana', 'analysis-summary.json'); const summary = await readJson(f, {}); await writeJson(f, { ...summary, reviewState: 'cancelled', characters: 0, factions: 0, timeline: 0, lore: 0, outline: 0, style: 0 }); }
      return review;
    }
    if (review.kind === 'regeneration') {
      const allowed = new Set([...review.files, ...review.plan.changes.map((c) => path.basename(c.relative))]);
      const current = (await fs.readdir(path.join(root, 'characters'))).filter((n) => n.endsWith('.json') && !n.endsWith('.memory.json'));
      if (current.some((n) => !allowed.has(n))) throw Object.assign(new Error('审阅期间新增了角色，请重新准备候选'), { code: 'stale_import_review' });
    }
    if (review.fields.some((f) => !(f.id in review.decisions))) throw Object.assign(new Error('请逐项确认或拒绝所有候选事实'), { code: 'unresolved_facts' });
    const plan = structuredClone(review.plan);
    const rejectedIdentities = new Set(review.fields.filter((f) => f.identity && review.decisions[f.id] === 'reject').map((f) => f.group || f.relative));
    for (const change of plan.changes) if (rejectedIdentities.has(change.group || change.relative)) change.after = change.before;
    require('./reviewOperations').apply(plan, review.fields, review.decisions, rejectedIdentities);
    if (review.kind === 'analysis') {
      const meta = plan.changes.find((c) => c.relative === 'world/meta.json');
      if (meta) {
        const world = JSON.parse(meta.after);
        if (Array.isArray(world.places)) world.places = world.places.filter(Boolean);
        meta.after = JSON.stringify(world, null, 2);
        const lore = plan.changes.find((c) => c.relative === 'world/lore.md');
        const places = plan.changes.find((c) => c.relative === 'world/places.json');
        const prior = JSON.parse(meta.before || '{}');
        if (lore) lore.after = ['lore', 'timeSetting', 'location', 'society', 'rules'].every((key) => (world[key] || '') === (prior[key] || ''))
          ? lore.before : require('./worldSchema').worldLore(world);
        if (places) places.after = JSON.stringify({ schemaVersion: 1, places: world.places }, null, 2);
      }
    }
    for (const c of plan.changes) if (c.after && c.relative.endsWith('.jsonl')) c.after = c.after.split('\n').filter(Boolean).map((line) => JSON.parse(line)).filter(Boolean).map((v) => JSON.stringify(v)).join('\n') + '\n';
    if (review.kind === 'enrichment') for (const c of plan.changes) {
      if (c.after === null || c.after === c.before || rejectedIdentities.has(c.group || c.relative)) continue;
      const card = JSON.parse(c.after); card._enrichmentStatus = 'reviewed'; card._factReviewId = review.id;
      // Operational provenance comes from the saved review, never a model fact.
      if (review.runId) card._enrichmentRunId = review.runId;
      c.after = JSON.stringify(card, null, 2);
    }
    // Candidate ledgers stay in this review, outside authoritative domain data.
    function confirmed(value) {
      if (Array.isArray(value)) return value.map(confirmed);
      if (!value || typeof value !== 'object') return value;
      return Object.fromEntries(Object.entries(value).filter(([key]) => !key.startsWith('_analysis') && !['_proposedFacts', '_pageSnapshot', '_enrichmentEvidence', '_enrichmentCompleteness', '_enrichmentConflicts'].includes(key)).map(([key, child]) => [key, confirmed(child)]));
    }
    for (const c of plan.changes) {
      if (!c.after || c.after === c.before) continue;
      if (c.relative.endsWith('.json')) {
        const object = confirmed(JSON.parse(c.after)); object._factReviewId = review.id;
        c.after = JSON.stringify(object, null, 2);
      } else if (c.relative.endsWith('.jsonl')) {
        const originals = require('./reviewOperations').parse(c, true);
        c.after = c.after.split('\n').filter(Boolean).map((line) => {
          const value = confirmed(JSON.parse(line));
          const old = originals.find((item) => require('./reviewOperations').key(item) === require('./reviewOperations').key(value));
          return JSON.stringify(JSON.stringify(old) === JSON.stringify(value) ? old : { ...value, _factReviewId: review.id });
        }).join('\n') + '\n';
      }
    }
    // Final bytes are determined only by the persisted decisions and baselines.
    review.receipt = await commitPlan(root, plan, async () => {});
    review.state = 'committed'; review.committedAt = new Date().toISOString();
    await writeJson(file(root, id), review);
    if (review.kind === 'analysis') {
      const summaryFile = path.join(root, '.mana', 'analysis-summary.json');
      const summary = await readJson(summaryFile, {});
      summary.reviewState = 'committed'; summary.receipt = review.receipt;
      summary.status = summary.domains?.every((d) => d.status === 'complete') ? 'complete' : 'partial';
      const data = require('../store/novelData');
      summary.characters = (await data.listCharacters(root)).length;
      summary.timeline = (await data.listTimeline(root)).length;
      const world = await data.readWorld(root); summary.lore = world.lore.length;
      summary.style = (await data.readStyleMemory(root)).length;
      summary.outline = (await storage.read(path.join(root, 'outlines', 'main.md')) || '').length;
      summary.factions = (await fs.readdir(path.join(root, 'factions'))).filter((n) => n.endsWith('.json')).length;
      await writeJson(summaryFile, summary);
    }
    await require('../store/novelData').rebuildCharacterIndex(root);
    return review;
  });
}
function fieldLabel(field) {
  return ({ name: '姓名', aliases: '别名', gender: '性别', age: '年龄', role: '故事定位', appearance: '外貌', personality: '性格', background: '背景', relationships: '人物关系', storyArc: '角色经历', protagonist: '是否主角', sourceWork: '原作', originalName: '原作姓名', description: '描述', type: '类别', goals: '目标', members: '成员', conflicts: '冲突', lore: '世界设定', timeSetting: '时代背景', location: '主要地点', society: '社会结构', rules: '世界规则', isFanwork: '是否二创', referencedWorks: '原作列表', possibleFanworkOf: '原作判断', hairColor: '发色', eyeColor: '瞳色', height: '身高', figure: '体型', moeTraits: '特征', quotes: '台词', skins: '时装与形态' })[field] || field;
}
function fieldsForChanges(changes) {
  const fields = [];
  function visit(value, keys, relative) {
    if (!value || typeof value !== 'object') return;
    for (const [field, candidates] of Object.entries(value._analysisCandidates || {})) {
      if (['id', 'evidence'].includes(field) || !candidates.length) continue;
      fields.push({ id: `${relative}:${[...keys, field].join('.')}`, relative, keys: [...keys, field], identity: field === 'name' && !keys.length, entityPath: field === 'name' && keys.length ? keys : undefined, label: `${value.name || (relative === 'world/meta.json' ? '世界观' : relative)} · ${fieldLabel(field)}`, candidates });
    }
    for (const [key, child] of Object.entries(value)) {
      if (key.startsWith('_')) continue;
      if (Array.isArray(child)) child.forEach((item, index) => visit(item, [...keys, key, index], relative));
      else if (child && typeof child === 'object') visit(child, [...keys, key], relative);
    }
  }
  for (const c of changes) {
    if (!c.after) continue;
    if (c.relative.endsWith('.jsonl')) {
      c.after.split('\n').filter(Boolean).forEach((line, index) => fields.push({ id: `${c.relative}:${index}`, relative: c.relative, keys: [index], jsonl: true, label: `事件 ${index + 1}`, candidates: [{ value: JSON.parse(line), sources: [JSON.parse(line).evidence || null] }] }));
      continue;
    }
    if (!c.relative.endsWith('.json') || c.relative === 'world/places.json') continue;
    const start = fields.length;
    visit(JSON.parse(c.after), [], c.relative);
    const original = JSON.parse(c.logicalBefore || c.before || '{}');
    for (const field of fields.slice(start)) { field.group = c.group || c.relative; field.originalValue = valueAt(original, field.keys); field.hasOriginalValue = true; }
  }
  return fields;
}
function imported(root) {
  const base = path.join(require('../store/paths').paths().root, 'import-staging');
  return path.resolve(path.dirname(root)) === path.resolve(base) ? path.basename(root) : null;
}
function route(root, id, action, input) {
  const importId = imported(root);
  return importId ? new (require('./importSaga').ImportSagaService)().reviewImport(importId, id, action, input)
    : action === 'decide' ? decide(root, id, input) : finish(root, id, input);
}
module.exports = { create, get, list, decide: (root, id, input) => route(root, id, 'decide', input), finish: (root, id, input) => route(root, id, 'finish', input), executeDecide: decide, executeFinish: finish, fieldsForChanges, fieldLabel };
