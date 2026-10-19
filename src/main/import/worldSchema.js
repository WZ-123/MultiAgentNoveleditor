'use strict';

const FIELDS = ['lore', 'timeSetting', 'location', 'society', 'rules'];
function normalizeWorld(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('world analysis must be an object');
  for (const field of FIELDS) if (value[field] != null && typeof value[field] !== 'string') throw new Error(`world.${field} must be text`);
  if (value.places != null && !Array.isArray(value.places)) throw new Error('world.places must be an array');
  return { ...value, schemaVersion: 2, lore: value.lore || '', timeSetting: value.timeSetting || '', location: value.location || '',
    society: value.society || '', rules: value.rules || '', places: value.places || [],
    isFanwork: typeof value.isFanwork === 'boolean' ? value.isFanwork : null,
    referencedWorks: Array.isArray(value.referencedWorks) ? value.referencedWorks : [], possibleFanworkOf: value.possibleFanworkOf || null };
}
function worldLore(value) {
  const world = normalizeWorld(value);
  const labels = { timeSetting: '时代背景', location: '主要地点', society: '社会结构', rules: '世界规则' };
  return [world.lore, ...Object.entries(labels).filter(([key]) => world[key]).map(([key, label]) => `## ${label}\n\n${world[key]}`)].filter(Boolean).join('\n\n');
}
module.exports = { normalizeWorld, worldLore, FIELDS };
