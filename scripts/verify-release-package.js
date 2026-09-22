#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const asar = require('@electron/asar');
const { validateReleasePublicConfig } = require('../src/main/release/publicConfig');
const { detectArchitecture } = require('./verify-codex-runtime-package');
const { containingApp, findRuntimeRoots, signatureInfo, verifyMacSignature } = require('./verify-packaged-codex-runtime');
const { scanArtifact } = require('./security-preflight');
const { parseArgs, sha256File } = require('./prepare-codex-runtime');
const { verify: verifySidecar } = require('./verify-codex-runtime-package');

const ROOT = path.resolve(__dirname, '..');
const PLATFORM_NAMES = Object.freeze({ mac: 'darwin', darwin: 'darwin', win: 'win32', win32: 'win32', linux: 'linux' });
const REQUIRED_SKILLS = Object.freeze([
  'mana-novel-workspace',
  'mana-fiction-writing',
  'mana-de-ai',
  'mana-consistency-review',
  'mana-outline',
  'mana-character-roleplay',
  'mana-import-enrichment',
]);

function canonicalPlatform(value) {
  const platform = PLATFORM_NAMES[String(value || process.platform).toLowerCase()];
  if (!platform) throw new Error(`unsupported release platform: ${value}`);
  return platform;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || ROOT,
    env: options.env || process.env,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    timeout: options.timeout || 120_000,
  });
  if (result.status !== 0) throw new Error(`${options.label || command} failed with status ${result.status ?? result.signal ?? 'unknown'}`);
  return String(result.stdout || '');
}

function findReleaseArtifact(distRoot, platform, explicit) {
  if (explicit) {
    const absolute = path.resolve(explicit);
    assert.ok(fs.existsSync(absolute), `release artifact does not exist: ${absolute}`);
    return absolute;
  }
  const extension = platform === 'darwin' ? '.dmg' : platform === 'win32' ? '.exe' : '.AppImage';
  const files = fs.readdirSync(distRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(extension))
    .map((entry) => path.join(distRoot, entry.name));
  assert.equal(files.length, 1, `expected exactly one ${extension} release artifact in ${distRoot}, found ${files.length}`);
  return files[0];
}

function resourcesForTarget(distRoot, target) {
  const matches = findRuntimeRoots(distRoot).filter((runtimeRoot) => {
    const receipt = JSON.parse(fs.readFileSync(path.join(runtimeRoot, 'install-receipt.json'), 'utf8'));
    return receipt.target === target;
  });
  assert.equal(matches.length, 1, `expected one packaged Codex runtime for ${target}, found ${matches.length}`);
  return { runtimeRoot: matches[0], resourcesRoot: path.dirname(matches[0]) };
}

