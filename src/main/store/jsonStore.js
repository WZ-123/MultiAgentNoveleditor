'use strict';

const fs = require('node:fs');
const path = require('node:path');
const fsp = fs.promises;
const { atomicWriteFile } = require('./resourceIdentity');

async function readJson(file, fallback = null) {
  try {
    const text = await fsp.readFile(file, 'utf8');
    return JSON.parse(text);
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

async function writeJson(file, data, options = {}) {
  const mode = options.mode == null ? undefined : options.mode;
  await atomicWriteFile(file, JSON.stringify(data, null, 2), { ...(mode == null ? {} : { mode }) });
  if (mode != null) {
    try { await fsp.chmod(file, mode); } catch { /* POSIX mode unavailable */ }
  }
}

async function listJsonFiles(dir) {
  try {
    const names = await fsp.readdir(dir);
    return names.filter((n) => n.endsWith('.json')).map((n) => path.join(dir, n));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

async function readAllJson(dir) {
  const files = await listJsonFiles(dir);
  const out = [];
  for (const file of files) {
    const obj = await readJson(file, null);
    if (obj && typeof obj === 'object') out.push(obj);
  }
  return out;
}

async function deleteFile(file) {
  return require('./projectTransactions').writeFile(file, null);
}
async function appendJsonl(file, line) {
  return require('./projectTransactions').appendFile(file, JSON.stringify(line) + '\n');
}

async function readJsonl(file) {
  try {
    const text = await fsp.readFile(file, 'utf8');
    return text
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => {
        try { return JSON.parse(l); } catch { return null; }
      })
      .filter(Boolean);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

async function pathExists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  readJson,
  writeJson,
  listJsonFiles,
  readAllJson,
  deleteFile,
  appendJsonl,
  readJsonl,
  pathExists,
};
