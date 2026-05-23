'use strict';

const os = require('node:os');
const crypto = require('node:crypto');
const { dialog } = require('electron');
const appConfig = require('../store/appConfig');

const DEVICE_SEED = 'mana-device-v1';
const VERIFY_ENDPOINT = '/api/v1/auth/verify';

function getDeviceId() {
  const host = os.hostname() || 'unknown-host';
  let user = 'unknown-user';
  try {
    user = os.userInfo().username || process.env.USERNAME || process.env.USER || 'unknown-user';
  } catch {
    // os.userInfo() may fail on Windows with non-ASCII usernames or restricted permissions
    user = process.env.USERNAME || process.env.USER || 'unknown-user';
  }
  const input = `${DEVICE_SEED}:${host}:${user}`;
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, 32);
}

async function verifyLicense(options = {}) {
  const { silent = false, forceOnline = false } = options;
  const cfg = await appConfig.load();
  const license = cfg.license || {};

  // Development mode: skip license verification (unless MANA_FORCE_AUTH=1)
  const isDev = process.env.NODE_ENV !== 'production';
  const forceAuth = process.env.MANA_FORCE_AUTH === '1';
  let isPackaged = false;
  try {
    const { app } = require('electron');
    isPackaged = Boolean(app?.isPackaged);
    if (!forceAuth && isDev && app && !isPackaged) {
      return { valid: true, skipped: true, reason: 'dev_mode' };
    }
  } catch {
    // electron not available (e.g. test harness)
  }

  // If no relay config, skip auth (fallback for dev/test)
  const relayUrl = cfg.feishuSync?.relayUrl;
  const relayApiKey = cfg.feishuSync?.relayApiKey;
  if (!relayUrl || !relayApiKey) {
    if (forceAuth || isPackaged) {
      const message = '未配置认证服务（relayUrl / relayApiKey）。请先配置后再进行授权码验证。';
      if (!silent) {
        dialog.showErrorBox('授权验证失败', message);
      }
      return { valid: false, reason: 'missing_relay_config', message };
    }
    return { valid: true, skipped: true, reason: 'no_relay_config' };
  }

  const authCode = license.authCode;
  if (!authCode) {
    if (!silent) {
      dialog.showErrorBox(
        '授权验证失败',
        '未配置授权码。请联系管理员获取授权码后在设置中填写。'
      );
    }
    return { valid: false, reason: 'no_auth_code' };
  }

  // Check local cache (allow offline usage within grace period)
  const now = Date.now();
  const cachedUntil = license.verifiedUntil ? new Date(license.verifiedUntil).getTime() : 0;
  if (!forceOnline && cachedUntil > now) {
    return { valid: true, cached: true, verifiedUntil: license.verifiedUntil };
  }

  const deviceId = getDeviceId();

  try {
    const res = await fetch(`${relayUrl}${VERIFY_ENDPOINT}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Relay-Api-Key': relayApiKey,
      },
      body: JSON.stringify({ code: authCode, deviceId }),
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok || !data.valid) {
      const reason = data.reason || 'unknown';
      const message = reason === 'expired'
        ? `授权码已过期（过期时间：${data.expiresAt || '未知'}）`
        : reason === 'invalid_code'
          ? '授权码无效'
          : reason === 'device_limit_reached'
            ? `设备数量已达上限（${data.deviceCount}/${data.maxDevices}）`
            : `授权验证失败：${data.error || reason}`;

      if (!silent) {
        dialog.showErrorBox('授权验证失败', message);
      }
      return { valid: false, reason, message };
    }

    // Cache success: set verifiedUntil to 7 days from now
    const verifiedUntil = new Date(now + 7 * 24 * 60 * 60 * 1000).toISOString();
    await appConfig.save({
      license: {
        ...license,
        verifiedUntil,
        deviceId,
      },
    });

    return {
      valid: true,
      deviceCount: data.deviceCount,
      maxDevices: data.maxDevices,
      expiresAt: data.expiresAt,
      deviceRegistered: data.deviceRegistered,
    };
  } catch (err) {
    // Network error: allow if cache is within 3-day grace period
    const gracePeriod = 3 * 24 * 60 * 60 * 1000;
    if (cachedUntil > now - gracePeriod) {
      return { valid: true, offline: true, reason: 'network_error', verifiedUntil: license.verifiedUntil };
    }

    const message = `网络错误，无法验证授权：${err.message}`;
    if (!silent) {
      dialog.showErrorBox('授权验证失败', message);
    }
    return { valid: false, reason: 'network_error', message };
  }
}

async function promptForAuthCode() {
  // Electron dialog does not support input prompts natively.
  // Return null for now; UI should handle this via a dedicated window or IPC.
  return null;
}

module.exports = { verifyLicense, promptForAuthCode, getDeviceId };
