'use strict';

const crypto = require('node:crypto');
const { loadReleasePublicConfig } = require('../release/publicConfig');
const secrets = require('../store/secrets');
const appConfig = require('../store/appConfig');
const { verifySignedToken } = require('./jwtVerifier');
const { appError, normalizeAppError, userMessage: appUserMessage } = require('../appError');

const AUTH_CODE_SECRET = 'license:auth-code';
const INSTALLATION_ID_SECRET = 'license:installation-id';
const OFFLINE_LEASE_SECRET = 'license:offline-lease';
const EXCHANGE_TIMEOUT_MS = 8_000;

function stableError(code, message, context = {}) {
  return appError({ code }, { domain: 'auth', phase: context.phase || 'license', message: message || undefined, ...context });
}

function randomInstallationId() {
  return crypto.randomBytes(32).toString('base64url');
}

function platformName() {
  return `${process.platform}-${process.arch}`;
}

function appVersion() {
  try { return String(require('electron').app?.getVersion?.() || require('../../../package.json').version); }
  catch { return String(require('../../../package.json').version); }
}

function userMessage(code, details = {}) {
  if (code === 'device_limit_reached') return `设备数量已达上限（${details.deviceCount || 0}/${details.maxDevices || 0}）。`;
  const messages = {
    no_auth_code: '未配置授权码，请输入有效授权码后重试。',
    invalid_code: '授权码无效。',
    expired: '授权已过期。',
    license_revoked: '授权已被吊销。',
    device_limit_reached: `设备数量已达上限（${details.deviceCount || 0}/${details.maxDevices || 0}）。`,
    rate_limited: '验证请求过于频繁，请稍后重试。',
    secure_storage_unavailable: '本地凭据存储不可用，无法保存授权信息。',
    release_config_missing: '认证服务配置缺失，请安装完整的正式版本。',
    release_config_invalid: '认证服务配置无效，请更新应用。',
    upgrade_required: '当前版本已停止服务，请更新应用。',
    network_error: '无法连接认证服务，请检查网络后重试。',
    timeout: '认证服务响应超时，请稍后重试。',
    invalid_token: '本地授权凭据无效，请重新验证。',
    token_expired: '本地授权已过期，请联网重新验证。',
  };
  return messages[code] || appUserMessage(code, { domain: 'auth' });
}

class SessionManager {
  constructor(options = {}) {
    this.fetch = options.fetch || globalThis.fetch;
    this.releaseConfigLoader = options.releaseConfigLoader || loadReleasePublicConfig;
    this.secrets = options.secrets || secrets;
    this.appConfig = options.appConfig || appConfig;
    this.now = options.now || (() => Date.now());
    this.getAppVersion = options.getAppVersion || appVersion;
    this.getPlatform = options.getPlatform || platformName;
    this.exchangeTimeoutMs = Number.isInteger(options.exchangeTimeoutMs) && options.exchangeTimeoutMs > 0
      ? options.exchangeTimeoutMs
      : EXCHANGE_TIMEOUT_MS;
    this.access = null;
    this.prepared = false;
    this.preparePromise = null;
  }

  async prepareSecureState() {
    if (this.prepared) return;
    if (this.preparePromise) return this.preparePromise;
    this.preparePromise = (async () => {
      const migration = await this.secrets.migratePlainRecords();
      if (migration.blocked) throw stableError('secure_storage_unavailable', userMessage('secure_storage_unavailable'));
      const legacy = await this.appConfig.readLegacyLicenseMaterial();
      if (legacy.authCode) {
        const current = await this.secrets.getSecretStatus(AUTH_CODE_SECRET);
        if (!current.readable) await this.secrets.setSecret(AUTH_CODE_SECRET, legacy.authCode);
        const written = await this.secrets.getSecretStatus(AUTH_CODE_SECRET);
        if (!written.readable || written.value !== legacy.authCode) throw stableError('secure_storage_unavailable', userMessage('secure_storage_unavailable'));
      }
      await this.ensureInstallationId();
      await this.appConfig.clearLegacyLicenseMaterial();
      this.prepared = true;
    })();
    try { await this.preparePromise; }
    finally { this.preparePromise = null; }
  }

  async ensureInstallationId() {
    const current = await this.secrets.getSecretStatus(INSTALLATION_ID_SECRET);
    if (current.readable && /^[A-Za-z0-9_-]{20,128}$/.test(current.value)) return current.value;
    const value = randomInstallationId();
    await this.secrets.setSecret(INSTALLATION_ID_SECRET, value);
    const stored = await this.secrets.getSecretStatus(INSTALLATION_ID_SECRET);
    if (!stored.readable || stored.value !== value) throw stableError('secure_storage_unavailable', userMessage('secure_storage_unavailable'));
    return value;
  }

  async setAuthCode(value) {
    await this.prepareSecureState();
    const authCode = String(value || '').trim();
    if (!authCode) throw stableError('no_auth_code', userMessage('no_auth_code'));
    await this.secrets.setSecret(AUTH_CODE_SECRET, authCode);
    return true;
  }

  async getReleaseConfig() {
    const allowLocalHttp = process.env.NODE_ENV !== 'production' && process.env.MANA_ALLOW_LOCAL_RELAY === '1';
    try { return await this.releaseConfigLoader({ allowLocalHttp }); }
    catch (error) { throw appError(error, { domain: 'relay', phase: 'configuration' }); }
  }

