'use strict';

const RENDERER_DEV_URL_ENV = 'MANA_RENDERER_DEV_URL';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

function normalizeRendererDevOrigin(rawValue) {
  const value = typeof rawValue === 'string' ? rawValue.trim() : '';
  if (!value) return null;

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${RENDERER_DEV_URL_ENV} must be a valid URL`);
  }

  if (parsed.protocol !== 'http:') {
    throw new Error(`${RENDERER_DEV_URL_ENV} must use http`);
  }
  if (!LOOPBACK_HOSTS.has(parsed.hostname)) {
    throw new Error(`${RENDERER_DEV_URL_ENV} must point to a loopback host`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`${RENDERER_DEV_URL_ENV} must not contain credentials`);
  }
  if ((parsed.pathname && parsed.pathname !== '/') || parsed.search || parsed.hash) {
    throw new Error(`${RENDERER_DEV_URL_ENV} must contain only an origin`);
  }

  return parsed.origin;
}

function getRendererDevOrigin(env = process.env) {
  return normalizeRendererDevOrigin(env?.[RENDERER_DEV_URL_ENV]);
}

module.exports = {
  RENDERER_DEV_URL_ENV,
  getRendererDevOrigin,
  normalizeRendererDevOrigin,
};
