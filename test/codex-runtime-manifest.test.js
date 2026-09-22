'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { readManifest } = require('../src/main/codex-runtime/runtimeManifest');

function run() {
  const manifest = readManifest();
  assert.equal(manifest.runtimeVersion, '0.153.0');
  const expected = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-arm64', 'win32-x64'];
  assert.deepEqual(Object.keys(manifest.targets).sort(), expected);
  for (const [key, target] of Object.entries(manifest.targets)) {
    assert.match(target.archive, /^codex-0\.153\.0-(?:darwin|linux|win32)-(?:arm64|x64)\.tgz$/u, key);
    assert.match(target.archiveIntegrity, /^sha512-[A-Za-z0-9+/]+=*$/u, key);
    assert.deepEqual(target.appServerArgs, ['app-server']);
    assert.equal(target.executable, target.platform === 'win32' ? 'codex.exe' : 'codex');
    assert.deepEqual(target.companions, [target.platform === 'win32' ? 'codex-code-mode-host.exe' : 'codex-code-mode-host']);
  }
  const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.ok(packageJson.build.mac.binaries.includes('Contents/Resources/codex-runtime/codex'));
  assert.ok(packageJson.build.mac.binaries.includes('Contents/Resources/codex-runtime/codex-code-mode-host'));
  console.log('codex-runtime-manifest: ok');
}

if (require.main === module) run();
module.exports = { run };
