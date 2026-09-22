#!/usr/bin/env node
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { spawnSync, spawn } = require('node:child_process');

const pkg = require('../package.json');

const ROOT = path.resolve(__dirname, '..');
const DIST_DIR = path.join(ROOT, 'dist');
const INSTALLER_PATH = path.join(DIST_DIR, `MultiAgentNovelAssistant Setup ${pkg.version}.exe`);
const UNPACKED_EXE = path.join(DIST_DIR, 'win-unpacked', 'MultiAgentNovelAssistant.exe');
const DEFAULT_INSTALL_DIR = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'multi-agent-novel-assistant');
const INSTALLED_EXE = path.join(DEFAULT_INSTALL_DIR, 'MultiAgentNovelAssistant.exe');
const NPM_CMD = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const RELAY_URL = process.env.RELEASE_RELAY_URL || '';
const RELAY_JWKS = process.env.RELEASE_RELAY_JWKS || '';

let failed = 0;

function log(msg) {
  process.stdout.write(`${msg}\n`);
}

function pass(msg) {
  log(`OK   ${msg}`);
}

function fail(msg) {
  log(`FAIL ${msg}`);
  failed += 1;
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: 'inherit',
    shell: false,
    ...options,
  });
  return result;
}

function runNpm(args) {
  return spawnSync(NPM_CMD, args, {
    cwd: ROOT,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
}

function runPowerShell(script) {
  return spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    cwd: ROOT,
    encoding: 'utf8',
  });
}

function killAppProcesses() {
  const script = "$ErrorActionPreference='SilentlyContinue'; Get-Process | Where-Object { $_.ProcessName -eq 'MultiAgentNovelAssistant' } | Stop-Process -Force;";
  runPowerShell(script);
}

function verifyExists(label, targetPath) {
  if (fs.existsSync(targetPath)) pass(`${label}: ${targetPath}`);
  else fail(`${label}: missing ${targetPath}`);
}

async function verifyLaunch(exePath, label) {
  await new Promise((resolve) => {
    const child = spawn(exePath, [], {
      cwd: path.dirname(exePath),
      detached: false,
      stdio: 'ignore',
      windowsHide: true,
    });

    let settled = false;
    child.once('error', (err) => {
      if (settled) return;
      settled = true;
      fail(`${label}: spawn failed (${err.message || String(err)})`);
      resolve();
    });

    setTimeout(() => {
      if (settled) return;
      if (child.exitCode == null) {
        pass(`${label}: process stayed alive long enough (pid=${child.pid})`);
      } else {
        fail(`${label}: process exited early with code ${child.exitCode}`);
      }
      try { child.kill(); } catch { /* ignore */ }
      settled = true;
      resolve();
    }, 4000);
  });
}

async function main() {
  const shouldBuild = process.argv.includes('--build');

  log('=== Windows package verification ===');

  if (shouldBuild) {
    if (!RELAY_URL || !RELAY_JWKS) {
      fail('RELEASE_RELAY_URL and public RELEASE_RELAY_JWKS are required for --build');
      process.exit(1);
    }
    const build = runNpm(['run', 'build:win']);
    if (build.status === 0) pass('npm run build:win');
    else {
      fail(`npm run build:win exited with ${build.status ?? build.signal ?? build.error?.message ?? 'unknown error'}`);
      process.exit(1);
    }
  }

  const structure = runCommand('node', ['scripts/verify-package.js']);
  if (structure.status === 0) pass('scripts/verify-package.js');
  else fail(`scripts/verify-package.js exited with ${structure.status ?? structure.signal ?? structure.error?.message ?? 'unknown error'}`);

  verifyExists('Installer', INSTALLER_PATH);
  verifyExists('Unpacked exe', UNPACKED_EXE);

  killAppProcesses();

  const install = runCommand(INSTALLER_PATH, ['/S']);
  if (install.status === 0) pass('silent installer exit code 0');
  else fail(`silent installer exited with ${install.status ?? install.signal ?? install.error?.message ?? 'unknown error'}`);

  verifyExists('Installed exe', INSTALLED_EXE);

  if (fs.existsSync(UNPACKED_EXE)) {
    await verifyLaunch(UNPACKED_EXE, 'Unpacked app launch');
  }

  killAppProcesses();

  if (fs.existsSync(INSTALLED_EXE)) {
    await verifyLaunch(INSTALLED_EXE, 'Installed app launch');
  }

  killAppProcesses();

  if (failed > 0) {
    log(`=== FAILED (${failed}) ===`);
    process.exit(1);
  }

  log('=== ALL CHECKS PASSED ===');
}

main().catch((err) => {
  fail(err.stack || err.message || String(err));
  process.exit(1);
});
