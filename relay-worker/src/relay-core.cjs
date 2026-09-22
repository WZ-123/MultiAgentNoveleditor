'use strict';

const ACCESS_TTL_SECONDS = 15 * 60;
const OFFLINE_LEASE_TTL_SECONDS = 7 * 24 * 60 * 60;
const CLOCK_SKEW_SECONDS = 60;
const EXCHANGE_BODY_LIMIT = 16 * 1024;
const FEEDBACK_BODY_LIMIT = 2 * 1024 * 1024;
const UPLOAD_BODY_LIMIT = 10 * 1024 * 1024;
const ACCESS_AUDIENCE = 'mana-desktop';
const ACCESS_SCOPES = ['license:verify', 'feedback:submit', 'feedback:upload'];
const IDEMPOTENCY_TTL_SECONDS = 7 * 24 * 60 * 60;

function webCrypto() {
  const value = globalThis.crypto;
  if (!value?.subtle) throw new Error('Web Crypto API is unavailable');
  return value;
}

function bytes(value) {
  if (value instanceof Uint8Array) return value;
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) return new Uint8Array(value);
  return new TextEncoder().encode(String(value ?? ''));
}

function base64UrlEncode(value) {
  const input = bytes(value);
  let binary = '';
  for (const byte of input) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function base64UrlDecode(value) {
  const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function encodeJson(value) {
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)));
}

function decodeJson(value) {
  return JSON.parse(new TextDecoder().decode(base64UrlDecode(value)));
}

