'use strict';

/**
 * Tencent Cloud SCF Web Function — primary feedback/auth relay deployment.
 * Cloudflare Worker remains in this repo only as a backup fallback path.
 *
 * Paste this entire file into app.js in the SCF online editor.
 * Runtime: Node.js 18.15
 * After pasting, click Save.
 */

const http = require('http');
const url = require('url');

const FEISHU_API_HOST = 'open.feishu.cn';
const PORT = process.env.PORT || 9000;

function jsonResponse(data, statusCode = 200) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, X-Relay-Api-Key',
    },
    body: JSON.stringify(data),
  };
}

function normalizeFeishuError(statusCode, data) {
  const code = data?.code ?? -1;
  const msg = data?.msg || data?.error || `HTTP ${statusCode}`;

  if (statusCode >= 500) return { type: 'retryable', code: 'server_error', message: msg, httpStatus: statusCode, feishuCode: code };
  if (statusCode === 429) return { type: 'retryable', code: 'rate_limited', message: msg, httpStatus: statusCode, feishuCode: code };
  if (statusCode === 401 || statusCode === 403) return { type: 'terminal', code: 'auth_failed', message: msg, httpStatus: statusCode, feishuCode: code };
  if (code === 1254045 || code === 1254002) return { type: 'terminal', code: 'table_not_found', message: msg, httpStatus: statusCode, feishuCode: code };
  if (code === 1254043) return { type: 'terminal', code: 'field_not_found', message: msg, httpStatus: statusCode, feishuCode: code };
  if (code === 1254003 || code === 1254004) return { type: 'terminal', code: 'invalid_schema', message: msg, httpStatus: statusCode, feishuCode: code };
  if (statusCode >= 400 && statusCode < 500) return { type: 'terminal', code: 'client_error', message: msg, httpStatus: statusCode, feishuCode: code };

  return { type: 'retryable', code: 'unknown', message: msg, httpStatus: statusCode, feishuCode: code };
}

function doRequest(options, bodyData) {
  return new Promise((resolve, reject) => {
    const client = options.protocol === 'https:' ? require('https') : require('http');
    const req = client.request(options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        let data = null;
        try { data = JSON.parse(body); } catch { data = { raw: body }; }
        resolve({ statusCode: res.statusCode, data });
      });
    });
    req.on('error', (err) => reject(err));
    if (bodyData) req.write(bodyData);
    req.end();
  });
}

async function feishuRequest(path, method, token, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  const options = {
    protocol: 'https:',
    hostname: FEISHU_API_HOST,
    port: 443,
    path,
    method,
    headers,
  };

  const bodyData = body ? JSON.stringify(body) : undefined;
  if (bodyData) headers['Content-Length'] = Buffer.byteLength(bodyData);

  return doRequest(options, bodyData);
}

async function getTenantAccessToken(appId, appSecret) {
  const { statusCode, data } = await feishuRequest(
    '/open-apis/auth/v3/tenant_access_token/internal',
    'POST',
    null,
    { app_id: appId, app_secret: appSecret }
  );

  if (data.code !== 0 || !data.tenant_access_token) {
    const err = normalizeFeishuError(statusCode, data);
    throw Object.assign(new Error(err.message), { feishuError: err });
  }

  return data.tenant_access_token;
}