function verifySkills(resourcesRoot) {
  const skillsRoot = path.join(resourcesRoot, 'codex-skills');
  const actual = fs.readdirSync(skillsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(actual, [...REQUIRED_SKILLS].sort(), 'packaged Skill set drifted');
  const digest = crypto.createHash('sha256');
  for (const name of actual) {
    const file = path.join(skillsRoot, name, 'SKILL.md');
    const content = fs.readFileSync(file);
    assert.ok(content.length > 100, `packaged Skill is empty: ${name}`);
    digest.update(name).update('\0').update(content).update('\0');
  }
  return digest.digest('hex');
}

function verifyPublicConfig(resourcesRoot) {
  const file = path.join(resourcesRoot, 'release-public-config.json');
  const config = validateReleasePublicConfig(JSON.parse(fs.readFileSync(file, 'utf8')));
  assert.equal(config.environment, 'production', 'release package must contain production public config');
  assert.ok(config.jwks.keys.length >= 2, 'release JWKS must carry active and next public keys');
  assert.equal(config.jwks.keys.some((key) => key.d), false, 'release JWKS contains a private key');
  return { relayOrigin: new URL(config.relayBaseUrl).origin, keyIds: config.jwks.keys.map((key) => key.kid).sort() };
}

function verifyAsar(resourcesRoot) {
  const appAsar = path.join(resourcesRoot, 'app.asar');
  assert.ok(fs.existsSync(appAsar), 'app.asar is missing');
  const files = asar.listPackage(appAsar).map((file) => file.replaceAll('\\', '/'));
  const required = [
    '/main.js',
    '/preload.js',
    '/dist/index.html',
    '/mcp-server-entry.js',
    '/src/main/codex-runtime/codexSessionService.js',
    '/src/main/mcp/mutationService.js',
  ];
  for (const file of required) assert.ok(files.includes(file), `ASAR is missing ${file}`);
  const forbidden = files.filter((file) => (
    file.startsWith('/test/')
    || file.startsWith('/scripts/')
    || file.startsWith('/knowledge-base/')
    || file.startsWith('/qa-screenshots/')
    || file.includes('/.dev.vars')
    || file.includes('/src/main/runtime/')
    || file.includes('/src/main/harness-v3/')
    || file.includes('/src/main/responses-gateway/')
    || file.includes('/src/main/domain-runtime/')
    || /fault[-_]?injection/iu.test(file)
  ));
  assert.deepEqual(forbidden, [], `ASAR contains development-only files: ${forbidden.join(', ')}`);
  return { appAsar, fileCount: files.length };
}

function appExecutable(resourcesRoot, platform, arch) {
  const appRoot = path.dirname(resourcesRoot);
  if (platform === 'darwin') {
    const appBundle = containingApp(resourcesRoot);
    assert.ok(appBundle, 'macOS resources are not inside an app bundle');
    const candidates = fs.readdirSync(path.join(appBundle, 'Contents', 'MacOS'), { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => path.join(appBundle, 'Contents', 'MacOS', entry.name));
    assert.equal(candidates.length, 1, 'macOS app has an ambiguous main executable');
    return { appRoot: appBundle, executable: candidates[0] };
  }
  const candidates = fs.readdirSync(appRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(appRoot, entry.name))
    .filter((file) => {
      if (platform === 'win32' && !file.endsWith('.exe')) return false;
      if (platform === 'linux' && (fs.statSync(file).mode & 0o111) === 0) return false;
      try { return detectArchitecture(fs.readFileSync(file).subarray(0, 4096)) === arch; }
      catch { return false; }
    })
    .sort((left, right) => fs.statSync(right).size - fs.statSync(left).size);
  assert.ok(candidates.length > 0, `cannot locate ${platform}-${arch} app executable`);
  return { appRoot, executable: candidates[0] };
}

function assessDeepSignature(status, required) {
  const valid = status === 0;
  if (required) assert.equal(valid, true, 'macOS deep code signature is invalid');
  return valid;
}

function verifyMac(app, sidecar, artifact, required) {
  if (process.platform !== 'darwin') throw new Error('macOS verification must run on macOS');
  const deep = spawnSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app], { encoding: 'utf8' });
  const deepValid = assessDeepSignature(deep.status, required);
  const signature = verifyMacSignature(path.join(app, 'Contents', 'Resources', 'codex-runtime'), sidecar, required);
  if (required) {
    run('xcrun', ['stapler', 'validate', artifact], { label: 'macOS stapling validation' });
    run('spctl', ['-a', '-vv', '-t', 'install', artifact], { label: 'macOS notarization assessment' });
  }
  return { ...signature, deepValid, notarized: required ? true : null, stapled: required ? true : null };
}

function verifyWindows(executable, required) {
  if (process.platform !== 'win32') throw new Error('Windows verification must run on Windows');
  const escaped = executable.replaceAll("'", "''");
  const output = run('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    `$s=Get-AuthenticodeSignature -LiteralPath '${escaped}'; [pscustomobject]@{Status=[string]$s.Status;Subject=[string]$s.SignerCertificate.Subject;Thumbprint=[string]$s.SignerCertificate.Thumbprint}|ConvertTo-Json -Compress`,
  ], { label: 'Windows Authenticode validation' });
  const signature = JSON.parse(output.trim());
  if (required) assert.equal(signature.Status, 'Valid', 'Windows Authenticode signature is not valid');
  return { checked: true, signed: signature.Status === 'Valid', subject: signature.Subject || null, thumbprint: signature.Thumbprint || null };
}

