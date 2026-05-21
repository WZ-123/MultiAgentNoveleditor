'use strict';

const http = require('node:http');

const PORT = Number(process.env.MANA_DEV_AUTH_RELAY_PORT || 8789);
const API_KEY = process.env.MANA_DEV_AUTH_API_KEY || 'mana-dev-relay-key';
const AUTH_CODE = process.env.MANA_DEV_AUTH_CODE || '114514';
const MAX_DEVICES = Number(process.env.MANA_DEV_AUTH_MAX_DEVICES || 5);
const EXPIRES_DAYS = Number(process.env.MANA_DEV_AUTH_EXPIRES_DAYS || 7);

function json(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Relay-Api-Key',
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

function requireApiKey(req, res) {
  const apiKey = req.headers['x-relay-api-key'] || '';
  if (apiKey !== API_KEY) {
    json(res, 401, { error: 'Unauthorized' });
    return false;
  }
  return true;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'OPTIONS') {
    json(res, 204, {});
    return;
  }

  if (url.pathname !== '/api/v1/health' && !requireApiKey(req, res)) {
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/v1/health') {
    json(res, 200, { ok: true, mode: 'dev-auth-relay' });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/v1/auth/verify') {
    const raw = await readBody(req);
    let body;
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      json(res, 400, { error: 'Invalid JSON body' });
      return;
    }

    const { code, deviceId } = body || {};
    if (!code || !deviceId) {
      json(res, 400, { error: 'Missing code or deviceId' });
      return;
    }

    if (String(code).trim() !== AUTH_CODE) {
      json(res, 403, { valid: false, reason: 'invalid_code' });
      return;
    }

    const expiresAt = new Date(Date.now() + EXPIRES_DAYS * 24 * 60 * 60 * 1000).toISOString();
    json(res, 200, {
      valid: true,
      deviceCount: 1,
      maxDevices: MAX_DEVICES,
      expiresAt,
      deviceRegistered: true,
      authMode: 'local-dev',
    });
    return;
  }

  json(res, 404, { error: 'Not found' });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[dev-auth-relay] listening on http://127.0.0.1:${PORT}`);
  console.log(`[dev-auth-relay] expected auth code: ${AUTH_CODE}`);
});

process.on('SIGINT', () => server.close(() => process.exit(0)));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