async function uploadAttachmentToFeishu(appToken, fileBuffer, fileName, mimeType, token) {
  const parentType = mimeType.startsWith('image/') ? 'bitable_image' : 'bitable_file';
  const extra = JSON.stringify({ drive_route_token: appToken });

  const boundary = `----FormBoundary${Date.now()}${Math.random().toString(36).slice(2, 10)}`;

  const parts = [
    `--${boundary}\r\n`,
    'Content-Disposition: form-data; name="file_name"\r\n\r\n',
    `${fileName}\r\n`,
    `--${boundary}\r\n`,
    'Content-Disposition: form-data; name="parent_type"\r\n\r\n',
    `${parentType}\r\n`,
    `--${boundary}\r\n`,
    'Content-Disposition: form-data; name="parent_node"\r\n\r\n',
    `${appToken}\r\n`,
    `--${boundary}\r\n`,
    'Content-Disposition: form-data; name="size"\r\n\r\n',
    `${fileBuffer.length}\r\n`,
    `--${boundary}\r\n`,
    'Content-Disposition: form-data; name="extra"\r\n\r\n',
    `${extra}\r\n`,
    `--${boundary}\r\n`,
    `Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n`,
    `Content-Type: ${mimeType}\r\n\r\n`,
  ];
  const tail = [`\r\n--${boundary}--\r\n`];

  const headBuffer = Buffer.from(parts.join(''), 'utf8');
  const tailBuffer = Buffer.from(tail.join(''), 'utf8');
  const postBody = Buffer.concat([headBuffer, fileBuffer, tailBuffer]);

  const options = {
    protocol: 'https:',
    hostname: FEISHU_API_HOST,
    port: 443,
    path: '/open-apis/drive/v1/medias/upload_all',
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': postBody.length,
    },
  };

  const res = await doRequest(options, postBody);

  if (res.data.code !== 0 || !res.data.data?.file_token) {
    const err = normalizeFeishuError(res.statusCode, res.data);
    throw Object.assign(new Error(err.message), { feishuError: err });
  }

  return res.data.data.file_token;
}

async function createBitableRecord(appToken, tableId, token, fields) {
  const { statusCode, data } = await feishuRequest(
    `/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records`,
    'POST',
    token,
    { fields }
  );

  if (data.code !== 0 || !data.data?.record?.record_id) {
    const err = normalizeFeishuError(statusCode, data);
    throw Object.assign(new Error(err.message), { feishuError: err });
  }

  return {
    recordId: data.data.record.record_id,
    createdTime: data.data.record.created_time,
  };
}

async function updateBitableRecord(appToken, tableId, recordId, token, fields) {
  const { statusCode, data } = await feishuRequest(
    `/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records/${recordId}`,
    'PUT',
    token,
    { fields }
  );

  if (data.code !== 0) {
    const err = normalizeFeishuError(statusCode, data);
    throw Object.assign(new Error(err.message), { feishuError: err });
  }

  return true;
}

async function listBitableRecords(appToken, tableId, token) {
  const { statusCode, data } = await feishuRequest(
    `/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records?page_size=500`,
    'GET',
    token
  );

  if (data.code !== 0) {
    const err = normalizeFeishuError(statusCode, data);
    throw Object.assign(new Error(err.message), { feishuError: err });
  }

  return data.data?.items || [];
}

