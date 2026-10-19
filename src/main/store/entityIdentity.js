'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');
const { contentHashExact, identityError } = require('./resourceIdentity');

function assertEntityId(value) {
  const id = String(value ?? '');
  if (!id || id !== id.trim() || id.includes('..') || /[\\/\u0000-\u001f\u007f]/u.test(id) || id === '.') {
    throw identityError('entity id must not contain path segments or control characters');
  }
  return id;
}

function entityFileName(value) {
  const id = assertEntityId(value);
  // Preserve identity. Hash only the disk representation of nonportable/reserved names.
  if (/[<>:"|?*]/u.test(id) || /[ .]$/u.test(id) || /^(?:index|con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/iu.test(id)
      || id.endsWith('.memory') || id.startsWith('entity-') || Buffer.byteLength(id) > 180) {
    return `entity-${contentHashExact(id)}.json`;
  }
  return `${id}.json`;
}

async function safeEntityPath(directory, id) {
  const file = path.join(directory, entityFileName(id));
  await assertContainedFile(directory, file);
  return file;
}

async function assertContainedFile(root, file) {
  const relative = path.relative(path.resolve(root), path.resolve(file));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw identityError('resource escapes its directory');
  // Refuse symlinks in the root, ancestors below it, and the target itself.
  let current = path.resolve(root);
  for (const part of ['', ...relative.split(path.sep)]) {
    if (part) current = path.join(current, part);
    try { if ((await fs.lstat(current)).isSymbolicLink()) throw identityError('symlink resource is not allowed'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }

}

function assignEntityIds(items, prefix = 'entity') {
  const used = new Set();
  return items.map((item, index) => {
    if (!item || typeof item !== 'object' || !String(item.name || '').trim()) throw identityError('entity name is required');
    const base = assertEntityId(item.id || `${prefix}-${contentHashExact(item.name).slice(0, 20)}`);
    let id = base;
    let suffix = 2;
    while (used.has(entityFileName(id).normalize('NFKC').toLowerCase())) id = `${base}-${suffix++}`;
    used.add(entityFileName(id).normalize('NFKC').toLowerCase());
    return { ...item, id };
  });
}

module.exports = { assertEntityId, entityFileName, safeEntityPath, assertContainedFile, assignEntityIds };
