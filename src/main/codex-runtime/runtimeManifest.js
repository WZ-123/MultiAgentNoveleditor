'use strict';

const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');
const SOURCE_MANIFEST_PATH = path.join(PROJECT_ROOT, 'resources', 'codex-runtime', 'manifest.json');

function manifestPath() {
  if (process.resourcesPath) {
    const packaged = path.join(process.resourcesPath, 'codex-runtime', 'manifest.json');
    if (fs.existsSync(packaged)) return packaged;
  }
  return SOURCE_MANIFEST_PATH;
}

const MANIFEST_PATH = manifestPath();

function readManifest() {
  const manifest = JSON.parse(fs.readFileSync(manifestPath(), 'utf8'));
  if (manifest?.schemaVersion !== 1 || !manifest.runtimeVersion || !manifest.targets) {
    const error = new Error('Codex runtime manifest is invalid');
    error.code = 'runtime_protocol_mismatch';
    throw error;
  }
  return manifest;
}

function targetKey(platform = process.platform, arch = process.arch) {
  return `${platform}-${arch}`;
}

function targetFor(platform = process.platform, arch = process.arch) {
  const manifest = readManifest();
  const key = targetKey(platform, arch);
  const target = manifest.targets[key];
  if (!target) {
    const error = new Error(`Codex App Server is not packaged for ${key}`);
    error.code = 'runtime_unavailable';
    error.details = { platform, arch, supportedTargets: Object.keys(manifest.targets) };
    throw error;
  }
  return { ...target, key, runtimeVersion: manifest.runtimeVersion };
}

function developmentCacheRoot() {
  return path.join(PROJECT_ROOT, '.cache', 'codex-runtime');
}

function packagedRuntimeRoot() {
  return path.join(process.resourcesPath, 'codex-runtime');
}

function runtimeRoot(options = {}) {
  if (options.root) return path.resolve(options.root);
  if (process.resourcesPath && options.packaged !== false) return packagedRuntimeRoot();
  return path.join(developmentCacheRoot(), 'staging');
}

function executablePath(options = {}) {
  const target = targetFor(options.platform, options.arch);
  return path.join(runtimeRoot(options), target.executable);
}

module.exports = {
  MANIFEST_PATH,
  PROJECT_ROOT,
  developmentCacheRoot,
  executablePath,
  packagedRuntimeRoot,
  readManifest,
  manifestPath,
  runtimeRoot,
  targetFor,
  targetKey,
};