function toAttachmentField(fileTokens) {
  const tokens = Array.isArray(fileTokens) ? fileTokens : [];
  return tokens.map((t) => ({ file_token: t }));
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

async function handleHealth() {
  return jsonResponse({ ok: true, mode: 'scf-web-function' });
}

async function handleAuthVerify(req, env) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', async () => {
      try {
        const body = Buffer.concat(chunks).toString('utf8');
        let parsed;
        try {
          parsed = JSON.parse(body);
        } catch {
          resolve(jsonResponse({ error: 'Invalid JSON body' }, 400));
          return;
        }

        const { code, deviceId } = parsed || {};
        if (!code || !deviceId) {
          resolve(jsonResponse({ error: 'Missing code or deviceId' }, 400));
          return;
        }

        if (!env.FEISHU_AUTH_TABLE_ID) {
          resolve(jsonResponse({ error: 'Auth table not configured' }, 503));
          return;
        }

        const token = await getTenantAccessToken(env.FEISHU_APP_ID, env.FEISHU_APP_SECRET);

        // List all records from auth table and filter by code (small table, simple approach)
        const items = await listBitableRecords(env.FEISHU_APP_TOKEN, env.FEISHU_AUTH_TABLE_ID, token);
        const record = items.find((item) => item.fields?.['授权码'] === code);

        if (!record) {
          resolve(jsonResponse({ valid: false, reason: 'invalid_code' }, 403));
          return;
        }
        const fields = record.fields || {};

        // Check expiration
        const expiresAtField = fields['过期时间'];
        if (expiresAtField) {
          // Feishu returns date as seconds timestamp; JS Date needs milliseconds
          const ts = typeof expiresAtField === 'number' ? expiresAtField * 1000 : expiresAtField;
          const expiresAt = new Date(ts);
          if (!Number.isNaN(expiresAt.getTime()) && expiresAt < new Date()) {
            resolve(jsonResponse({ valid: false, reason: 'expired', expiresAt: expiresAtField }, 403));
            return;
          }
        }

        // Parse device list
        const deviceField = fields['设备标识符'];
        let devices = [];
        if (deviceField) {
          try {
            const parsedDevices = JSON.parse(deviceField);
            if (Array.isArray(parsedDevices)) devices = parsedDevices;
          } catch {
            // Fallback: treat as newline-separated
            devices = deviceField.split('\n').map((s) => s.trim()).filter(Boolean);
          }
        }

        const MAX_DEVICES = 5;

        if (devices.includes(deviceId)) {
          // Already registered device
          resolve(jsonResponse({
            valid: true,
            deviceCount: devices.length,
            maxDevices: MAX_DEVICES,
            expiresAt: expiresAtField || null,
          }));
          return;
        }

        if (devices.length >= MAX_DEVICES) {
          resolve(jsonResponse({
            valid: false,
            reason: 'device_limit_reached',
            deviceCount: devices.length,
            maxDevices: MAX_DEVICES,
          }, 403));
          return;
        }

        // Register new device
        const newDevices = [...devices, deviceId];
        await updateBitableRecord(
          env.FEISHU_APP_TOKEN,
          env.FEISHU_AUTH_TABLE_ID,
          record.record_id,
          token,
          { '设备标识符': JSON.stringify(newDevices) }
        );

        resolve(jsonResponse({
          valid: true,
          deviceCount: newDevices.length,
          maxDevices: MAX_DEVICES,
          expiresAt: expiresAtField || null,
          deviceRegistered: true,
        }));
      } catch (err) {
        const feishuErr = err.feishuError || { type: 'retryable', code: 'unknown', message: err.message };
        resolve(jsonResponse({ error: err.message, feishuError: feishuErr }, 502));
      }
    });
    req.on('error', reject);
  });
}

async function handleUpload(req, env) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', async () => {
      try {
        const body = Buffer.concat(chunks);
        const contentType = req.headers['content-type'] || '';
        const boundaryMatch = contentType.match(/boundary=([^;]+)/);

        if (!boundaryMatch) {
          resolve(jsonResponse({ error: 'Missing boundary in Content-Type' }, 400));
          return;
        }

        const boundary = boundaryMatch[1].trim();
        const parts = body.toString('binary').split(`--${boundary}`);
        let fileBuffer = null;
        let fileName = 'attachment.bin';
        let mimeType = 'application/octet-stream';

        for (let i = 1; i < parts.length; i++) {
          const part = parts[i];
          if (part.includes('--\r\n')) break;

          const headerEnd = part.indexOf('\r\n\r\n');
          if (headerEnd < 0) continue;

          const headers = part.slice(0, headerEnd).toString('utf8');
          const data = part.slice(headerEnd + 4, part.length - 2);

          const nameMatch = headers.match(/name="([^"]+)"/);
          if (nameMatch && nameMatch[1] === 'file') {
            const fnMatch = headers.match(/filename="([^"]+)"/);
            if (fnMatch) fileName = fnMatch[1];
            const ctMatch = headers.match(/Content-Type:\s*([^\r\n]+)/i);
            if (ctMatch) mimeType = ctMatch[1].trim();
            fileBuffer = Buffer.from(data, 'binary');
          }
        }

        if (!fileBuffer) {
          resolve(jsonResponse({ error: 'Missing file field' }, 400));
          return;
        }

        const token = await getTenantAccessToken(env.FEISHU_APP_ID, env.FEISHU_APP_SECRET);
        const fileToken = await uploadAttachmentToFeishu(env.FEISHU_APP_TOKEN, fileBuffer, fileName, mimeType, token);
        resolve(jsonResponse({ fileToken, fileName }));
      } catch (err) {
        const feishuErr = err.feishuError || { type: 'retryable', code: 'unknown', message: err.message };
        resolve(jsonResponse({ error: err.message, feishuError: feishuErr }, 502));
      }
    });
    req.on('error', reject);
  });
}

