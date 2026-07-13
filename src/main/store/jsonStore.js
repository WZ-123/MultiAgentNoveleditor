'use strict';

const fs = require('node:fs');
const path = require('node:path');
const fsp = fs.promises;

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
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const mode = options.mode == null ? undefined : options.mode;
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', ...(mode == null ? {} : { mode }) });
  try {
    // POSIX rename atomically replaces the destination. Modern Windows often
    // supports it too, so try the atomic path first.
    await fsp.rename(tmp, file);
  } catch (err) {
    if (process.platform !== 'win32' || !['EEXIST', 'EPERM', 'EACCES'].includes(err.code)) throw err;
    // Windows fallback: the model config store holds an inter-process lock, so
    // the short unlink/rename window cannot race another application writer.
    try { await fsp.unlink(file); } catch (unlinkErr) { if (unlinkErr.code !== 'ENOENT') throw unlinkErr; }
    await fsp.rename(tmp, file);
  }
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
  try {
    await fsp.unlink(file);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

async function appendJsonl(file, line) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.appendFile(file, JSON.stringify(line) + '\n', 'utf8');
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
