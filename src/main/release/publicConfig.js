'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const SCHEMA_VERSION = 1;
const FILE_NAME = 'release-public-config.json';

function contractError(message, code) {
  return Object.assign(new Error(message), { code });
}

function runtimeResourcesPath() {
  try {
    const { app } = require('electron');
    if (app?.isPackaged && process.resourcesPath) return process.resourcesPath;
  } catch {
    // Node-only contract tests use the repository cache path.
  }
  return path.resolve(__dirname, '..', '..', '..', '.cache');
}

function configPath(options = {}) {
  if (options.path) return path.resolve(String(options.path));
  if (process.env.MANA_RELEASE_PUBLIC_CONFIG) return path.resolve(process.env.MANA_RELEASE_PUBLIC_CONFIG);
  return path.join(runtimeResourcesPath(), FILE_NAME);
}

function validateJwks(jwks) {
  if (!Array.isArray(jwks?.keys) || jwks.keys.length === 0) throw contractError('Relay public keys are missing', 'release_config_invalid');
  const seen = new Set();
  const keys = jwks.keys.map((key) => {
    if (key?.kty !== 'EC' || key?.crv !== 'P-256' || !key?.kid || !key?.x || !key?.y || key?.d) {
      throw contractError('Relay JWKS contains a private or unsupported key', 'release_config_invalid');
    }
    if (seen.has(key.kid)) throw contractError('Relay JWKS contains duplicate key ids', 'release_config_invalid');
    seen.add(key.kid);
    return { kty: 'EC', crv: 'P-256', kid: String(key.kid), x: String(key.x), y: String(key.y), alg: 'ES256', use: 'sig' };
  });
  return { keys };
}

function validateReleasePublicConfig(input, options = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw contractError('Release public config is invalid', 'release_config_invalid');
  if (Number(input.schemaVersion) !== SCHEMA_VERSION) throw contractError('Release public config version is unsupported', 'release_config_invalid');
  if (!['production', 'staging'].includes(input.environment)) throw contractError('Release environment is invalid', 'release_config_invalid');
  const relayBaseUrl = String(input.relayBaseUrl || '').trim().replace(/\/$/, '');
  let parsed;
  try { parsed = new URL(relayBaseUrl); } catch { throw contractError('Relay base URL is invalid', 'release_config_invalid'); }
  const allowLocalHttp = options.allowLocalHttp === true
    && parsed.protocol === 'http:'
    && ['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !allowLocalHttp) throw contractError('Relay base URL must use HTTPS', 'release_config_invalid');
  if (parsed.username || parsed.password || parsed.search || parsed.hash) throw contractError('Relay base URL must not contain credentials or query data', 'release_config_invalid');
  const minimumClientVersion = String(input.minimumClientVersion || '').trim();
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(minimumClientVersion)) {
    throw contractError('Minimum client version is invalid', 'release_config_invalid');
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    environment: input.environment,
    relayBaseUrl,
    minimumClientVersion,
    jwks: validateJwks(input.jwks),
  };
}

async function loadReleasePublicConfig(options = {}) {
  const file = configPath(options);
  let parsed;
  try { parsed = JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) {
    if (options.optional === true && error?.code === 'ENOENT') return null;
    throw contractError('Release public config is unavailable', 'release_config_missing');
  }
  return validateReleasePublicConfig(parsed, options);
}

module.exports = {
  FILE_NAME,
  SCHEMA_VERSION,
  configPath,
  loadReleasePublicConfig,
  validateReleasePublicConfig,
};