  async getRelayBaseUrl() {
    return (await this.getReleaseConfig()).relayBaseUrl;
  }

  async _readOfflineLease(config, installationId) {
    const status = await this.secrets.getSecretStatus(OFFLINE_LEASE_SECRET);
    if (!status.readable) return null;
    try {
      const claims = await verifySignedToken(status.value, {
        issuer: config.relayBaseUrl,
        jwks: config.jwks,
        nowSeconds: Math.floor(this.now() / 1000),
        tokenType: 'offline-lease',
        requiredScope: 'license:verify',
        installationId,
      });
      return { token: status.value, claims };
    } catch {
      return null;
    }
  }

  async exchange(options = {}) {
    await this.prepareSecureState();
    if (options.authCode) await this.setAuthCode(options.authCode);
    const authCodeStatus = await this.secrets.getSecretStatus(AUTH_CODE_SECRET);
    if (!authCodeStatus.readable) throw stableError('no_auth_code', userMessage('no_auth_code'));
    const installationId = await this.ensureInstallationId();
    const config = await this.getReleaseConfig();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.exchangeTimeoutMs);
    let response;
    try {
      response = await this.fetch(`${config.relayBaseUrl}/api/v2/session/exchange`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          authCode: authCodeStatus.value,
          installationId,
          appVersion: this.getAppVersion(),
          platform: this.getPlatform(),
        }),
      });
    } catch (error) {
      throw appError(error, { domain: 'relay', phase: 'auth_exchange' });
    } finally {
      clearTimeout(timeout);
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const code = String(data.code || (response.status === 426 ? 'upgrade_required' : response.status === 429 ? 'auth_rate_limited' : 'relay_response_invalid'));
      throw appError({ code }, { domain: 'auth', phase: 'auth_exchange', httpStatus: response.status, message: userMessage(code, data.details) });
    }
    if (!data.accessToken || !data.offlineLease || !data.expiresAt) throw appError({ code: 'relay_response_invalid' }, { domain: 'relay', phase: 'auth_exchange' });
    const accessClaims = await verifySignedToken(data.accessToken, {
      issuer: config.relayBaseUrl,
      jwks: config.jwks,
      nowSeconds: Math.floor(this.now() / 1000),
      tokenType: 'access',
      installationId,
    });
    await verifySignedToken(data.offlineLease, {
      issuer: config.relayBaseUrl,
      jwks: config.jwks,
      nowSeconds: Math.floor(this.now() / 1000),
      tokenType: 'offline-lease',
      requiredScope: 'license:verify',
      installationId,
    });
    await this.secrets.setSecret(OFFLINE_LEASE_SECRET, data.offlineLease);
    this.access = { token: data.accessToken, claims: accessClaims };
    await this.appConfig.save({ license: { secretMigrationVersion: 2, lastAuthStatus: 'verified' } });
    return { valid: true, online: true, ...data };
  }

  async verifyLicense(options = {}) {
    const isDev = process.env.NODE_ENV !== 'production';
    let isPackaged = false;
    try { isPackaged = require('electron').app?.isPackaged === true; } catch {}
    if (!options.forceOnline && process.env.MANA_FORCE_AUTH !== '1' && isDev && !isPackaged) {
      return { valid: true, skipped: true, reason: 'dev_mode' };
    }
    try {
      await this.prepareSecureState();
      const config = await this.getReleaseConfig();
      const installationId = await this.ensureInstallationId();
      if (!options.forceOnline) {
        const offline = await this._readOfflineLease(config, installationId);
        if (offline) return { valid: true, cached: true, offlineLeaseExpiresAt: new Date(offline.claims.exp * 1000).toISOString() };
      }
      return await this.exchange();
    } catch (error) {
      let config;
      let installationId;
      try {
        config = await this.getReleaseConfig();
        installationId = await this.ensureInstallationId();
        const offline = await this._readOfflineLease(config, installationId);
        if (offline && ['relay_unreachable', 'relay_timeout'].includes(error?.code)) {
          return { valid: true, offline: true, reason: error.code, offlineLeaseExpiresAt: new Date(offline.claims.exp * 1000).toISOString() };
        }
      } catch {
        // Preserve the original stable error.
      }
      const normalized = normalizeAppError(error, { domain: 'auth', phase: 'verify_license' });
      return { valid: false, reason: normalized.code, message: normalized.message, error: normalized };
    }
  }

  async getAccessToken(scope, options = {}) {
    await this.prepareSecureState();
    const nowSeconds = Math.floor(this.now() / 1000);
    if (!options.forceRefresh && this.access?.claims?.exp > nowSeconds + 60 && this.access.claims.scope?.includes(scope)) {
      return this.access.token;
    }
    const result = await this.exchange();
    if (!this.access?.claims?.scope?.includes(scope)) throw stableError('insufficient_scope', '当前设备令牌不允许此操作。');
    return result.accessToken;
  }

  clearAccessToken() { this.access = null; }
}

let singleton = null;
function getSessionManager() {
  if (!singleton) singleton = new SessionManager();
  return singleton;
}

module.exports = {
  AUTH_CODE_SECRET,
  EXCHANGE_TIMEOUT_MS,
  INSTALLATION_ID_SECRET,
  OFFLINE_LEASE_SECRET,
  SessionManager,
  getSessionManager,
  randomInstallationId,
  userMessage,
};
