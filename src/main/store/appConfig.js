'use strict';

const { paths } = require('./paths');
const { readJson, writeJson } = require('./jsonStore');

const SCHEMA_VERSION = 7;
const DEFAULT_LAN_REMOTE_CONFIG = { enabled: false, port: 8788 };
const DEFAULT_APP_CONFIG = {
  schemaVersion: SCHEMA_VERSION,
  language: 'system',
  recents: [],
  lastNovelId: null,
  lastNovelDir: null,
  storageQuota: { chatHistoryMaxMB: 200, offlineLogMaxMB: 100 },
  searchEngine: 'auto',
  enrichmentConcurrency: 10,
  feishuSync: { enabled: true, endpointProfile: 'release-public-config' },
  license: { secretMigrationVersion: 2, lastAuthStatus: '' },
  updater: { skipVersion: '', autoDownload: false, lastCheckAt: '' },
  lanRemote: DEFAULT_LAN_REMOTE_CONFIG,
};

function normalizeLanRemote(value) {
  const source = value && typeof value === 'object' ? value : {};
  const rawPort = Number(source.port);
  return { enabled: source.enabled === true, port: Number.isFinite(rawPort) ? Math.min(65535, Math.max(1024, Math.trunc(rawPort))) : 8788 };
}
function normalizeLicense(value) {
  return {
    secretMigrationVersion: Math.max(0, Number(value?.secretMigrationVersion) || 0),
    lastAuthStatus: typeof value?.lastAuthStatus === 'string' ? value.lastAuthStatus.slice(0, 64) : '',
  };
}
function normalize(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return {
    ...DEFAULT_APP_CONFIG,
    language: source.language || DEFAULT_APP_CONFIG.language,
    recents: Array.isArray(source.recents) ? source.recents : [],
    lastNovelId: source.lastNovelId || null,
    lastNovelDir: source.lastNovelDir || null,
    storageQuota: { ...DEFAULT_APP_CONFIG.storageQuota, ...(source.storageQuota || {}) },
    searchEngine: source.searchEngine || DEFAULT_APP_CONFIG.searchEngine,
    enrichmentConcurrency: Math.max(1, Number(source.enrichmentConcurrency) || DEFAULT_APP_CONFIG.enrichmentConcurrency),
    feishuSync: { ...DEFAULT_APP_CONFIG.feishuSync, ...(source.feishuSync || {}), endpointProfile: 'release-public-config' },
    license: normalizeLicense(source.license),
    updater: { ...DEFAULT_APP_CONFIG.updater, ...(source.updater || {}) },
    lanRemote: normalizeLanRemote(source.lanRemote),
  };
}
function redactSensitiveConfig(config) {
  const copy = JSON.parse(JSON.stringify(config || {}));
  if (copy.feishuSync) { delete copy.feishuSync.relayApiKey; delete copy.feishuSync.relayUrl; }
  if (copy.license) { delete copy.license.authCode; delete copy.license.deviceId; delete copy.license.verifiedUntil; delete copy.license.offlineLease; }
  return copy;
}
async function readLegacyLicenseMaterial() {
  const raw = await readJson(paths().appConfig, null);
  return {
    authCode: String(raw?.license?.authCode || ''), relayUrl: String(raw?.feishuSync?.relayUrl || ''),
    relayApiKey: String(raw?.feishuSync?.relayApiKey || ''), deviceId: String(raw?.license?.deviceId || ''),
    verifiedUntil: String(raw?.license?.verifiedUntil || ''),
  };
}
async function clearLegacyLicenseMaterial() {
  const raw = await readJson(paths().appConfig, null);
  if (!raw || typeof raw !== 'object') return false;
  await writeJson(paths().appConfig, normalize(raw));
  return true;
}
async function load() {
  const raw = await readJson(paths().appConfig, null);
  const next = normalize(raw);
  if (JSON.stringify(raw) !== JSON.stringify(next)) await writeJson(paths().appConfig, next);
  return next;
}
async function save(patch) {
  const current = await load();
  const source = patch && typeof patch === 'object' ? patch : {};
  const next = normalize({
    ...current,
    ...source,
    storageQuota: { ...current.storageQuota, ...(source.storageQuota || {}) },
    feishuSync: { ...current.feishuSync, ...(source.feishuSync || {}) },
    license: { ...current.license, ...(source.license || {}) },
    updater: { ...current.updater, ...(source.updater || {}) },
    lanRemote: { ...current.lanRemote, ...(source.lanRemote || {}) },
  });
  await writeJson(paths().appConfig, next);
  return next;
}
async function loadPublic() { return redactSensitiveConfig(await load()); }

module.exports = { clearLegacyLicenseMaterial, load, loadPublic, readLegacyLicenseMaterial, redactSensitiveConfig, save, DEFAULT_APP_CONFIG, DEFAULT_LAN_REMOTE_CONFIG, SCHEMA_VERSION };
