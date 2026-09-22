#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const WORKSPACE = path.resolve(__dirname, '..');
const REMOVED_PATHS = [
  '.dev.vars',
  'relay-worker/.dev.vars',
  '.mana-data/app-config.json',
  '.claude/settings.json',
  '.github-token',
];
const REMOVED_PATH_GLOBS = ['tmp-test-*', 'tmp-test-*/**'];

function fail(message) { throw new Error(`[history-cleanup] ${message}`); }

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    stdio: options.capture === false ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) fail(`${options.label || command} failed; command output was intentionally suppressed`);
  return result.stdout || '';
}

function parseArgs(argv) {
  const options = { mirror: '', backupDir: '', recipient: '', replaceText: '', execute: false, forcePush: false, confirm: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--mirror') options.mirror = argv[++index];
    else if (value === '--backup-dir') options.backupDir = argv[++index];
    else if (value === '--age-recipient') options.recipient = argv[++index];
    else if (value === '--replace-text') options.replaceText = argv[++index];
    else if (value === '--execute') options.execute = true;
    else if (value === '--force-push') options.forcePush = true;
    else if (value === '--confirm') options.confirm = argv[++index];
    else fail(`unknown option: ${value}`);
  }
  return options;
}

function validateMirror(options) {
  if (!options.mirror) fail('--mirror is required');
  const mirror = path.resolve(options.mirror);
  if (mirror === WORKSPACE || mirror.startsWith(`${WORKSPACE}${path.sep}`)) fail('the rewrite must run in an independent mirror outside the dirty workspace');
  if (!fs.existsSync(mirror)) fail('mirror path does not exist');
  if (run('git', ['rev-parse', '--is-bare-repository'], { cwd: mirror, label: 'mirror validation' }).trim() !== 'true') {
    fail('target is not a bare mirror repository');
  }
  const remote = run('git', ['remote', 'get-url', 'origin'], { cwd: mirror, label: 'remote validation' }).trim();
  if (!remote || /https?:\/\/[^/@]+@/u.test(remote)) fail('mirror origin must be a credential-free remote URL');
  const confirmation = `REWRITE-${digest(remote).slice(0, 12)}`;
  return { mirror, remote, confirmation };
}

function validateSensitiveInput(file) {
  const absolute = path.resolve(file || '');
  if (!file || !fs.existsSync(absolute)) fail('--replace-text must point to a local git-filter-repo replacement file');
  if (absolute === WORKSPACE || absolute.startsWith(`${WORKSPACE}${path.sep}`)) fail('replacement material must stay outside the repository');
  const stat = fs.lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) fail('replacement material must be a regular file');
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) fail('replacement material permissions must be 0600 or stricter');
  return absolute;
}

function encryptedBackup({ mirror, backupDir, recipient }) {
  if (!backupDir || !recipient) fail('--backup-dir and --age-recipient are mandatory before rewriting history');
  const directory = path.resolve(backupDir);
  if (directory === mirror || directory.startsWith(`${mirror}${path.sep}`)) fail('encrypted backup must be outside the mirror');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
  const bundle = path.join(directory, `mana-before-history-rewrite-${stamp}.bundle`);
  const encrypted = `${bundle}.age`;
  run('git', ['bundle', 'create', bundle, '--all'], { cwd: mirror, label: 'Git bundle backup' });
  try {
    run('age', ['-r', recipient, '-o', encrypted, bundle], { cwd: mirror, label: 'encrypted backup' });
  } finally {
    if (fs.existsSync(bundle)) fs.rmSync(bundle, { force: true });
  }
  if (!fs.existsSync(encrypted) || fs.statSync(encrypted).size === 0) fail('encrypted backup was not created');
  const checksum = digest(fs.readFileSync(encrypted));
  fs.writeFileSync(`${encrypted}.sha256`, `${checksum}  ${path.basename(encrypted)}\n`, { mode: 0o600 });
  return { encrypted, checksum };
}

function filterArguments(replaceText) {
  const argumentsList = ['filter-repo', '--force', '--invert-paths'];
  for (const value of REMOVED_PATHS) argumentsList.push('--path', value);
  for (const value of REMOVED_PATH_GLOBS) argumentsList.push('--path-glob', value);
  argumentsList.push('--replace-text', replaceText);
  return argumentsList;
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const validated = validateMirror(options);
  process.stdout.write(`[history-cleanup] mirror=${validated.mirror}\n`);
  process.stdout.write(`[history-cleanup] credential-free-origin=true confirmation=${validated.confirmation}\n`);
  process.stdout.write(`[history-cleanup] exact-paths=${REMOVED_PATHS.length} path-globs=${REMOVED_PATH_GLOBS.length}\n`);
  if (!options.execute) {
    process.stdout.write('[history-cleanup] dry-run only; no refs, files or remotes were changed\n');
    return;
  }
  if (!options.forcePush) fail('--execute also requires --force-push; a local-only rewrite is not an accepted completion state');
  if (options.confirm !== validated.confirmation) fail(`confirmation mismatch; rerun with --confirm ${validated.confirmation}`);
  const replaceText = validateSensitiveInput(options.replaceText);
  run('git', ['filter-repo', '--version'], { cwd: validated.mirror, label: 'git-filter-repo availability' });
  const refsBefore = run('git', ['show-ref'], { cwd: validated.mirror, label: 'pre-rewrite refs' });
  const backup = encryptedBackup({ mirror: validated.mirror, backupDir: options.backupDir, recipient: options.recipient });
  run('git', filterArguments(replaceText), { cwd: validated.mirror, label: 'history rewrite', capture: false });
  // A bare mirror has no checked-out working tree, so scripts/<name> cannot
  // exist as a normal file after filter-repo. Run the trusted workspace
  // verifier against the mirror explicitly instead.
  const scanScript = path.join(WORKSPACE, 'scripts', 'security-preflight.js');
  run(process.execPath, [scanScript, '--history', '--repo', validated.mirror], { cwd: WORKSPACE, label: 'post-rewrite secret scan', capture: false });
  const remotes = run('git', ['remote'], { cwd: validated.mirror, label: 'post-rewrite remote inspection' }).split(/\r?\n/u).filter(Boolean);
  if (!remotes.includes('origin')) run('git', ['remote', 'add', 'origin', validated.remote], { cwd: validated.mirror, label: 'restore sanitized origin' });
  else run('git', ['remote', 'set-url', 'origin', validated.remote], { cwd: validated.mirror, label: 'sanitize origin' });
  run('git', ['push', '--force', '--mirror', 'origin'], { cwd: validated.mirror, label: 'force-push rewritten refs', capture: false });
  const receipt = {
    schemaVersion: 1,
    completedAt: new Date().toISOString(),
    originHash: digest(validated.remote),
    refsBeforeHash: digest(refsBefore),
    encryptedBackup: path.basename(backup.encrypted),
    encryptedBackupSha256: backup.checksum,
    removedPaths: REMOVED_PATHS,
    removedPathGlobs: REMOVED_PATH_GLOBS,
    historyScan: 'passed',
    forcePush: 'completed',
  };
  const receiptPath = path.join(path.resolve(options.backupDir), 'history-rewrite-receipt.json');
  fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`[history-cleanup] completed receipt=${receiptPath}\n`);
}

if (require.main === module) {
  try { main(); }
  catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { REMOVED_PATHS, REMOVED_PATH_GLOBS, filterArguments, parseArgs, validateMirror };
