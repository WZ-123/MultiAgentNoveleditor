'use strict';

const { createFeishuRelayHandlers } = require('./feishu-handlers.cjs');
const { createRelayCore } = require('./relay-core.cjs');
const { createScfRedisRelayState } = require('./scf-redis-state.cjs');

function buildUrl(event) {
  const path = event.path || event.requestContext?.path || '/';
  const query = event.queryString || event.queryStringParameters || {};
  const encoded = new URLSearchParams(query).toString();
  return `https://${event.headers?.Host || event.headers?.host || 'localhost'}${path}${encoded ? `?${encoded}` : ''}`;
}

function buildHeaders(event) {
  const headers = {};
  for (const [key, value] of Object.entries(event.headers || {})) {
    headers[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  return headers;
}

function parseBody(event) {
  if (!event.body) return Buffer.alloc(0);
  return Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'utf8');
}

function environment(source = process.env, stateStore) {
  return {
    FEISHU_APP_ID: source.FEISHU_APP_ID || '',
    FEISHU_APP_SECRET: source.FEISHU_APP_SECRET || '',
    FEISHU_APP_TOKEN: source.FEISHU_APP_TOKEN || '',
    FEISHU_TABLE_ID: source.FEISHU_TABLE_ID || '',
    FEISHU_AUTH_TABLE_ID: source.FEISHU_AUTH_TABLE_ID || '',
    RELAY_SIGNING_KID: source.RELAY_SIGNING_KID || '',
    RELAY_SIGNING_PRIVATE_JWK: source.RELAY_SIGNING_PRIVATE_JWK || '',
    RELAY_PUBLIC_JWKS: source.RELAY_PUBLIC_JWKS || '',
    RELAY_ISSUER: source.RELAY_ISSUER || '',
    RELAY_AUTH_CODE_PEPPER: source.RELAY_AUTH_CODE_PEPPER || '',
    RELAY_STATE_STORE: stateStore === undefined
      ? createScfRedisRelayState(source.RELAY_REDIS_URL || '')
      : stateStore,
  };
}

async function handleScfEvent(event, options = {}) {
  const headers = buildHeaders(event);
  const env = environment(options.env || process.env, options.stateStore);
  const core = createRelayCore({
    env,
    handlers: options.handlers || createFeishuRelayHandlers(env, options),
  });
  const response = await core({
    method: event.httpMethod || event.requestContext?.httpMethod || 'GET',
    path: new URL(buildUrl(event)).pathname,
    headers,
    body: parseBody(event),
    contentType: headers['content-type'] || '',
    remoteAddress: headers['x-forwarded-for']?.split(',')[0]?.trim() || event.requestContext?.sourceIp || 'unknown',
  });
  return {
    statusCode: response.status,
    headers: response.headers,
    body: response.status === 204 ? '' : response.body,
    isBase64Encoded: false,
  };
}

exports.main_handler = async (event) => {
  try {
    return await handleScfEvent(event);
  } catch {
    console.error('[scf] unhandled relay error');
    return {
      isBase64Encoded: false,
      statusCode: 500,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
      body: JSON.stringify({ ok: false, code: 'internal_error' }),
    };
  }
};

exports.__test = { buildHeaders, buildUrl, environment, handleScfEvent, parseBody };
