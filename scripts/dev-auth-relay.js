'use strict';

const http = require('node:http');
const { createMemoryRelayState, createRelayCore } = require('../relay-worker/src/relay-core.cjs');

const PORT = Number(process.env.MANA_DEV_AUTH_RELAY_PORT || 8789);
const AUTH_CODE = process.env.MANA_DEV_AUTH_CODE || '114514';
const MAX_DEVICES = Number(process.env.MANA_DEV_AUTH_MAX_DEVICES || 5);
const EXPIRES_DAYS = Number(process.env.MANA_DEV_AUTH_EXPIRES_DAYS || 7);

function readBody(req, limit = 11 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('request_too_large'), { code: 'request_too_large' }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function env() {
  return {
    RELAY_SIGNING_KID: process.env.RELAY_SIGNING_KID || '',
    RELAY_SIGNING_PRIVATE_JWK: process.env.RELAY_SIGNING_PRIVATE_JWK || '',
    RELAY_PUBLIC_JWKS: process.env.RELAY_PUBLIC_JWKS || '',
    RELAY_ISSUER: process.env.RELAY_ISSUER || `http://127.0.0.1:${PORT}`,
    RELAY_AUTH_CODE_PEPPER: process.env.RELAY_AUTH_CODE_PEPPER || 'local-development-pepper-only',
    RELAY_STATE_STORE: createMemoryRelayState(),
  };
}

const core = createRelayCore({
  env: env(),
  handlers: {
    exchangeLicense: async ({ authCode }) => authCode === AUTH_CODE
      ? { valid: true, deviceCount: 1, maxDevices: MAX_DEVICES, expiresAt: new Date(Date.now() + EXPIRES_DAYS * 86400000).toISOString() }
      : { valid: false, reason: 'invalid_code' },
    uploadFeedback: async ({ idempotencyKey }) => ({ fileToken: `dev-file-${idempotencyKey}`, fileName: 'dev-attachment' }),
    submitFeedback: async ({ data }) => ({ recordId: `dev-record-${data.feedbackId}`, status: 'created' }),
  },
});

const server = http.createServer(async (req, res) => {
  try {
    const body = await readBody(req);
    const url = new URL(req.url || '/', `http://${req.headers.host || `127.0.0.1:${PORT}`}`);
    const result = await core({
      method: req.method,
      path: url.pathname,
      headers: req.headers,
      body,
      contentType: req.headers['content-type'] || '',
      remoteAddress: req.socket.remoteAddress || 'unknown',
    });
    res.writeHead(result.status, result.headers);
    res.end(result.status === 204 ? '' : result.body);
  } catch {
    res.writeHead(500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ok: false, code: 'internal_error' }));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[dev-auth-relay] V2 listening on http://127.0.0.1:${PORT}`);
});

process.on('SIGINT', () => server.close(() => process.exit(0)));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
