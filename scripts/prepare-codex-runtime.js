#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pipeline } = require('node:stream/promises');
const { Readable } = require('node:stream');
const {
  PROJECT_ROOT,
  developmentCacheRoot,
  readManifest,
  targetFor,
  targetKey,
} = require('../src/main/codex-runtime/runtimeManifest');

function parseArgs(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith('--')) continue;
    const [rawKey, inlineValue] = value.slice(2).split('=', 2);
    if (inlineValue != null) out[rawKey] = inlineValue;
    else if (argv[index + 1] && !argv[index + 1].startsWith('--')) out[rawKey] = argv[++index];
    else out[rawKey] = true;
  }
  return out;
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const digest = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('error', reject);
    stream.on('data', (chunk) => digest.update(chunk));
    stream.on('end', () => resolve(digest.digest('hex')));
  });
}

function integrityFile(file, algorithm = 'sha512') {
  return new Promise((resolve, reject) => {
    const digest = crypto.createHash(algorithm);
    const stream = fs.createReadStream(file);
    stream.on('error', reject);
    stream.on('data', (chunk) => digest.update(chunk));
    stream.on('end', () => resolve(`${algorithm}-${digest.digest('base64')}`));
  });
}

async function download(url, destination, { attempts = 3, timeoutMs = 180_000 } = {}) {
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  const partial = `${destination}.partial-${process.pid}`;
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    timeout.unref?.();
    try {
      await fsp.rm(partial, { force: true });
      const response = await fetch(url, {
        redirect: 'follow',
        headers: { 'user-agent': 'MultiAgentNovelAssistant-codex-runtime-preparer/1' },
        signal: controller.signal,
      });
      if (!response.ok || !response.body) throw new Error(`download failed (${response.status}) for ${url}`);
      await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(partial, { mode: 0o600 }));
      await fsp.rename(partial, destination);
      return;
    } catch (error) {
      lastError = error;
      await fsp.rm(partial, { force: true }).catch(() => {});
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, Math.min(2_000, attempt * 500)));
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError || new Error(`download failed for ${url}`);
}

function extractArchive(archive, destination, format) {
  fs.mkdirSync(destination, { recursive: true });
  let result;
  if (format === 'tar.gz') {
    result = spawnSync('tar', ['-xzf', archive, '-C', destination], { stdio: 'inherit' });
  } else if (format === 'zip' && process.platform === 'win32') {
    result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Expand-Archive', '-LiteralPath', archive, '-DestinationPath', destination, '-Force'], { stdio: 'inherit' });
  } else if (format === 'zip') {
    result = spawnSync('unzip', ['-q', '-o', archive, '-d', destination], { stdio: 'inherit' });
  } else {
    throw new Error(`unsupported archive format: ${format}`);
  }
  if (result.error || result.status !== 0) throw result.error || new Error(`archive extraction failed with exit ${result.status}`);
}

function findExecutable(root, name) {
  const pending = [root];
  while (pending.length) {
    const current = pending.shift();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(absolute);
      else if (
        entry.name === name
        || entry.name === name.replace(/\.exe$/u, '')
        || entry.name === `${name}.exe`
        || entry.name.startsWith('codex-app-server-')
      ) return absolute;
    }
  }
  return null;
}

