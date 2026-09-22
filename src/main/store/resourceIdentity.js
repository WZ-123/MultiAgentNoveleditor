'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const fsp = require('node:fs/promises');

const WINDOWS_FORBIDDEN = /[<>:"/\\|?*\u0000-\u001F\u007F]/u;
const CHAPTER_SHAPE = /^chapter-(.+)\.md$/u;
const GENERATED_CHAPTER_SHAPE = /^chapter-[a-z0-9][a-z0-9._-]*\.md$/u;

function identityError(message, code = 'invalid_resource_name') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function chapterIdentityKey(name) {
  return String(name || '').normalize('NFKC').toLocaleLowerCase('en-US');
}

function assertChapterName(name, options = {}) {
  const value = String(name ?? '');
  if (!value || value !== value.trim()) throw identityError('chapter name must not be empty or padded with whitespace');
  if (path.basename(value) !== value || value === '.' || value === '..' || WINDOWS_FORBIDDEN.test(value)) {
    throw identityError('chapter name must be a safe basename');
  }
  const match = CHAPTER_SHAPE.exec(value);
  if (!match || !match[1] || match[1].includes('..') || /[ .]$/u.test(match[1])) {
    throw identityError('chapter name must match chapter-*.md');
  }
  if (Buffer.byteLength(value, 'utf8') > 240) throw identityError('chapter name is too long');
  if (options.generated === true && !GENERATED_CHAPTER_SHAPE.test(value)) {
    throw identityError('new generated chapter names must use deterministic ASCII');
  }
  return value;
}

function assertNoChapterCollision(name, existingNames = []) {
  const safe = assertChapterName(name);
  const key = chapterIdentityKey(safe);
  const collision = (existingNames || []).map(String).find((existing) => existing !== safe && chapterIdentityKey(existing) === key);
  if (collision) throw identityError(`chapter name conflicts with an existing cross-platform equivalent: ${collision}`, 'resource_name_conflict');
  return safe;
}

function chapterPath(novelDir, name) {
  const safe = assertChapterName(name);
  return path.join(String(novelDir), 'chapters', safe);
}

async function assertWritableChapterName(novelDir, name, options = {}) {
  const safe = assertChapterName(name, options);
  let existing = [];
  try { existing = await fsp.readdir(path.join(String(novelDir), 'chapters')); }
  catch (error) { if (error?.code !== 'ENOENT') throw error; }
  return assertNoChapterCollision(safe, existing);
}

function contentHashExact(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(String(value ?? ''), 'utf8');
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

async function atomicWriteFile(file, value, options = {}) {
  const target = path.resolve(String(file));
  const directory = path.dirname(target);
  const data = Buffer.isBuffer(value) ? value : Buffer.from(String(value ?? ''), options.encoding || 'utf8');
  await fsp.mkdir(directory, { recursive: true });
  const temporary = path.join(directory, `.${path.basename(target)}.tmp-${process.pid}-${crypto.randomUUID()}`);
  let handle = null;
  try {
    handle = await fsp.open(temporary, 'wx', options.mode == null ? 0o600 : options.mode);
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = null;
    await fsp.rename(temporary, target);
    try {
      const directoryHandle = await fsp.open(directory, 'r');
      try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
    } catch (error) {
      if (!['EINVAL', 'ENOTSUP', 'EPERM', 'EISDIR'].includes(error?.code)) throw error;
    }
    const readBack = await fsp.readFile(target);
    if (!readBack.equals(data)) throw identityError(`atomic write read-back mismatch: ${target}`, 'storage_readback_mismatch');
    return { path: target, bytes: data.length, contentHash: contentHashExact(readBack) };
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await fsp.unlink(temporary).catch((cleanupError) => { if (cleanupError?.code !== 'ENOENT') throw cleanupError; });
    throw error;
  }
}

module.exports = {
  assertChapterName,
  assertNoChapterCollision,
  assertWritableChapterName,
  atomicWriteFile,
  chapterIdentityKey,
  chapterPath,
  contentHashExact,
  identityError,
};