async function sha256(value) {
  const digest = await webCrypto().subtle.digest('SHA-256', bytes(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function diagnosticId() {
  const random = new Uint8Array(8);
  webCrypto().getRandomValues(random);
  return `relay-${[...random].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

function response(status, data, headers = {}) {
  return {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...headers,
    },
    body: JSON.stringify(data),
  };
}

function failure(status, code, options = {}) {
  return response(status, {
    ok: false,
    code,
    diagnosticId: options.diagnosticId || diagnosticId(),
    ...(options.details && typeof options.details === 'object' ? { details: options.details } : {}),
  });
}

function parsePrivateJwk(env) {
  let jwk;
  try { jwk = JSON.parse(String(env.RELAY_SIGNING_PRIVATE_JWK || '')); } catch { throw new Error('relay signing key is invalid'); }
  const kid = String(env.RELAY_SIGNING_KID || jwk?.kid || '').trim();
  if (jwk?.kty !== 'EC' || jwk?.crv !== 'P-256' || !jwk?.x || !jwk?.y || !jwk?.d || !kid) {
    throw new Error('relay signing key must be a private P-256 JWK with kid');
  }
  return { ...jwk, kid };
}

function publicJwk(privateJwk) {
  const { d: _private, key_ops: _ops, ...publicPart } = privateJwk;
  return { ...publicPart, key_ops: ['verify'], use: 'sig', alg: 'ES256' };
}

async function signJwt(claims, env) {
  const jwk = parsePrivateJwk(env);
  const header = { alg: 'ES256', typ: 'JWT', kid: jwk.kid };
  const signingInput = `${encodeJson(header)}.${encodeJson(claims)}`;
  const key = await webCrypto().subtle.importKey(
    'jwk',
    { ...jwk, key_ops: ['sign'], use: 'sig', alg: 'ES256' },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  );
  const signature = await webCrypto().subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    new TextEncoder().encode(signingInput)
  );
  return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
}

function jwksFromEnv(env) {
  if (env.RELAY_PUBLIC_JWKS) {
    let parsed;
    try { parsed = JSON.parse(String(env.RELAY_PUBLIC_JWKS)); } catch { throw new Error('RELAY_PUBLIC_JWKS is invalid JSON'); }
    if (Array.isArray(parsed?.keys) && parsed.keys.length) return parsed;
  }
  return { keys: [publicJwk(parsePrivateJwk(env))] };
}

async function verifyJwt(token, env, options = {}) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw Object.assign(new Error('token is malformed'), { code: 'invalid_token' });
  let header;
  let claims;
  try {
    header = decodeJson(parts[0]);
    claims = decodeJson(parts[1]);
  } catch {
    throw Object.assign(new Error('token is malformed'), { code: 'invalid_token' });
  }
  if (header.alg !== 'ES256' || !header.kid) throw Object.assign(new Error('token algorithm is unsupported'), { code: 'invalid_token' });
  const jwk = jwksFromEnv(env).keys.find((item) => item?.kid === header.kid);
  if (!jwk || jwk.d) throw Object.assign(new Error('token signing key is unknown'), { code: 'invalid_token' });
  const key = await webCrypto().subtle.importKey(
    'jwk',
    { ...jwk, key_ops: ['verify'], use: 'sig', alg: 'ES256' },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify']
  );
  const valid = await webCrypto().subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    base64UrlDecode(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
  );
  if (!valid) throw Object.assign(new Error('token signature is invalid'), { code: 'invalid_token' });
  const now = Number(options.nowSeconds ?? Math.floor(Date.now() / 1000));
  const skew = Number(options.clockSkewSeconds ?? CLOCK_SKEW_SECONDS);
  if (claims.iss !== String(env.RELAY_ISSUER || '').trim() || claims.aud !== ACCESS_AUDIENCE) {
    throw Object.assign(new Error('token issuer or audience is invalid'), { code: 'invalid_token' });
  }
  if (!Number.isFinite(claims.iat) || claims.iat > now + skew || !Number.isFinite(claims.exp) || claims.exp < now - skew) {
    throw Object.assign(new Error('token is expired or not active'), { code: 'token_expired' });
  }
  if (options.tokenType && claims.tokenType !== options.tokenType) {
    throw Object.assign(new Error('token type is invalid'), { code: 'invalid_token' });
  }
  if (options.requiredScope && !Array.isArray(claims.scope) || options.requiredScope && !claims.scope.includes(options.requiredScope)) {
    throw Object.assign(new Error('token scope is insufficient'), { code: 'insufficient_scope' });
  }
  return claims;
}

function normalizeLicenseExpiry(value) {
  if (value == null || value === '') return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    const milliseconds = numeric < 10_000_000_000 ? numeric * 1000 : numeric;
    const date = new Date(milliseconds);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

async function issueSession({ authCode, installationId, license }, env, options = {}) {
  const now = Number(options.nowSeconds ?? Math.floor(Date.now() / 1000));
  const issuer = String(env.RELAY_ISSUER || '').trim();
  const pepper = String(env.RELAY_AUTH_CODE_PEPPER || '').trim();
  if (!issuer || pepper.length < 16) throw new Error('relay issuer or auth-code pepper is not configured');
  const installationIdHash = await sha256(`installation:${installationId}`);
  const subject = String(license.subject || await sha256(`license:${pepper}:${authCode}`));
  const licenseExpiry = normalizeLicenseExpiry(license.expiresAt);
  const licenseExpSeconds = licenseExpiry ? Math.floor(licenseExpiry.getTime() / 1000) : now + OFFLINE_LEASE_TTL_SECONDS;
  const accessExp = Math.min(now + ACCESS_TTL_SECONDS, licenseExpSeconds);
  const leaseExp = Math.min(now + OFFLINE_LEASE_TTL_SECONDS, licenseExpSeconds);
  if (accessExp <= now || leaseExp <= now) throw Object.assign(new Error('license is expired'), { code: 'expired' });
  const common = {
    iss: issuer,
    aud: ACCESS_AUDIENCE,
    sub: subject,
    installationIdHash,
    iat: now,
    jti: diagnosticId(),
  };
  const accessToken = await signJwt({ ...common, exp: accessExp, tokenType: 'access', scope: ACCESS_SCOPES }, env);
  const offlineLease = await signJwt({ ...common, exp: leaseExp, tokenType: 'offline-lease', scope: ['license:verify'] }, env);
  return {
    accessToken,
    expiresAt: new Date(accessExp * 1000).toISOString(),
    offlineLease,
    deviceCount: Number(license.deviceCount || 0),
    maxDevices: Number(license.maxDevices || 0),
    licenseExpiresAt: licenseExpiry ? licenseExpiry.toISOString() : null,
  };
}

function header(headers, name) {
  if (!headers) return '';
  if (typeof headers.get === 'function') return String(headers.get(name) || '');
  const wanted = name.toLowerCase();
  const found = Object.entries(headers).find(([key]) => String(key).toLowerCase() === wanted);
  return String(found?.[1] || '');
}

function bodyLength(request) {
  const declared = Number(header(request.headers, 'content-length'));
  if (Number.isFinite(declared) && declared >= 0) return declared;
  return bytes(request.body || '').byteLength;
}

function parseJsonBody(request) {
  try {
    const raw = typeof request.body === 'string'
      ? request.body
      : new TextDecoder().decode(bytes(request.body || ''));
    return JSON.parse(raw || '{}');
  } catch {
    throw Object.assign(new Error('request body is not valid JSON'), { code: 'invalid_request' });
  }
}

function relayState(env) {
  const store = env.RELAY_STATE_STORE;
  if (!store || typeof store.consume !== 'function' || typeof store.getIdempotency !== 'function'
    || typeof store.claimIdempotency !== 'function' || typeof store.completeIdempotency !== 'function'
    || typeof store.releaseIdempotency !== 'function') {
    throw Object.assign(new Error('relay persistent state is unavailable'), { code: 'relay_state_unavailable' });
  }
  return store;
}

async function consumeRateLimit(env, key, limit, windowSeconds, nowSeconds) {
  return relayState(env).consume(key, limit, windowSeconds, nowSeconds);
}

function createMemoryRelayState() {
  const rates = new Map();
  const idempotency = new Map();
  return {
    async consume(key, limit, windowSeconds, nowSeconds) {
      const bucket = Math.floor(nowSeconds / windowSeconds);
      const mapKey = `${key}:${bucket}`;
      const next = (rates.get(mapKey) || 0) + 1;
      rates.set(mapKey, next);
      return next <= limit;
    },
    async getIdempotency(key, nowSeconds) {
      const entry = idempotency.get(key);
      if (!entry || entry.expiresAt <= nowSeconds) {
        idempotency.delete(key);
        return null;
      }
      return entry.status === 'done' ? entry.value : { pending: true };
    },
    async claimIdempotency(key, token, ttlSeconds, nowSeconds) {
      const existing = idempotency.get(key);
      if (existing && existing.expiresAt > nowSeconds) return false;
      idempotency.set(key, { status: 'pending', token, expiresAt: nowSeconds + ttlSeconds });
      return true;
    },
    async completeIdempotency(key, token, value, ttlSeconds, nowSeconds) {
      const existing = idempotency.get(key);
      if (!existing || existing.status !== 'pending' || existing.token !== token) return false;
      idempotency.set(key, { status: 'done', value, expiresAt: nowSeconds + ttlSeconds });
      return true;
    },
    async releaseIdempotency(key, token) {
      const existing = idempotency.get(key);
      if (existing?.status === 'pending' && existing.token === token) idempotency.delete(key);
    },
  };
}

async function runIdempotent(env, key, nowSeconds, operation) {
  const store = relayState(env);
  const existing = await store.getIdempotency(key, nowSeconds);
  if (existing && !existing.pending) return existing;
  const token = diagnosticId();
  if (!await store.claimIdempotency(key, token, IDEMPOTENCY_TTL_SECONDS, nowSeconds)) {
    throw Object.assign(new Error('request with this idempotency key is already running'), { code: 'request_in_progress' });
  }
  try {
    const value = await operation();
    if (!await store.completeIdempotency(key, token, value, IDEMPOTENCY_TTL_SECONDS, nowSeconds)) {
      throw Object.assign(new Error('idempotency result could not be persisted'), { code: 'relay_state_unavailable' });
    }
    return value;
  } catch (error) {
    await store.releaseIdempotency(key, token).catch(() => {});
    throw error;
  }
}

async function authorize(request, env, scope, nowSeconds) {
  const authorization = header(request.headers, 'authorization');
  if (!authorization.startsWith('Bearer ')) throw Object.assign(new Error('bearer token is required'), { code: 'missing_token' });
  return verifyJwt(authorization.slice(7), env, { nowSeconds, tokenType: 'access', requiredScope: scope });
}

function v1Tombstone(path) {
  return path === '/api/v1/auth/verify'
    || path === '/api/v1/feedback/upload'
    || path === '/api/v1/feedback/submit';
}

function createRelayCore({ env, handlers, now = () => Date.now() }) {
  if (!handlers?.exchangeLicense || !handlers?.uploadFeedback || !handlers?.submitFeedback) {
    throw new Error('relay handlers are incomplete');
  }

  return async function route(request) {
    const method = String(request.method || 'GET').toUpperCase();
    const path = String(request.path || '/');
    const nowSeconds = Math.floor(Number(now()) / 1000);
    const ip = String(request.remoteAddress || 'unknown');
    try {
      if (method === 'OPTIONS') return response(204, {});
      if (v1Tombstone(path)) return failure(426, 'upgrade_required');
      if (method === 'GET' && path === '/api/v1/health') return response(200, { ok: true, deprecated: true, minimumApiVersion: 2 });
      if (method === 'GET' && path === '/api/v2/health') return response(200, { ok: true, apiVersion: 2 });

      if (method === 'POST' && path === '/api/v2/session/exchange') {
        if (bodyLength(request) > EXCHANGE_BODY_LIMIT) return failure(413, 'request_too_large');
        if (!await consumeRateLimit(env, `exchange-ip:${ip}`, 5, 60, nowSeconds)) return failure(429, 'rate_limited');
        const data = parseJsonBody(request);
        const authCode = String(data.authCode || '').trim();
        const installationId = String(data.installationId || '').trim();
        const appVersion = String(data.appVersion || '').trim();
        const platform = String(data.platform || '').trim();
        if (!authCode || !/^[A-Za-z0-9_-]{20,128}$/.test(installationId) || !appVersion || !platform) {
          return failure(400, 'invalid_request');
        }
        const codeHash = await sha256(`limit:${String(env.RELAY_AUTH_CODE_PEPPER || '')}:${authCode}`);
        if (!await consumeRateLimit(env, `exchange-code:${codeHash}`, 20, 24 * 60 * 60, nowSeconds)) return failure(429, 'rate_limited');
        const license = await handlers.exchangeLicense({ authCode, installationIdHash: await sha256(`installation:${installationId}`), appVersion, platform });
        if (!license?.valid) {
          const code = ['invalid_code', 'expired', 'device_limit_reached', 'license_revoked'].includes(license?.reason)
            ? license.reason
            : 'license_unavailable';
          return failure(code === 'license_unavailable' ? 503 : 403, code, {
            details: code === 'device_limit_reached'
              ? { deviceCount: Number(license.deviceCount || 0), maxDevices: Number(license.maxDevices || 0) }
              : undefined,
          });
        }
        return response(200, await issueSession({ authCode, installationId, license }, env, { nowSeconds }));
      }

      if (method === 'POST' && path === '/api/v2/feedback/upload') {
        if (bodyLength(request) > UPLOAD_BODY_LIMIT) return failure(413, 'request_too_large');
        const claims = await authorize(request, env, 'feedback:upload', nowSeconds);
        if (!await consumeRateLimit(env, `upload:${claims.sub}`, 10, 60, nowSeconds)) return failure(429, 'rate_limited');
        const idempotencyKey = header(request.headers, 'idempotency-key');
        const feedbackId = header(request.headers, 'x-feedback-id');
        const attachmentHash = header(request.headers, 'x-attachment-sha256').toLowerCase();
        if (!feedbackId || feedbackId.length > 128 || !/^[a-f0-9]{64}$/u.test(attachmentHash)) return failure(400, 'invalid_request');
        if (idempotencyKey !== `${feedbackId}:${attachmentHash}`) return failure(400, 'idempotency_key_invalid');
        const stateKey = `upload:${claims.sub}:${await sha256(idempotencyKey)}`;
        return response(200, await runIdempotent(env, stateKey, nowSeconds, () => handlers.uploadFeedback({
          request, claims, idempotencyKey, feedbackId, attachmentHash,
        })));
      }

      if (method === 'POST' && path === '/api/v2/feedback/submit') {
        if (bodyLength(request) > FEEDBACK_BODY_LIMIT) return failure(413, 'request_too_large');
        const claims = await authorize(request, env, 'feedback:submit', nowSeconds);
        if (!await consumeRateLimit(env, `submit:${claims.sub}`, 30, 60, nowSeconds)) return failure(429, 'rate_limited');
        const data = parseJsonBody(request);
        if (!data.feedbackId || !data.fields || typeof data.fields !== 'object' || Array.isArray(data.fields)) return failure(400, 'invalid_request');
        const idempotencyKey = header(request.headers, 'idempotency-key');
        if (idempotencyKey !== String(data.feedbackId)) return failure(400, 'idempotency_key_invalid');
        const stateKey = `submit:${claims.sub}:${await sha256(idempotencyKey)}`;
        return response(200, await runIdempotent(env, stateKey, nowSeconds, () => handlers.submitFeedback({ data, claims, idempotencyKey })));
      }

      return failure(404, 'not_found');
    } catch (error) {
      if (['missing_token', 'invalid_token', 'token_expired'].includes(error?.code)) return failure(401, error.code);
      if (error?.code === 'insufficient_scope') return failure(403, error.code);
      if (error?.code === 'invalid_request') return failure(400, error.code);
      if (error?.code === 'request_in_progress') return failure(409, error.code);
      if (error?.code === 'relay_state_unavailable') return failure(503, error.code);
      return failure(500, 'internal_error');
    }
  };
}

module.exports = {
  ACCESS_AUDIENCE,
  ACCESS_SCOPES,
  ACCESS_TTL_SECONDS,
  CLOCK_SKEW_SECONDS,
  EXCHANGE_BODY_LIMIT,
  FEEDBACK_BODY_LIMIT,
  IDEMPOTENCY_TTL_SECONDS,
  OFFLINE_LEASE_TTL_SECONDS,
  UPLOAD_BODY_LIMIT,
  base64UrlDecode,
  base64UrlEncode,
  createMemoryRelayState,
  createRelayCore,
  issueSession,
  jwksFromEnv,
  normalizeLicenseExpiry,
  publicJwk,
  sha256,
  signJwt,
  verifyJwt,
};
