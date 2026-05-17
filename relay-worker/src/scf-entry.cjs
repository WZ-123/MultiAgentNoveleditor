/**
 * Tencent Cloud SCF entry for feedback relay.
 *
 * Core logic is duplicated from index.js (ESM) in CJS format so that
 * SCF Node.js runtime can load it without ESM/CJS interop issues.
 */

const FEISHU_API_HOST = 'https://open.feishu.cn';

function jsonResponse(data, status = 200) {
  return {
    status,
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

async function feishuRequest(path, method, token, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${FEISHU_API_HOST}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json().catch(() => ({}));
  return { statusCode: res.status, data };
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

async function uploadAttachmentToFeishu(appToken, file, token) {
  const formData = new globalThis.FormData();
  formData.append('file_name', file.name || 'attachment.bin');
  formData.append('parent_type', file.type?.startsWith('image/') ? 'bitable_image' : 'bitable_file');
  formData.append('parent_node', appToken);
  formData.append('size', String(file.size));
  formData.append('extra', JSON.stringify({ drive_route_token: appToken }));
  formData.append('file', file, file.name || 'attachment.bin');

  const res = await fetch(`${FEISHU_API_HOST}/open-apis/drive/v1/medias/upload_all`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: formData,
  });

  const data = await res.json().catch(() => ({}));
  if (data.code !== 0 || !data.data?.file_token) {
    const err = normalizeFeishuError(res.status, data);
    throw Object.assign(new Error(err.message), { feishuError: err });
  }

  return data.data.file_token;
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

function toAttachmentField(fileTokens) {
  const tokens = Array.isArray(fileTokens) ? fileTokens : [];
  return tokens.map((t) => ({ file_token: t }));
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

async function handleHealth() {
  return jsonResponse({ ok: true, mode: 'scf' });
}

async function handleUpload(request, env) {
  let formData;
  try {
    formData = await request.formData();
  } catch (err) {
    return jsonResponse({ error: `Parse error: ${err.message}` }, 400);
  }

  const file = formData.get('file');
  if (!file || typeof file === 'string') {
    return jsonResponse({ error: 'Missing file field' }, 400);
  }

  try {
    const token = await getTenantAccessToken(env.FEISHU_APP_ID, env.FEISHU_APP_SECRET);
    const fileToken = await uploadAttachmentToFeishu(env.FEISHU_APP_TOKEN, file, token);
    return jsonResponse({ fileToken, fileName: file.name });
  } catch (err) {
    const feishuErr = err.feishuError || { type: 'retryable', code: 'unknown', message: err.message };
    return jsonResponse({ error: err.message, feishuError: feishuErr }, 502);
  }
}

async function handleSubmit(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (err) {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }

  const { feedbackId, fields, fileTokens, remoteRecordId } = body || {};
  if (!fields || typeof fields !== 'object') {
    return jsonResponse({ error: 'Missing fields object' }, 400);
  }

  const bitableFields = { ...fields };
  const tokens = Array.isArray(fileTokens) ? fileTokens : [];
  if (tokens.length > 0) {
    bitableFields.screenshot = toAttachmentField(tokens);
  }

  try {
    const token = await getTenantAccessToken(env.FEISHU_APP_ID, env.FEISHU_APP_SECRET);

    if (remoteRecordId) {
      await updateBitableRecord(env.FEISHU_APP_TOKEN, env.FEISHU_TABLE_ID, remoteRecordId, token, bitableFields);
      return jsonResponse({ recordId: remoteRecordId, status: 'updated' });
    } else {
      const result = await createBitableRecord(env.FEISHU_APP_TOKEN, env.FEISHU_TABLE_ID, token, bitableFields);
      return jsonResponse({ recordId: result.recordId, status: 'created' });
    }
  } catch (err) {
    const feishuErr = err.feishuError || { type: 'retryable', code: 'unknown', message: err.message };
    return jsonResponse({ error: err.message, feishuError: feishuErr }, 502);
  }
}

// ---------------------------------------------------------------------------
// API Gateway event adapter
// ---------------------------------------------------------------------------

function buildUrl(event) {
  const path = event.path || event.requestContext?.path || '/';
  const query = event.queryString || event.queryStringParameters || {};
  const qs = new URLSearchParams(query).toString();
  return `https://${event.headers?.Host || 'localhost'}${path}${qs ? '?' + qs : ''}`;
}

function buildHeaders(event) {
  const headers = {};
  const src = event.headers || {};
  for (const [k, v] of Object.entries(src)) {
    headers[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v);
  }
  return headers;
}

function parseBody(event) {
  const body = event.body;
  if (!body) return undefined;
  if (event.isBase64Encoded) {
    return Buffer.from(body, 'base64');
  }
  return Buffer.from(body, 'utf8');
}

async function buildRequest(event) {
  const url = buildUrl(event);
  const method = event.httpMethod || event.requestContext?.httpMethod || 'GET';
  const headers = buildHeaders(event);
  const body = parseBody(event);

  return new Request(url, { method, headers, body });
}

// ---------------------------------------------------------------------------
// SCF main handler
// ---------------------------------------------------------------------------

exports.main_handler = async (event, context) => {
  const env = {
    FEISHU_APP_ID: process.env.FEISHU_APP_ID || '',
    FEISHU_APP_SECRET: process.env.FEISHU_APP_SECRET || '',
    FEISHU_APP_TOKEN: process.env.FEISHU_APP_TOKEN || '',
    FEISHU_TABLE_ID: process.env.FEISHU_TABLE_ID || '',
    RELAY_API_KEY: process.env.RELAY_API_KEY || '',
  };

  // Handle CORS preflight
  const method = event.httpMethod || event.requestContext?.httpMethod || 'GET';
  if (method === 'OPTIONS') {
    return {
      isBase64Encoded: false,
      statusCode: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, X-Relay-Api-Key',
      },
      body: '',
    };
  }

  try {
    const request = await buildRequest(event);
    const url = new URL(request.url);

    // Auth check (skip health)
    if (!(url.pathname === '/api/v1/health' && method === 'GET')) {
      const apiKey = request.headers.get('x-relay-api-key') || '';
      if (apiKey !== env.RELAY_API_KEY) {
        return { ...jsonResponse({ error: 'Unauthorized' }, 401), isBase64Encoded: false };
      }
    }

    let response;
    if (url.pathname === '/api/v1/health' && method === 'GET') {
      response = handleHealth();
    } else if (url.pathname === '/api/v1/feedback/upload' && method === 'POST') {
      response = await handleUpload(request, env);
    } else if (url.pathname === '/api/v1/feedback/submit' && method === 'POST') {
      response = await handleSubmit(request, env);
    } else {
      response = jsonResponse({ error: 'Not found' }, 404);
    }

    return { ...response, isBase64Encoded: false };
  } catch (err) {
    console.error('[scf] unhandled error:', err.message);
    return {
      isBase64Encoded: false,
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Internal server error' }),
    };
  }
};
