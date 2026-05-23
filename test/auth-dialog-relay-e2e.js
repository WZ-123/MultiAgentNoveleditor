'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs, message) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = await predicate();
    if (value) return value;
    await delay(100);
  }
  throw new Error(message);
}

async function runAuthDialogRelayE2E() {
  const ROOT = path.resolve(__dirname, '..');
  const { BrowserWindow } = require('electron');
  const { showAuthDialog } = require(path.join(ROOT, 'src/main/license/authDialog'));
  const { paths } = require(path.join(ROOT, 'src/main/store/paths'));
  const resultFile = path.join(paths().root, 'auth-dialog-relay-e2e.result.json');

  const results = { total: 0, passed: 0, failed: 0 };

  function pass(name, detail) {
    results.total += 1;
    results.passed += 1;
    console.log(`TEST_PASS ${name}${detail ? ': ' + detail : ''}`);
  }

  function fail(name, reason) {
    results.total += 1;
    results.failed += 1;
    console.log(`TEST_FAIL ${name}: ${reason}`);
  }

  try {
    fsSync.writeFileSync(resultFile, JSON.stringify({ status: 'running' }, null, 2), 'utf8');
    const appConfigFile = paths().appConfig;
    try {
      const raw = JSON.parse(await fs.readFile(appConfigFile, 'utf8'));
      raw.license = { authCode: '', verifiedUntil: '', deviceId: '' };
      await fs.writeFile(appConfigFile, JSON.stringify(raw, null, 2), 'utf8');
    } catch {
      // initBackend + ensureDevAuthRelayConfig should already have created the file.
    }

    const dialogPromise = showAuthDialog();
    const authWindow = await waitFor(() => {
      return BrowserWindow.getAllWindows().find((win) => win.getTitle() === '授权验证') || null;
    }, 10000, 'auth dialog window not found');

    await waitFor(async () => {
      return authWindow.webContents.executeJavaScript(`
        (() => {
          const input = document.getElementById('code');
          const button = document.getElementById('btn');
          return !!(input && button && typeof submit === 'function');
        })()
      `);
    }, 5000, 'auth dialog DOM not ready');

    await authWindow.webContents.executeJavaScript(`
      (() => {
        const input = document.getElementById('code');
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        if (setter) setter.call(input, '114514');
        else input.value = '114514';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        submit();
      })()
    `);

    const verifyResult = await dialogPromise;
    if (verifyResult?.valid === true) {
      pass('AUTH_DIALOG_RELAY_UI_verify_succeeds', JSON.stringify(verifyResult));
    } else {
      fail('AUTH_DIALOG_RELAY_UI_verify_succeeds', JSON.stringify({ verifyResult }));
    }

    const saved = JSON.parse(await fs.readFile(appConfigFile, 'utf8'));
    if (
      saved?.license?.authCode === '114514'
      && typeof saved?.license?.verifiedUntil === 'string'
      && saved.license.verifiedUntil.length > 0
      && typeof saved?.license?.deviceId === 'string'
      && saved.license.deviceId.length > 0
    ) {
      pass('AUTH_DIALOG_RELAY_UI_persists_license_cache', `${saved.license.authCode} -> ${saved.license.verifiedUntil}`);
    } else {
      fail('AUTH_DIALOG_RELAY_UI_persists_license_cache', JSON.stringify(saved?.license || {}));
    }
  } catch (err) {
    fail('AUTH_DIALOG_RELAY_UI_harness', err.message || String(err));
  }

  fsSync.writeFileSync(resultFile, JSON.stringify({ status: 'completed', results }, null, 2), 'utf8');

  console.log('');
  console.log(`TEST_SUMMARY ${results.passed}/${results.total} passed, ${results.failed} failed`);
  console.log('TEST_DONE');
  return results;
}

module.exports = { runAuthDialogRelayE2E };
