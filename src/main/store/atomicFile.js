'use strict';
const crypto = require('node:crypto');
const path = require('node:path');
const fsp = require('node:fs/promises');
const contentHashExact = (v) => crypto.createHash('sha256').update(v).digest('hex');
function identityError(message, code) { return Object.assign(new Error(message), { code }); }
async function rawAtomicWriteFile(file, value, options = {}) {
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

module.exports = { rawAtomicWriteFile };