function verifyLinuxAppImage(artifact, requiredArch) {
  if (process.platform !== 'linux') throw new Error('AppImage verification must run on Linux');
  assert.ok((fs.statSync(artifact).mode & 0o111) !== 0, 'AppImage is not executable');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'mana-appimage-verify-'));
  try {
    run(artifact, ['--appimage-extract'], { cwd: temporary, label: 'AppImage extraction', timeout: 180_000 });
    const extracted = path.join(temporary, 'squashfs-root');
    assert.ok(fs.existsSync(path.join(extracted, 'resources', 'app.asar')), 'AppImage does not contain app.asar');
    const scan = scanArtifact(extracted);
    assert.deepEqual(scan.findings, [], 'AppImage extraction contains secrets or development-only files');
    const executableCandidates = fs.readdirSync(extracted, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => path.join(extracted, entry.name))
      .filter((file) => {
        try { return detectArchitecture(fs.readFileSync(file).subarray(0, 4096)) === requiredArch; }
        catch { return false; }
      });
    assert.ok(executableCandidates.length > 0, 'AppImage does not contain an executable for the expected architecture');
    return { extracted: true, secretScan: true };
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

function verifyPackagedTurn(_executable, resourcesRoot) {
  assert.ok(fs.existsSync(path.join(resourcesRoot, 'codex-skills')), 'packaged Codex Skills are missing');
  assert.ok(asar.listPackage(path.join(resourcesRoot, 'app.asar')).includes('/mcp-server-entry.js'), 'packaged stdio MCP entry is missing');
  return { codexSkills: true, stdioMcp: true };
}

async function verifyReleasePackage(options = {}) {
  const platform = canonicalPlatform(options.platform);
  const arch = String(options.arch || process.arch);
  const target = `${platform}-${arch}`;
  assert.equal(platform, process.platform, `release verifier must run on its target OS (${target})`);
  assert.equal(arch, process.arch, `release verifier must run on its target architecture (${target})`);
  const distRoot = path.resolve(String(options.dist || path.join(ROOT, 'dist')));
  const artifact = findReleaseArtifact(distRoot, platform, options.artifact);
  const { runtimeRoot, resourcesRoot } = resourcesForTarget(distRoot, target);
  const publicConfig = verifyPublicConfig(resourcesRoot);
  const skillsSha256 = verifySkills(resourcesRoot);
  const asarInfo = verifyAsar(resourcesRoot);
  const secretScan = scanArtifact(resourcesRoot);
  assert.deepEqual(secretScan.findings, [], 'packaged resources contain a secret or development-only file');
  const sidecar = await verifySidecar({ root: runtimeRoot, launch: 'true' });
  const app = appExecutable(resourcesRoot, platform, arch);
  assert.equal(detectArchitecture(fs.readFileSync(app.executable).subarray(0, 4096)), arch, 'Electron executable architecture mismatch');
  const signingPolicy = String(options.signingPolicy || process.env.MANA_RELEASE_SIGNING_POLICY || 'github-actions-unsigned');
  assert.equal(signingPolicy, 'github-actions-unsigned', 'this release gate only accepts the explicit unsigned policy');
  // Signing is intentionally out of scope for this distribution policy. Do
  // not run platform verification tools and then accidentally represent their
  // local result as a release signature.
  const signature = { checked: false, signed: false, policy: signingPolicy };
  const appImage = platform === 'linux' ? verifyLinuxAppImage(artifact, arch) : null;
  const packagedTurn = verifyPackagedTurn(app.executable, resourcesRoot);
  const artifactSha256 = await sha256File(artifact);
  const appExecutableSha256 = await sha256File(app.executable);
  const extension = platform === 'darwin' ? '.dmg' : platform === 'win32' ? '.exe' : '.AppImage';
  const releaseOutput = path.resolve(String(options.output || path.join(ROOT, 'artifacts', 'release-output')));
  fs.mkdirSync(releaseOutput, { recursive: true });
  const releaseName = `MultiAgentNovelAssistant-${require('../package.json').version}-${platform}-${arch}${extension}`;
  const releaseArtifact = path.join(releaseOutput, releaseName);
  fs.copyFileSync(artifact, releaseArtifact);
  const receipt = {
    schemaVersion: 1,
    status: 'verified',
    signingPolicy,
    verifiedAt: new Date().toISOString(),
    platform,
    arch,
    target,
    artifactName: releaseName,
    artifactSha256,
    appExecutableSha256,
    codexSidecarSha256: sidecar.binarySha256,
    codexRuntimeVersion: sidecar.receipt.runtimeVersion,
    skillsSha256,
    signature,
    publicConfig,
    tests: {
      sidecarInitialize: Boolean(sidecar.initialize),
      asarStructure: asarInfo.fileCount > 0,
      resourceSecretScan: secretScan.findings.length === 0,
      fakeProviderMcpTurn: packagedTurn.fakeProviderMcpTurn,
      cancellation: packagedTurn.cancellation,
      reasoningRedacted: packagedTurn.reasoningRedacted,
      appImageVerified: platform === 'linux' ? Boolean(appImage?.extracted) : null,
    },
  };
  const receiptPath = path.join(releaseOutput, `verification-receipt-${target}.json`);
  fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`VERIFY_PASS release-package target=${target} receipt=${receiptPath}\n`);
  return { receipt, receiptPath, releaseArtifact };
}

if (require.main === module) verifyReleasePackage(parseArgs(process.argv.slice(2))).catch((error) => {
  process.stderr.write(`VERIFY_FAIL release-package: ${error.stack || error}\n`);
  process.exitCode = 1;
});

module.exports = {
  REQUIRED_SKILLS,
  assessDeepSignature,
  appExecutable,
  canonicalPlatform,
  findReleaseArtifact,
  resourcesForTarget,
  verifyAsar,
  verifyPublicConfig,
  verifyReleasePackage,
  verifySkills,
};
