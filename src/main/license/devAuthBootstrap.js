'use strict';

const appConfig = require('../store/appConfig');

function getDevAuthRelayDefaults() {
  const port = Number(process.env.MANA_DEV_AUTH_RELAY_PORT || 8789);
  return {
    relayUrl: process.env.MANA_DEV_AUTH_RELAY_URL || `http://127.0.0.1:${port}`,
    relayApiKey: process.env.MANA_DEV_AUTH_RELAY_API_KEY || 'mana-dev-relay-key',
  };
}

async function ensureDevAuthRelayConfig() {
  const forceAuth = process.env.MANA_FORCE_AUTH === '1';
  if (!forceAuth) {
    return { skipped: true, reason: 'not_force_auth' };
  }

  const defaults = getDevAuthRelayDefaults();
  const cfg = await appConfig.load();
  const currentFeishu = cfg.feishuSync || {};
  const needsRelayUrl = !currentFeishu.relayUrl;
  const needsRelayApiKey = !currentFeishu.relayApiKey;

  if (needsRelayUrl || needsRelayApiKey) {
    await appConfig.save({
      feishuSync: {
        ...currentFeishu,
        enabled: true,
        endpointProfile: currentFeishu.endpointProfile || 'dev',
        relayUrl: currentFeishu.relayUrl || defaults.relayUrl,
        relayApiKey: currentFeishu.relayApiKey || defaults.relayApiKey,
      },
    });
    return { seeded: true, ...defaults };
  }

  return { seeded: false, ...defaults };
}

module.exports = { ensureDevAuthRelayConfig, getDevAuthRelayDefaults };