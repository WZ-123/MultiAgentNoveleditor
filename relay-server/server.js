'use strict';

const http = require('node:http');
const fs = require('node:fs').promises;
const path = require('node:path');

const feishuAdapter = require('./feishuAdapter');
const fieldMapper = require('./fieldMapper');

// ---------------------------------------------------------------------------
// Config from environment
// ---------------------------------------------------------------------------
const PORT = Number(process.env.RELAY_PORT) || 3456;
const RELAY_API_KEY = process.env.RELAY_API_KEY || '';
const FEISHU_APP_ID = process.env.FEISHU_APP_ID || '';
const FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET || '';
const FEISHU_APP_TOKEN = process.env.FEISHU_APP_TOKEN || '';
const FEISHU_TABLE_ID = process.env.FEISHU_TABLE_ID || '';

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function checkConfig() {
  const missing = [];
  if (!RELAY_API_KEY) missing.push('RELAY_API_KEY');
  if (!FEISHU_APP_ID) missing.push('FEISHU_APP_ID');
  if (!FEISHU_APP_SECRET) missing.push('FEISHU_APP_SECRET');
  if (!FEISHU_APP_TOKEN) missing.push('FEISHU_APP_TOKEN');
  if (!FEISHU_TABLE_ID) missing.push('FEISHU_TABLE_ID');
  if (missing.length > 0) {
    console.error('[relay-server] Missing env vars:', missing.join(', '));
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Simple multipart parser (sufficient for single-file upload)
// ---------------------------------------------------------------------------
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
    const endBuffer = Buffer.from(`--${boundary}--`);

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
        const part = body.slice(idx + boundaryBuffer.length, partEnd);
        // Remove leading \r\n and trailing \r\n before boundary
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
          const ctMatch = header.match(/Content-Type:\s*([^\r\n]+)/i);
          files.push({
            name,
            filename,
            mimeType: ctMatch ? ctMatch[1].trim() : 'application/octet-stream',
            data,
          });
        } else {
          fields[name] = data.toString('utf8');
        }
      }

      resolve({ fields, files });
    });
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(JSON.parse(text));
      } catch (e) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Auth middleware
// ---------------------------------------------------------------------------
function requireAuth(req, res) {
  const key = req.headers['x-relay-api-key'] || '';
  if (key !== RELAY_API_KEY) {
    sendJson(res, 401, { error: 'Unauthorized' });
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Feishu helpers
// ---------------------------------------------------------------------------
async function getToken() {
  const result = await feishuAdapter.getTenantAccessToken(FEISHU_APP_ID, FEISHU_APP_SECRET);
  return result.token;
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------
async function handleHealth(req, res) {
  sendJson(res, 200, { ok: true, mode: 'relay' });
}

async function handleUpload(req, res) {
  if (!requireAuth(req, res)) return;

  let parsed;
  try {
    parsed = await parseMultipart(req);
  } catch (err) {
    sendJson(res, 400, { error: `Parse error: ${err.message}` });
    return;
  }

  const file = parsed.files.find((f) => f.name === 'file');
  if (!file) {
    sendJson(res, 400, { error: 'Missing file field' });
    return;
  }

  // Write to temp file then upload
  const tmpPath = path.join(require('node:os').tmpdir(), `relay-${Date.now()}-${file.filename || 'upload'}`);
  try {
    await fs.writeFile(tmpPath, file.data);
    const token = await getToken();
    const result = await feishuAdapter.uploadAttachment(FEISHU_APP_TOKEN, tmpPath, token);
    log('[upload] file uploaded, token=', result.fileToken);
    sendJson(res, 200, { fileToken: result.fileToken, fileName: result.fileName });
  } catch (err) {
    log('[upload] error:', err.message);
    const feishuErr = err.feishuError || { type: 'retryable', code: 'unknown', message: err.message };
    sendJson(res, 502, { error: err.message, feishuError: feishuErr });
  } finally {
    try { await fs.unlink(tmpPath); } catch { /* ignore */ }
  }
}

async function handleSubmit(req, res) {
  if (!requireAuth(req, res)) return;

  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    sendJson(res, 400, { error: err.message });
    return;
  }

  const { feedbackId, fields, fileTokens, remoteRecordId } = body || {};
  if (!fields || typeof fields !== 'object') {
    sendJson(res, 400, { error: 'Missing fields object' });
    return;
  }

  const token = await getToken();
  const bitableFields = { ...fields };

  // Attach file tokens to screenshot column
  const tokens = Array.isArray(fileTokens) ? fileTokens : [];
  if (tokens.length > 0) {
    bitableFields.screenshot = fieldMapper.toAttachmentField(tokens);
  }

  try {
    if (remoteRecordId) {
      // Update existing record (e.g. attachment binding retry)
      await feishuAdapter.updateRecord(FEISHU_APP_TOKEN, FEISHU_TABLE_ID, remoteRecordId, token, bitableFields);
      log('[submit] updated record', remoteRecordId, 'feedbackId=', feedbackId);
      sendJson(res, 200, { recordId: remoteRecordId, status: 'updated' });
    } else {
      const result = await feishuAdapter.createRecord(FEISHU_APP_TOKEN, FEISHU_TABLE_ID, token, bitableFields);
      log('[submit] created record', result.recordId, 'feedbackId=', feedbackId);
      sendJson(res, 200, { recordId: result.recordId, status: 'created' });
    }
  } catch (err) {
    log('[submit] error:', err.message);
    const feishuErr = err.feishuError || { type: 'retryable', code: 'unknown', message: err.message };
    sendJson(res, 502, { error: err.message, feishuError: feishuErr });
  }
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
const routes = {
  'GET /api/v1/health': handleHealth,
  'POST /api/v1/feedback/upload': handleUpload,
  'POST /api/v1/feedback/submit': handleSubmit,
};

function routeKey(method, pathname) {
  return `${method} ${pathname}`;
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const key = routeKey(req.method, url.pathname);
  const handler = routes[key];

  if (!handler) {
    sendJson(res, 404, { error: 'Not found' });
    return;
  }

  try {
    await handler(req, res);
  } catch (err) {
    log('[server] unhandled error:', err.message);
    sendJson(res, 500, { error: 'Internal server error' });
  }
});

// Graceful shutdown
process.on('SIGTERM', () => {
  log('[server] SIGTERM received, shutting down...');
  server.close(() => process.exit(0));
});

process.on('SIGINT', () => {
  log('[server] SIGINT received, shutting down...');
  server.close(() => process.exit(0));
});

// Start
checkConfig();
server.listen(PORT, () => {
  log(`[server] Feedback relay server listening on port ${PORT}`);
  log(`[server] Feishu appId=${FEISHU_APP_ID.slice(0, 4)}... tableId=${FEISHU_TABLE_ID.slice(0, 6)}...`);
});
