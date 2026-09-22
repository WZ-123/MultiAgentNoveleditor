'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(relative) { return fs.readFileSync(path.resolve(__dirname, '..', relative), 'utf8'); }

function run() {
  const main = read('main.js');
  const auth = read('src/main/license/authDialog.js');
  const authHtml = read('src/main/license/auth-dialog.html');
  const preload = read('src/main/license/authDialogPreload.js');
  const indexHtml = read('index.html');
  const build = read('scripts/build-release.js');
  const pkg = JSON.parse(read('package.json'));

  assert.match(main, /nodeIntegration:\s*false/u);
  assert.match(main, /contextIsolation:\s*true/u);
  assert.match(main, /sandbox:\s*true/u);
  assert.match(main, /setPermissionRequestHandler/u);
  assert.match(main, /setWindowOpenHandler\(\(\) => \(\{ action: 'deny' \}\)\)/u);
  assert.match(auth, /nodeIntegration:\s*false/u);
  assert.match(auth, /contextIsolation:\s*true/u);
  assert.match(auth, /sandbox:\s*true/u);
  assert.doesNotMatch(auth, /data:text\/html/u);
  assert.doesNotMatch(authHtml, /require\(['"]electron/u);
  assert.match(authHtml, /Content-Security-Policy/u);
  assert.match(preload, /contextBridge\.exposeInMainWorld/u);
  assert.match(indexHtml, /Content-Security-Policy/u);
  assert.doesNotMatch(build, /RELEASE_RELAY_API_KEY|BETA_RELAY_API_KEY|appConfig\.js/u);
  assert.equal(pkg.devDependencies.electron, '43.4.0');
  assert.equal(pkg.devDependencies['electron-builder'], '26.15.3');
  assert.equal(pkg.devDependencies.vite, '8.2.2');
  assert.equal(pkg.engines.node, '24.19.0');
  console.log('TEST_PASS electron-security-regression');
}

if (require.main === module) {
  try { run(); } catch (error) { console.error(`TEST_FAIL electron-security-regression: ${error.stack || error}`); process.exitCode = 1; }
}

module.exports = { run };
