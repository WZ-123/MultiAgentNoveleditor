'use strict';

/**
 * Mock backup relay server for local testing.
 * Simulates the Cloudflare Worker fallback behavior without calling Feishu
 * APIs. Tencent Cloud SCF Web Function remains the primary deployment target.
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const PORT = process.env.MOCK_WORKER_PORT || 8787;
const RELAY_API_KEY = process.env.RELAY_API_KEY || 'test-key';

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-Relay-Api-Key',
  });
  res.end(body);
}

function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const contentType = req.headers['content-type'] || '';
    if (!contentType.includes('multipart/form-data')) {
      return reject(new Error('Expected multipart/form-data'));
    }
    const boundaryMatch = contentType.match(/boundary=([^;\s]+)/);
    if (!boundaryMatch) return reject(new Error('Missing boundary'));
    const boundary = boundaryMatch[1].trim().replace(/^"|"$/g, '');
    const boundaryBuffer = Buffer.from(`--${boundary}`);

    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const parts = [];
      let offset = 0;

      while (offset < body.length) {
        const idx = body.indexOf(boundaryBuffer, offset);
        if (idx === -1) break;
        const nextIdx = body.indexOf(boundaryBuffer, idx + boundaryBuffer.length);
        const partEnd = nextIdx === -1 ? body.length : nextIdx;
        let part = body.slice(idx + boundaryBuffer.length, partEnd);
        let start = 0;
        while (start < part.length && (part[start] === 0x0d || part[start] === 0x0a)) start++;
        let end = part.length;
        while (end > start && (part[end - 1] === 0x0d || part[end - 1] === 0x0a)) end--;
        if (end > start) parts.push(part.slice(start, end));
        offset = idx + boundaryBuffer.length;
        if (nextIdx === -1) break;
      }

      const fields = {};
      const files = [];

      for (const part of parts) {
        const headerEnd = part.indexOf('\r\n\r\n');
        if (headerEnd === -1) continue;
        const header = part.slice(0, headerEnd).toString('utf8');
        const data = part.slice(headerEnd + 4);

        const cdMatch = header.match(/Content-Disposition:\s*form-data;\s*name="([^"]+)"(?:;\s*filename="([^"]+)")?/i);
        if (!cdMatch) continue;

        const name = cdMatch[1];
        const filename = cdMatch[2];

        if (filename) {
          files.push({ name, filename, data });
        } else {
          fields[name] = data.toString('utf8');
        }
      }

      resolve({ fields, files });
    });
    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (e) {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Mock handlers
// ---------------------------------------------------------------------------

async function handleHealth(req, res) {
  sendJson(res, 200, { ok: true, mode: 'cloudflare-worker' });
}

async function handleUpload(req, res) {
  const parsed = await parseMultipart(req);
  const file = parsed.files.find((f) => f.name === 'file');
  if (!file) {
    sendJson(res, 400, { error: 'Missing file field' });
    return;
  }

  // Mock: pretend we uploaded to Feishu
  const mockToken = `mock-ft-${Date.now().toString(36)}`;
  console.log(`[mock] Uploaded ${file.filename} (${file.data.length} bytes) → ${mockToken}`);
  sendJson(res, 200, { fileToken: mockToken, fileName: file.filename });
}

async function handleSubmit(req, res) {
  const body = await readJsonBody(req);
  const { feedbackId, fields, fileTokens, remoteRecordId } = body || {};

  if (!fields || typeof fields !== 'object') {
    sendJson(res, 400, { error: 'Missing fields object' });
    return;
  }

  console.log(`[mock] ${remoteRecordId ? 'Update' : 'Create'} record feedbackId=${feedbackId} fields=${Object.keys(fields).join(',')}`);
  if (fileTokens?.length) {
    console.log(`[mock] Attachments: ${fileTokens.length} token(s)`);
  }

  const recordId = remoteRecordId || `mock-rec-${Date.now().toString(36)}`;
  sendJson(res, 200, {
    recordId,
    status: remoteRecordId ? 'updated' : 'created',
  });
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const routes = {
  'GET /api/v1/health': handleHealth,
  'POST /api/v1/feedback/upload': handleUpload,
  'POST /api/v1/feedback/submit': handleSubmit,
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const key = `${req.method} ${url.pathname}`;

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Relay-Api-Key',
    });
    res.end();
    return;
  }

  // Auth check (skip health)
  if (key !== 'GET /api/v1/health') {
    const apiKey = req.headers['x-relay-api-key'] || '';
    if (apiKey !== RELAY_API_KEY) {
      sendJson(res, 401, { error: 'Unauthorized' });
      return;
    }
  }

  const handler = routes[key];
  if (!handler) {
    sendJson(res, 404, { error: 'Not found' });
    return;
  }

  try {
    await handler(req, res);
  } catch (err) {
    console.error('[mock] error:', err.message);
    sendJson(res, 500, { error: 'Internal server error' });
  }
});

server.listen(PORT, () => {
  console.log(`[mock-worker] Listening on http://localhost:${PORT}`);
  console.log(`[mock-worker] API Key: ${RELAY_API_KEY}`);
});
