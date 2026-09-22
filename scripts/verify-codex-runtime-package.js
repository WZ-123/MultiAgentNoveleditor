#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { parseArgs, sha256File } = require('./prepare-codex-runtime');
const { developmentCacheRoot, readManifest } = require('../src/main/codex-runtime/runtimeManifest');
const { isolatedConfigToml, restrictedEnvironment } = require('../src/main/codex-runtime/processManager');

function detectArchitecture(buffer) {
  if (buffer.length < 64) return null;
  if (buffer[0] === 0x7f && buffer.toString('ascii', 1, 4) === 'ELF') {
    const little = buffer[5] === 1;
    const machine = little ? buffer.readUInt16LE(18) : buffer.readUInt16BE(18);
    return machine === 0x3e ? 'x64' : machine === 0xb7 ? 'arm64' : `elf-${machine}`;
  }
  if (buffer.toString('ascii', 0, 2) === 'MZ') {
    const pe = buffer.readUInt32LE(0x3c);
    if (buffer.length < pe + 6 || buffer.toString('ascii', pe, pe + 4) !== 'PE\0\0') return 'invalid-pe';
    const machine = buffer.readUInt16LE(pe + 4);
    return machine === 0x8664 ? 'x64' : machine === 0xaa64 ? 'arm64' : `pe-${machine}`;
  }
  const magic = buffer.readUInt32BE(0);
  if (magic === 0xcafebabe || magic === 0xbebafeca) return 'universal';
  const little = magic === 0xcefaedfe || magic === 0xcffaedfe;
  const cpu = little ? buffer.readUInt32LE(4) : buffer.readUInt32BE(4);
  const base = cpu & 0x00ffffff;
  if (base === 7) return 'x64';
  if (base === 12) return 'arm64';
  return null;
}

async function initializeAndExit(executable, appServerArgs = [], timeoutMs = 15_000) {
  const isolatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mana-codex-package-verify-'));
  fs.writeFileSync(path.join(isolatedRoot, 'config.toml'), isolatedConfigToml(), { encoding: 'utf8', mode: 0o600 });
  const child = spawn(executable, [...appServerArgs, '--listen', 'stdio://', '--strict-config'], {
    cwd: isolatedRoot,
    env: restrictedEnvironment({ CODEX_HOME: isolatedRoot }),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let buffer = '';
  let stderr = '';
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const complete = () => {
        fs.rmSync(isolatedRoot, { recursive: true, force: true });
        if (error) reject(error); else resolve(result);
      };
      if (child.exitCode != null || child.signalCode) complete();
      else {
        child.once('close', complete);
        try { child.kill('SIGTERM'); } catch { complete(); }
      }
    };
    const timer = setTimeout(() => finish(new Error(`initialize timed out; stderr=${stderr.slice(-500)}`)), timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += String(chunk || ''); });
    child.on('error', (error) => finish(error));
    child.on('spawn', () => child.stdin.write(`${JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'mana-package-verifier', version: '1' }, capabilities: {} } })}\n`));
    child.stdout.on('data', (chunk) => {
      buffer += String(chunk || '');
      while (buffer.includes('\n')) {
        const index = buffer.indexOf('\n');
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id === 1 && message.result) {
          child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
          finish(null, message.result);
        }
      }
    });
  });
}

async function verify(options = {}) {
  const root = path.resolve(String(options.root || path.join(developmentCacheRoot(), 'staging')));
  const manifest = readManifest();
  const receipt = JSON.parse(fs.readFileSync(path.join(root, 'install-receipt.json'), 'utf8'));
  const target = manifest.targets[receipt.target];
  assert.ok(target, `receipt target is unsupported: ${receipt.target}`);
  assert.equal(receipt.runtimeVersion, manifest.runtimeVersion);
  assert.equal(receipt.commit, manifest.commit);
  if (target.archiveSha256) assert.equal(receipt.archiveSha256, target.archiveSha256);
  assert.equal(receipt.archiveIntegrity, target.archiveIntegrity || null);
  assert.equal(receipt.licenseSha256, manifest.licenseSha256);
  const executable = path.join(root, target.executable);
  const binarySha256 = await sha256File(executable);
  if (binarySha256 !== receipt.binarySha256) {
    assert.equal(options.allowSignedMutation === 'true', true, 'packaged sidecar differs from the prepared binary');
    assert.equal(target.platform, 'darwin', 'only macOS code signing may mutate the prepared sidecar');
  }
  const head = fs.readFileSync(executable).subarray(0, 4096);
  assert.equal(detectArchitecture(head), target.arch, 'packaged sidecar architecture mismatch');
  assert.ok(fs.statSync(path.join(root, 'LICENSE.openai-codex.txt')).size > 1000, 'Codex license is missing or incomplete');
  assert.equal(await sha256File(path.join(root, 'LICENSE.openai-codex.txt')), manifest.licenseSha256, 'Codex license hash differs from the pinned manifest');
  assert.ok(fs.statSync(path.join(root, 'THIRD_PARTY_NOTICES.txt')).size > 200, 'third-party notice is missing');
  if (target.platform !== 'win32') assert.ok((fs.statSync(executable).mode & 0o111) !== 0, 'sidecar is not executable');
  for (const companion of target.companions || []) {
    const companionPath = path.join(root, companion);
    assert.ok(fs.existsSync(companionPath), `required runtime companion is missing: ${companion}`);
    assert.equal(await sha256File(companionPath), receipt.companionSha256?.[companion], `runtime companion hash differs: ${companion}`);
    if (target.platform !== 'win32') assert.ok((fs.statSync(companionPath).mode & 0o111) !== 0, `runtime companion is not executable: ${companion}`);
  }
  let initialize = null;
  if (options.launch !== 'false' && target.platform === process.platform && target.arch === process.arch) initialize = await initializeAndExit(executable, target.appServerArgs || []);
  process.stdout.write(`VERIFY_PASS codex-runtime-package ${receipt.target} ${binarySha256}${initialize ? ' initialized' : ''}\n`);
  return { receipt, binarySha256, initialize };
}

if (require.main === module) verify(parseArgs(process.argv.slice(2))).catch((error) => {
  process.stderr.write(`VERIFY_FAIL codex-runtime-package: ${error.stack || error}\n`);
  process.exitCode = 1;
});

module.exports = { detectArchitecture, initializeAndExit, verify };
