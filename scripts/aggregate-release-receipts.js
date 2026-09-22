#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const EXPECTED_TARGETS = Object.freeze([
  'darwin-arm64',
  'win32-x64',
  'win32-arm64',
  'linux-x64',
  'linux-arm64',
]);

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const digest = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('data', (chunk) => digest.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(digest.digest('hex')));
  });
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) continue;
    const [key, inline] = arg.slice(2).split('=', 2);
    options[key] = inline == null ? argv[++index] : inline;
  }
  return options;
}

function receiptFiles(root) {
  const output = [];
  const pending = [root];
  while (pending.length) {
    const current = pending.shift();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(absolute);
      else if (/^verification-receipt-(?:darwin|win32|linux)-(?:x64|arm64)\.json$/u.test(entry.name)) output.push(absolute);
    }
  }
  return output.sort();
}

function validateReceipt(receipt) {
  assert.equal(receipt.schemaVersion, 1);
  assert.equal(receipt.status, 'verified');
  assert.equal(receipt.signingPolicy, 'github-actions-unsigned', `${receipt.target} must declare the unsigned release policy`);
  assert(EXPECTED_TARGETS.includes(receipt.target), `unexpected target ${receipt.target}`);
  assert.equal(receipt.target, `${receipt.platform}-${receipt.arch}`);
  for (const field of ['artifactSha256', 'appExecutableSha256', 'codexSidecarSha256', 'skillsSha256']) {
    assert.match(String(receipt[field] || ''), /^[a-f0-9]{64}$/u, `${receipt.target} has invalid ${field}`);
  }
  const requiredTests = ['sidecarInitialize', 'asarStructure', 'resourceSecretScan', 'fakeProviderMcpTurn', 'cancellation', 'reasoningRedacted'];
  for (const name of requiredTests) assert.equal(receipt.tests?.[name], true, `${receipt.target} failed ${name}`);
  assert.equal(receipt.signature?.policy, 'github-actions-unsigned', `${receipt.target} signature policy drifted`);
  assert.equal(receipt.signature?.signed, false, `${receipt.target} receipt must not claim a signature`);
  if (receipt.platform === 'linux') {
    assert.equal(receipt.tests?.appImageVerified, true, `${receipt.target} AppImage was not verified`);
  }
  return receipt;
}

async function aggregate(options = parseArgs(process.argv.slice(2))) {
  const input = path.resolve(String(options.input || path.join(ROOT, 'artifacts', 'release-input')));
  const output = path.resolve(String(options.output || path.join(ROOT, 'artifacts', 'release-manifest.json')));
  assert.ok(fs.existsSync(input), `receipt input does not exist: ${input}`);
  const files = receiptFiles(input);
  assert.equal(files.length, EXPECTED_TARGETS.length, `expected exactly five verification receipts, found ${files.length}`);
  const receipts = files.map((file) => validateReceipt(JSON.parse(fs.readFileSync(file, 'utf8'))));
  assert.deepEqual(receipts.map((receipt) => receipt.target).sort(), [...EXPECTED_TARGETS].sort(), 'receipt target set is incomplete or duplicated');
  for (const receipt of receipts) {
    const matches = [];
    const pending = [input];
    while (pending.length) {
      const current = pending.shift();
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const absolute = path.join(current, entry.name);
        if (entry.isDirectory()) pending.push(absolute);
        else if (entry.name === receipt.artifactName) matches.push(absolute);
      }
    }
    assert.equal(matches.length, 1, `${receipt.target} must have exactly one uniquely named artifact`);
    assert.equal(await sha256File(matches[0]), receipt.artifactSha256, `${receipt.target} artifact hash mismatch`);
  }
  const manifest = {
    schemaVersion: 1,
    status: 'verified',
    signingPolicy: 'github-actions-unsigned',
    generatedAt: new Date().toISOString(),
    expectedTargets: EXPECTED_TARGETS,
    receipts: receipts.sort((left, right) => left.target.localeCompare(right.target)),
  };
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`VERIFY_PASS aggregate-release receipts=5 output=${output}\n`);
  return manifest;
}

if (require.main === module) aggregate().catch((error) => {
  process.stderr.write(`VERIFY_FAIL aggregate-release: ${error.stack || error}\n`);
  process.exitCode = 1;
});

module.exports = { EXPECTED_TARGETS, aggregate, parseArgs, receiptFiles, validateReceipt };
