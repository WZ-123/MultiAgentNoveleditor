'use strict';

const { dialog } = require('electron');
const { getSessionManager } = require('./sessionManager');

async function verifyLicense(options = {}) {
  const result = await getSessionManager().verifyLicense(options);
  if (!result.valid && options.silent !== true) {
    dialog.showErrorBox('授权验证失败', result.message || '授权验证未能完成。');
  }
  return result;
}

async function setAuthCode(authCode) {
  return getSessionManager().setAuthCode(authCode);
}

async function getInstallationId() {
  await getSessionManager().prepareSecureState();
  return getSessionManager().ensureInstallationId();
}

module.exports = { getInstallationId, setAuthCode, verifyLicense };
