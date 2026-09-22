#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { parseArgs } = require('./prepare-codex-runtime');
const { verify } = require('./verify-codex-runtime-package');

const ROOT = path.resolve(__dirname, '..');

function findRuntimeRoots(distRoot) {
  if (!fs.existsSync(distRoot)) return [];
  const pending = [distRoot];
  const roots = [];
  while (pending.length) {
    const current = pending.shift();
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); }
    catch { continue; }
    if (entries.some((entry) => entry.isFile() && entry.name === 'install-receipt.json') && path.basename(current) === 'codex-runtime') {
      roots.push(current);
      continue;
    }
    for (const entry of entries) if (entry.isDirectory()) pending.push(path.join(current, entry.name));
  }
  return [...new Set(roots.map((root) => path.resolve(root)))];
}

function containingApp(runtimeRoot) {
  let current = runtimeRoot;
  while (current !== path.dirname(current)) {
    if (current.endsWith('.app')) return current;
    current = path.dirname(current);
  }
  return null;
}

function signatureInfo(target) {
  const verification = spawnSync('codesign', ['--verify', '--deep', '--strict', '--verbose=4', target], { encoding: 'utf8' });
  const details = spawnSync('codesign', ['-dv', '--verbose=4', target], { encoding: 'utf8' });
  const output = `${verification.stdout || ''}\n${verification.stderr || ''}\n${details.stdout || ''}\n${details.stderr || ''}`;
  const teamId = output.match(/^TeamIdentifier=(.+)$/mu)?.[1]?.trim() || '';
  const authority = output.match(/^Authority=(.+)$/mu)?.[1]?.trim() || '';
  return { ok: verification.status === 0 && details.status === 0, teamId, authority, output };
}

function assessMacSignature(appInfo, sidecarInfo, required) {
  const appTeamId = appInfo.teamId && appInfo.teamId !== 'not set' ? appInfo.teamId : '';
  const sidecarTeamId = sidecarInfo.teamId && sidecarInfo.teamId !== 'not set' ? sidecarInfo.teamId : '';
  if (!required && (!appInfo.ok || !sidecarInfo.ok || !appTeamId || !sidecarTeamId || appTeamId !== sidecarTeamId)) {
    return {
      checked: true,
      signed: false,
      appTeamId: appTeamId || null,
      sidecarTeamId: sidecarTeamId || null,
      releaseSignatureRequired: false,
    };
  }
  assert.equal(appInfo.ok, true, `macOS app signature is invalid: ${appInfo.output.slice(-1000)}`);
  assert.equal(sidecarInfo.ok, true, `Codex sidecar signature is invalid: ${sidecarInfo.output.slice(-1000)}`);
  assert.ok(appTeamId, 'macOS app signature has no release TeamIdentifier');
  assert.equal(sidecarTeamId, appTeamId, 'Codex sidecar and Electron app use different signing identities');
  return { checked: true, signed: true, teamId: appTeamId, authority: appInfo.authority };
}

function verifyMacSignature(runtimeRoot, executable, required) {
  if (process.platform !== 'darwin') return { checked: false };
  const appBundle = containingApp(runtimeRoot);
  if (!appBundle) {
    if (required) throw new Error(`packaged Codex runtime is not inside an app bundle: ${runtimeRoot}`);
    return { checked: false };
  }
  return assessMacSignature(signatureInfo(appBundle), signatureInfo(executable), required);
}

async function run(options = {}) {
  const distRoot = path.resolve(String(options.dist || path.join(ROOT, 'dist')));
  const runtimeRoots = findRuntimeRoots(distRoot);
  assert.ok(runtimeRoots.length > 0, `no packaged codex-runtime resource found below ${distRoot}`);
  const expectedTarget = `${process.platform}-${process.arch}`;
  const matching = [];
  for (const runtimeRoot of runtimeRoots) {
    const receipt = JSON.parse(fs.readFileSync(path.join(runtimeRoot, 'install-receipt.json'), 'utf8'));
    if (receipt.target !== expectedTarget) continue;
    const result = await verify({
      root: runtimeRoot,
      launch: options.launch === 'false' ? 'false' : 'true',
      allowSignedMutation: process.platform === 'darwin' ? 'true' : 'false',
    });
    const executable = path.join(runtimeRoot, result.receipt.executable);
    const signature = verifyMacSignature(runtimeRoot, executable, options.requireSignature === 'true' || process.env.MANA_REQUIRE_RELEASE_SIGNATURE === '1');
    const companionSignatures = [];
    for (const companion of result.receipt.companionSha256 ? Object.keys(result.receipt.companionSha256) : []) {
      companionSignatures.push({ companion, signature: verifyMacSignature(runtimeRoot, path.join(runtimeRoot, companion), options.requireSignature === 'true' || process.env.MANA_REQUIRE_RELEASE_SIGNATURE === '1') });
    }
    matching.push({ runtimeRoot, target: receipt.target, signature, companionSignatures });
  }
  assert.ok(matching.length > 0, `no packaged Codex runtime matches current runner ${expectedTarget}`);
  const signedCount = matching.filter((item) => item.signature?.signed === true).length;
  process.stdout.write(`VERIFY_PASS packaged-codex-runtime ${matching.length} resource(s) target=${expectedTarget} releaseSigned=${signedCount}/${matching.length}\n`);
  return matching;
}

if (require.main === module) run(parseArgs(process.argv.slice(2))).catch((error) => {
  process.stderr.write(`VERIFY_FAIL packaged-codex-runtime: ${error.stack || error}\n`);
  process.exitCode = 1;
});

module.exports = { assessMacSignature, containingApp, findRuntimeRoots, run, signatureInfo, verifyMacSignature };
