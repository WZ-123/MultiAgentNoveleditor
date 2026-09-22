'use strict';

const { loadReleasePublicConfig } = require('../release/publicConfig');

async function ensureDevAuthRelayConfig() {
  if (process.env.MANA_FORCE_AUTH !== '1') return { skipped: true, reason: 'not_force_auth' };
  const config = await loadReleasePublicConfig({ allowLocalHttp: process.env.MANA_ALLOW_LOCAL_RELAY === '1' });
  return { seeded: false, relayUrl: config.relayBaseUrl, environment: config.environment };
}

function getDevAuthRelayDefaults() {
  const port = Number(process.env.MANA_DEV_AUTH_RELAY_PORT || 8789);
  return { relayUrl: process.env.MANA_DEV_AUTH_RELAY_URL || `http://127.0.0.1:${port}` };
}

module.exports = { ensureDevAuthRelayConfig, getDevAuthRelayDefaults };
