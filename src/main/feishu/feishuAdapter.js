'use strict';

const crypto = require('node:crypto');
const https = require('node:https');
const fs = require('node:fs').promises;
const path = require('node:path');

const FEISHU_API_HOST = 'open.feishu.cn';

// In-memory token cache: { token, expireAt }
let tokenCache = null;

function request(options) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        let data = null;
        try {
          data = JSON.parse(body);
        } catch {
          data = { raw: body };
        }
        resolve({ statusCode: res.statusCode, headers: res.headers, data });
      });
    });
    req.on('error', (err) => reject(err));
    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

function buildRequest(method, path, headers, body) {
  const opts = {
    hostname: FEISHU_API_HOST,
    port: 443,
    path,
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
  };
  if (body && typeof body === 'object') {
    opts.body = JSON.stringify(body);
    opts.headers['Content-Length'] = Buffer.byteLength(opts.body);
  }
  return opts;
}

function guessMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.gif':
      return 'image/gif';
    case '.webp':
      return 'image/webp';
    default:
      return 'application/octet-stream';
  }
}

function isImageMimeType(mimeType) {
  return typeof mimeType === 'string' && mimeType.startsWith('image/');
}

function normalizeError(statusCode, data) {
  const code = data?.code ?? -1;
  const msg = data?.msg || data?.error || `HTTP ${statusCode}`;

  // Retryable errors
  if (statusCode >= 500) return { type: 'retryable', code: 'server_error', message: msg, httpStatus: statusCode, feishuCode: code };
  if (statusCode === 429) return { type: 'retryable', code: 'rate_limited', message: msg, httpStatus: statusCode, feishuCode: code };
  if (statusCode === 0 || !statusCode) return { type: 'retryable', code: 'network_error', message: msg, httpStatus: statusCode, feishuCode: code };

  // Auth / permission errors
  if (code === 99991663 || code === 99991664) return { type: 'terminal', code: 'auth_failed', message: msg, httpStatus: statusCode, feishuCode: code };
  if (code === 99991668 || code === 99991669) return { type: 'terminal', code: 'permission_denied', message: msg, httpStatus: statusCode, feishuCode: code };
  if (statusCode === 401 || statusCode === 403) return { type: 'terminal', code: 'auth_failed', message: msg, httpStatus: statusCode, feishuCode: code };

  // Table / field errors
  if (code === 1254045 || code === 1254002) return { type: 'terminal', code: 'table_not_found', message: msg, httpStatus: statusCode, feishuCode: code };
  if (code === 1254043) return { type: 'terminal', code: 'field_not_found', message: msg, httpStatus: statusCode, feishuCode: code };
  if (code === 1254003 || code === 1254004) return { type: 'terminal', code: 'invalid_schema', message: msg, httpStatus: statusCode, feishuCode: code };

  // Client errors that are terminal for our use case
  if (statusCode >= 400 && statusCode < 500) return { type: 'terminal', code: 'client_error', message: msg, httpStatus: statusCode, feishuCode: code };

  return { type: 'retryable', code: 'unknown', message: msg, httpStatus: statusCode, feishuCode: code };
}

async function getTenantAccessToken(appId, appSecret) {
  if (tokenCache && tokenCache.expireAt > Date.now() + 5 * 60 * 1000) {
    return { token: tokenCache.token, expireAt: tokenCache.expireAt };
  }

  const res = await request(buildRequest('POST', '/open-apis/auth/v3/tenant_access_token/internal', {}, {
    app_id: appId,
    app_secret: appSecret,
  }));

  if (res.data?.code !== 0 || !res.data?.tenant_access_token) {
    const err = normalizeError(res.statusCode, res.data);
    throw Object.assign(new Error(err.message), { feishuError: err });
  }

  const token = res.data.tenant_access_token;
  const expire = res.data.expire || 7200;
  const expireAt = Date.now() + expire * 1000;
  tokenCache = { token, expireAt };
  return { token, expireAt };
}

function clearTokenCache() {
  tokenCache = null;
}