async function prepare(options = {}) {
  const manifest = readManifest();
  const requested = String(options.target || targetKey());
  const [platform, arch] = requested.split('-', 2);
  const target = targetFor(platform, arch);
  const cacheRoot = developmentCacheRoot();
  const archiveDir = path.join(cacheRoot, 'downloads', manifest.runtimeVersion);
  const archivePath = path.join(archiveDir, target.archive);
  const extractRoot = path.join(cacheRoot, 'extracted', manifest.runtimeVersion, requested);
  const stagingRoot = path.join(cacheRoot, 'staging');
  const releaseUrl = `${manifest.releaseBaseUrl}/${target.archive}`;

  const archiveValid = fs.existsSync(archivePath)
    && (!target.archiveSha256 || await sha256File(archivePath) === target.archiveSha256)
    && (!target.archiveIntegrity || await integrityFile(archivePath, target.archiveIntegrity.split('-', 1)[0]) === target.archiveIntegrity);
  if (!archiveValid) {
    await fsp.rm(archivePath, { force: true });
    process.stdout.write(`[codex-runtime] downloading ${target.archive}\n`);
    await download(releaseUrl, archivePath);
  }
  const archiveDigest = await sha256File(archivePath);
  if (target.archiveSha256 && archiveDigest !== target.archiveSha256) throw new Error(`archive SHA-256 mismatch: expected ${target.archiveSha256}, got ${archiveDigest}`);
  const archiveIntegrity = target.archiveIntegrity ? await integrityFile(archivePath, target.archiveIntegrity.split('-', 1)[0]) : null;
  if (target.archiveIntegrity && archiveIntegrity !== target.archiveIntegrity) throw new Error(`archive integrity mismatch: expected ${target.archiveIntegrity}, got ${archiveIntegrity}`);

  await fsp.rm(extractRoot, { recursive: true, force: true });
  extractArchive(archivePath, extractRoot, target.archiveFormat);
  const extracted = findExecutable(extractRoot, target.executable);
  if (!extracted) throw new Error(`archive does not contain ${target.executable}`);
  const binaryDigest = await sha256File(extracted);

  await fsp.rm(stagingRoot, { recursive: true, force: true });
  await fsp.mkdir(stagingRoot, { recursive: true });
  const stagedExecutable = path.join(stagingRoot, target.executable);
  await fsp.copyFile(extracted, stagedExecutable);
  if (platform !== 'win32') await fsp.chmod(stagedExecutable, 0o755);
  const companionSha256 = {};
  for (const companion of target.companions || []) {
    const source = findExecutable(extractRoot, companion);
    if (!source) throw new Error(`archive does not contain required companion ${companion}`);
    const destination = path.join(stagingRoot, companion);
    await fsp.copyFile(source, destination);
    if (platform !== 'win32') await fsp.chmod(destination, 0o755);
    companionSha256[companion] = await sha256File(destination);
  }
  await fsp.copyFile(path.join(PROJECT_ROOT, 'resources', 'codex-runtime', 'manifest.json'), path.join(stagingRoot, 'manifest.json'));
  await fsp.copyFile(path.join(PROJECT_ROOT, 'resources', 'codex-runtime', 'THIRD_PARTY_NOTICES.txt'), path.join(stagingRoot, 'THIRD_PARTY_NOTICES.txt'));
  const licensePath = path.join(stagingRoot, 'LICENSE.openai-codex.txt');
  await download(manifest.licenseUrl, licensePath);
  const licenseSha256 = await sha256File(licensePath);
  if (licenseSha256 !== manifest.licenseSha256) throw new Error(`Codex license SHA-256 mismatch: expected ${manifest.licenseSha256}, got ${licenseSha256}`);

  const receipt = {
    schemaVersion: 1,
    preparedAt: new Date().toISOString(),
    runtimeVersion: manifest.runtimeVersion,
    tag: manifest.tag,
    commit: manifest.commit,
    target: requested,
    targetTriple: target.targetTriple,
    archive: target.archive,
    archiveSha256: archiveDigest,
    archiveIntegrity,
    binarySha256: binaryDigest,
    companionSha256,
    licenseSha256,
    executable: target.executable,
  };
  await fsp.writeFile(path.join(stagingRoot, 'install-receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  process.stdout.write(`[codex-runtime] staged ${requested} ${binaryDigest}\n`);
  return receipt;
}

if (require.main === module) {
  prepare(parseArgs(process.argv.slice(2))).catch((error) => {
    process.stderr.write(`[codex-runtime] prepare failed: ${error.message || error}\n`);
    process.exitCode = 1;
  });
}

module.exports = { download, extractArchive, findExecutable, integrityFile, parseArgs, prepare, sha256File };
