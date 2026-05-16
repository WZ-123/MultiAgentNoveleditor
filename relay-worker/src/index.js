/**
 * Cloudflare Worker: Feedback Relay to Feishu Bitable
 *
 * Routes:
 *   GET  /api/v1/health          → Health check
 *   POST /api/v1/feedback/upload → Upload screenshot attachment
 *   POST /api/v1/feedback/submit → Submit feedback record
 */

const FEISHU_API_HOST = 'https://open.feishu.cn';

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, X-Relay-Api-Key',
    },
  });
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
  const formData = new FormData();
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
  return jsonResponse({ ok: true, mode: 'cloudflare-worker' });
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
// Main export
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, X-Relay-Api-Key',
        },
      });
    }

    // Skip auth for health check
    if (!(url.pathname === '/api/v1/health' && request.method === 'GET')) {
      const apiKey = request.headers.get('X-Relay-Api-Key') || '';
      if (apiKey !== env.RELAY_API_KEY) {
        return jsonResponse({ error: 'Unauthorized' }, 401);
      }
    }

    try {
      if (url.pathname === '/api/v1/health' && request.method === 'GET') {
        return handleHealth();
      }
      if (url.pathname === '/api/v1/feedback/upload' && request.method === 'POST') {
        return handleUpload(request, env);
      }
      if (url.pathname === '/api/v1/feedback/submit' && request.method === 'POST') {
        return handleSubmit(request, env);
      }
      return jsonResponse({ error: 'Not found' }, 404);
    } catch (err) {
      console.error('[worker] unhandled error:', err.message);
      return jsonResponse({ error: 'Internal server error' }, 500);
    }
  },
};