async function createRecord(appToken, tableId, token, fields) {
  const res = await request(buildRequest(
    'POST',
    `/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records`,
    { Authorization: `Bearer ${token}` },
    { fields }
  ));

  if (res.data?.code !== 0 || !res.data?.data?.record?.record_id) {
    const err = normalizeError(res.statusCode, res.data);
    throw Object.assign(new Error(err.message), { feishuError: err });
  }

  return {
    recordId: res.data.data.record.record_id,
    createdTime: res.data.data.record.created_time,
  };
}

async function updateRecord(appToken, tableId, recordId, token, fields) {
  const res = await request(buildRequest(
    'PUT',
    `/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records/${recordId}`,
    { Authorization: `Bearer ${token}` },
    { fields }
  ));

  if (res.data?.code !== 0) {
    const err = normalizeError(res.statusCode, res.data);
    throw Object.assign(new Error(err.message), { feishuError: err });
  }

  return true;
}

async function uploadAttachment(appToken, filePath, token) {
  const buffer = await fs.readFile(filePath);
  const fileName = path.basename(filePath);
  const mimeType = guessMimeType(filePath);
  const parentType = isImageMimeType(mimeType) ? 'bitable_image' : 'bitable_file';
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
    `${buffer.length}\r\n`,
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
  const body = Buffer.concat([headBuffer, buffer, tailBuffer]);

  const res = await request({
    hostname: FEISHU_API_HOST,
    port: 443,
    path: '/open-apis/drive/v1/medias/upload_all',
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': body.length,
    },
    body,
  });

  if (res.data?.code !== 0 || !res.data?.data?.file_token) {
    const err = normalizeError(res.statusCode, res.data);
    throw Object.assign(new Error(err.message), { feishuError: err });
  }

  return {
    fileToken: res.data.data.file_token,
    fileName: res.data.data.file_name || fileName,
  };
}

async function getTableFields(appToken, tableId, token) {
  const res = await request(buildRequest(
    'GET',
    `/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/fields?page_size=100`,
    { Authorization: `Bearer ${token}` },
    null
  ));

  if (res.data?.code !== 0) {
    const err = normalizeError(res.statusCode, res.data);
    throw Object.assign(new Error(err.message), { feishuError: err });
  }

  return res.data.data?.items || [];
}

async function listRecords(appToken, tableId, token, options = {}) {
  const pageSize = Math.max(1, Math.min(500, Number(options.pageSize) || 100));
  const params = new URLSearchParams({ page_size: String(pageSize) });
  if (options.pageToken) params.set('page_token', String(options.pageToken));
  if (options.viewId) params.set('view_id', String(options.viewId));
  if (options.filter) params.set('filter', String(options.filter));
  if (options.sort?.fieldName) {
    params.set('sort[0][field_name]', String(options.sort.fieldName));
    params.set('sort[0][desc]', String(options.sort.order).toLowerCase() === 'desc' ? 'true' : 'false');
  }

  const res = await request(buildRequest(
    'GET',
    `/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records?${params.toString()}`,
    { Authorization: `Bearer ${token}` },
    null
  ));

  if (res.data?.code !== 0) {
    const err = normalizeError(res.statusCode, res.data);
    throw Object.assign(new Error(err.message), { feishuError: err });
  }

  return {
    items: res.data.data?.items || [],
    hasMore: !!res.data.data?.has_more,
    pageToken: res.data.data?.page_token || '',
    total: Number(res.data.data?.total || 0),
  };
}

async function createField(appToken, tableId, token, field) {
  const res = await request(buildRequest(
    'POST',
    `/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/fields?client_token=${crypto.randomUUID()}`,
    { Authorization: `Bearer ${token}` },
    field
  ));

  if (res.data?.code !== 0 || !res.data?.data?.field?.field_id) {
    const err = normalizeError(res.statusCode, res.data);
    throw Object.assign(new Error(err.message), { feishuError: err });
  }

  return res.data.data.field;
}

module.exports = {
  getTenantAccessToken,
  clearTokenCache,
  createRecord,
  updateRecord,
  uploadAttachment,
  getTableFields,
  listRecords,
  createField,
  normalizeError,
};