async function handleSubmit(req, env) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', async () => {
      try {
        const body = Buffer.concat(chunks).toString('utf8');
        let parsed;
        try {
          parsed = JSON.parse(body);
        } catch {
          resolve(jsonResponse({ error: 'Invalid JSON body' }, 400));
          return;
        }

        const { feedbackId, fields, fileTokens, remoteRecordId } = parsed || {};
        if (!fields || typeof fields !== 'object') {
          resolve(jsonResponse({ error: 'Missing fields object' }, 400));
          return;
        }

        const bitableFields = { ...fields };
        const tokens = Array.isArray(fileTokens) ? fileTokens : [];
        if (tokens.length > 0) {
          bitableFields.screenshot = toAttachmentField(tokens);
        }

        const token = await getTenantAccessToken(env.FEISHU_APP_ID, env.FEISHU_APP_SECRET);

        if (remoteRecordId) {
          await updateBitableRecord(env.FEISHU_APP_TOKEN, env.FEISHU_TABLE_ID, remoteRecordId, token, bitableFields);
          resolve(jsonResponse({ recordId: remoteRecordId, status: 'updated' }));
        } else {
          const result = await createBitableRecord(env.FEISHU_APP_TOKEN, env.FEISHU_TABLE_ID, token, bitableFields);
          resolve(jsonResponse({ recordId: result.recordId, status: 'created' }));
        }
      } catch (err) {
        const feishuErr = err.feishuError || { type: 'retryable', code: 'unknown', message: err.message };
        resolve(jsonResponse({ error: err.message, feishuError: feishuErr }, 502));
      }
    });
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// HTTP Server
// ---------------------------------------------------------------------------

const env = {
  FEISHU_APP_ID: process.env.FEISHU_APP_ID || '',
  FEISHU_APP_SECRET: process.env.FEISHU_APP_SECRET || '',
  FEISHU_APP_TOKEN: process.env.FEISHU_APP_TOKEN || '',
  FEISHU_TABLE_ID: process.env.FEISHU_TABLE_ID || '',
  FEISHU_AUTH_TABLE_ID: process.env.FEISHU_AUTH_TABLE_ID || '',
  RELAY_API_KEY: process.env.RELAY_API_KEY || '',
};

const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;
  const method = req.method;

  // CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Relay-Api-Key',
    });
    res.end();
    return;
  }

  // Auth check (skip health)
  if (!(pathname === '/api/v1/health' && method === 'GET')) {
    const apiKey = req.headers['x-relay-api-key'] || '';
    if (apiKey !== env.RELAY_API_KEY) {
      const response = jsonResponse({ error: 'Unauthorized' }, 401);
      res.writeHead(response.statusCode, response.headers);
      res.end(response.body);
      return;
    }
  }

  try {
    let response;
    if (pathname === '/api/v1/health' && method === 'GET') {
      response = await handleHealth();
    } else if (pathname === '/api/v1/auth/verify' && method === 'POST') {
      response = await handleAuthVerify(req, env);
    } else if (pathname === '/api/v1/feedback/upload' && method === 'POST') {
      response = await handleUpload(req, env);
    } else if (pathname === '/api/v1/feedback/submit' && method === 'POST') {
      response = await handleSubmit(req, env);
    } else {
      response = jsonResponse({ error: 'Not found' }, 404);
    }

    res.writeHead(response.statusCode, response.headers);
    res.end(response.body);
  } catch (err) {
    console.error('[server] unhandled error:', err.message);
    const response = jsonResponse({ error: 'Internal server error' }, 500);
    res.writeHead(response.statusCode, response.headers);
    res.end(response.body);
  }
});

server.listen(PORT, () => {
  console.log(`Feedback relay server running on port ${PORT}`);
});
