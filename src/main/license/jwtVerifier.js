'use strict';

const crypto = require('node:crypto');

const CLOCK_SKEW_SECONDS = 60;

function decodeBase64Url(value) {
  return Buffer.from(String(value || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function decodeJson(value) {
  return JSON.parse(decodeBase64Url(value).toString('utf8'));
}

function tokenError(code) {
  return Object.assign(new Error(code), { code });
}

async function installationIdHash(installationId) {
  return crypto.createHash('sha256').update(`installation:${String(installationId || '')}`).digest('hex');
}

async function verifySignedToken(token, options = {}) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw tokenError('invalid_token');
  let header;
  let claims;
  try {
    header = decodeJson(parts[0]);
    claims = decodeJson(parts[1]);
  } catch {
    throw tokenError('invalid_token');
  }
  if (header.alg !== 'ES256' || !header.kid) throw tokenError('invalid_token');
  const jwk = options.jwks?.keys?.find((item) => item?.kid === header.kid);
  if (!jwk || jwk.d || jwk.kty !== 'EC' || jwk.crv !== 'P-256') throw tokenError('invalid_token');
  let key;
  try {
    key = await crypto.webcrypto.subtle.importKey(
      'jwk',
      { ...jwk, key_ops: ['verify'], alg: 'ES256', use: 'sig' },
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify']
    );
  } catch {
    throw tokenError('invalid_token');
  }
  const valid = await crypto.webcrypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    decodeBase64Url(parts[2]),
    Buffer.from(`${parts[0]}.${parts[1]}`, 'utf8')
  );
  if (!valid) throw tokenError('invalid_token');
  const now = Number(options.nowSeconds ?? Math.floor(Date.now() / 1000));
  const skew = Number(options.clockSkewSeconds ?? CLOCK_SKEW_SECONDS);
  if (claims.iss !== options.issuer || claims.aud !== 'mana-desktop') throw tokenError('invalid_token');
  if (!Number.isFinite(claims.iat) || claims.iat > now + skew) throw tokenError('invalid_token');
  if (!Number.isFinite(claims.exp) || claims.exp < now - skew) throw tokenError('token_expired');
  if (options.tokenType && claims.tokenType !== options.tokenType) throw tokenError('invalid_token');
  if (options.requiredScope && (!Array.isArray(claims.scope) || !claims.scope.includes(options.requiredScope))) {
    throw tokenError('insufficient_scope');
  }
  if (options.installationId) {
    const expected = await installationIdHash(options.installationId);
    if (claims.installationIdHash !== expected) throw tokenError('invalid_token');
  }
  return claims;
}

module.exports = { CLOCK_SKEW_SECONDS, installationIdHash, verifySignedToken };
