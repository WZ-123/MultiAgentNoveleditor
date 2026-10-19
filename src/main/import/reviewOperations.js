'use strict';
// Review operations are bound to the captured baseline, never candidate positions.
// Collections overlay existing entities; absence from an extraction is not deletion.
function at(value, keys) { return keys.reduce((v, k) => v?.[k], value); }
function set(value, keys, child) {
  if (!keys.length || keys.some((k) => ['__proto__', 'constructor', 'prototype'].includes(k))) throw new Error('invalid review field');
  let target = value;
  for (const key of keys.slice(0, -1)) target = target[key] ||= {};
  if (child === undefined) delete target[keys.at(-1)]; else target[keys.at(-1)] = structuredClone(child);
}
function parse(change, before = false) {
  const text = before ? change.logicalBefore || change.before : change.after;
  if (change.relative.endsWith('.jsonl')) return (text || '').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  return JSON.parse(text || '{}');
}
function baseline(change, changes) {
  const value = parse(change, true);
  if (change.relative === 'world/meta.json') {
    const places = changes.find((c) => c.relative === 'world/places.json');
    if (places?.before) value.places = JSON.parse(places.before).places || [];
  }
  return value;
}
function key(entity) {
  if (entity?.id) return `id:${entity.id}`;
  const name = entity?.name || entity?.title;
  if (name) return `name:${String(name).normalize('NFKC').trim()}`;
  throw new Error('review entity requires a stable identity');
}
function unique(values) {
  const keys = values.map(key);
  if (new Set(keys).size !== keys.length) throw new Error('ambiguous review entity identity');
  return keys;
}
function bindFields(changes, fields) {
  const operationId = (relative, binding) => require('node:crypto').createHash('sha256').update(JSON.stringify([relative, binding.collection, binding.entityKey])).digest('hex');
  return fields.map((field) => {
    if (field.binding) return { ...field, binding: { ...field.binding, operationId: field.binding.operationId || operationId(field.relative, field.binding) } };
    const change = changes.find((c) => c.relative === field.relative);
    if (!change) throw new Error('review resource missing');
    const before = baseline(change, changes), candidate = parse(change);
    const entityPath = field.jsonl ? field.keys : field.entityPath || entityPathFor(candidate, field.keys);
    if (!entityPath) return field;
    const collection = entityPath.slice(0, -1);
    const proposed = at(candidate, collection), original = at(before, collection) || [];
    if (!Array.isArray(proposed) || !Array.isArray(original)) throw new Error('invalid review collection');
    unique(proposed); const originalKeys = unique(original);
    const entityKey = key(at(candidate, entityPath));
    const originalIndex = originalKeys.indexOf(entityKey);
    const originalEntity = originalIndex < 0 ? undefined : original[originalIndex];
    const relativeKeys = field.keys.slice(entityPath.length);
    const binding = {
      kind: field.jsonl ? 'event' : 'entity-field', collection, entityKey, relativeKeys,
      identity: !!field.entityPath, existed: originalIndex >= 0, originalEntity,
    };
    binding.operationId = operationId(field.relative, binding);
    return { ...field, hasOriginalValue: true, originalValue: at(originalEntity, relativeKeys), binding };
  });
}
function entityPathFor(object, keys) {
  // Bind all fields inside an entity to that entity, not its current array slot.
  for (let i = 0; i < keys.length; i++) if (typeof keys[i] === 'number' && Array.isArray(at(object, keys.slice(0, i)))) return keys.slice(0, i + 1);
  return null;
}
function apply(plan, fields, decisions, rejectedGroups) {
  fields = bindFields(plan.changes, fields);
  for (const change of plan.changes) {
    if (!change.after || rejectedGroups.has(change.group || change.relative)) continue;
    const relevant = fields.filter((f) => f.relative === change.relative);
    if (!relevant.length) continue;
    const candidate = parse(change), before = baseline(change, plan.changes);
    // Only selected operations can change an existing fact. Normalization may
    // add empty defaults to a candidate; those are not authorized deletions.
    const object = change.relative.endsWith('.jsonl') ? candidate : structuredClone(change.before != null || change.logicalBefore != null ? before : candidate);
    const collections = new Map();
    const operations = new Map();
    for (const field of relevant.filter((f) => f.binding)) {
      const { collection } = field.binding, token = JSON.stringify(collection);
      if (collections.has(token)) continue;
      const old = at(before, collection) || [], candidates = at(candidate, collection);
      const oldKeys = unique(old); unique(candidates);
      const merged = structuredClone(old);
      for (const entity of candidates) {
        const index = oldKeys.indexOf(key(entity));
        if (index < 0) merged.push(structuredClone(entity));
      }
      collections.set(token, merged);
    }
    // Bind each immutable operation once, before applying any editable fact.
    // Name/ID values in the resulting object never participate in later lookup.
    for (const field of relevant.filter((f) => f.binding)) {
      const b = field.binding, values = collections.get(JSON.stringify(b.collection));
      if (!operations.has(b.operationId)) {
        const index = values.findIndex((entity) => entity && key(entity) === b.entityKey);
        if (index < 0) throw new Error('bound review entity missing');
        operations.set(b.operationId, { values, index });
      }
    }
    const rejectedEntities = new Set(relevant.filter((f) => f.binding?.identity && decisions[f.id] === 'reject').map((f) => JSON.stringify([f.binding.collection, f.binding.entityKey])));
    for (const field of relevant.filter((f) => f.binding?.identity && decisions[f.id] === 'reject')) {
      const binding = field.binding, { values, index } = operations.get(binding.operationId);
      values[index] = binding.existed ? structuredClone(binding.originalEntity) : null;
    }
    for (const field of relevant) {
      const choice = decisions[field.id], binding = field.binding;
      if (binding) {
        if (rejectedEntities.has(JSON.stringify([binding.collection, binding.entityKey]))) continue;
        const { values, index } = operations.get(binding.operationId);
        const selected = choice === 'reject' ? field.originalValue : field.candidates[choice].value;
        if (binding.kind === 'event') values[index] = selected === undefined ? null : { ...(binding.originalEntity || {}), ...structuredClone(selected) };
        else set(values[index], binding.relativeKeys, selected);
      } else {
        const original = field.hasOriginalValue || Object.hasOwn(field, 'originalValue') ? field.originalValue : at(before, field.keys);
        set(object, field.keys, choice === 'reject' ? original : field.candidates[choice].value);
      }
    }
    for (const values of collections.values()) unique(values.filter(Boolean));
    if (change.relative.endsWith('.jsonl')) {
      const values = collections.get('[]') || object;
      change.after = values.filter(Boolean).map((v) => JSON.stringify(v)).join('\n') + '\n';
    } else {
      for (const [token, values] of collections) set(object, JSON.parse(token), values.filter(Boolean));
      change.after = JSON.stringify(object, null, 2);
    }
  }
}
module.exports = { bindFields, apply, key, parse };
