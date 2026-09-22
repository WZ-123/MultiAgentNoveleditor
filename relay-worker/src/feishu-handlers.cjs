'use strict';

const { sha256 } = require('./relay-core.cjs');

const FEISHU_API_HOST = 'https://open.feishu.cn';

function normalizeFeishuError(statusCode, data) {
  const code = data?.code ?? -1;
  const message = data?.msg || data?.error || `HTTP ${statusCode}`;
  if (statusCode >= 500) return { type: 'retryable', code: 'server_error', message, httpStatus: statusCode, feishuCode: code };
  if (statusCode === 429) return { type: 'retryable', code: 'rate_limited', message, httpStatus: statusCode, feishuCode: code };
  if (statusCode === 401 || statusCode === 403) return { type: 'terminal', code: 'auth_failed', message, httpStatus: statusCode, feishuCode: code };
  if (code === 1254045 || code === 1254002) return { type: 'terminal', code: 'table_not_found', message, httpStatus: statusCode, feishuCode: code };
  if (code === 1254043) return { type: 'terminal', code: 'field_not_found', message, httpStatus: statusCode, feishuCode: code };
  if (code === 1254003 || code === 1254004) return { type: 'terminal', code: 'invalid_schema', message, httpStatus: statusCode, feishuCode: code };
  if (statusCode >= 400 && statusCode < 500) return { type: 'terminal', code: 'client_error', message, httpStatus: statusCode, feishuCode: code };
  return { type: 'retryable', code: 'unknown', message, httpStatus: statusCode, feishuCode: code };
}

function upstreamError(statusCode, data) {
  const normalized = normalizeFeishuError(statusCode, data);
  return Object.assign(new Error(normalized.message), { feishuError: normalized });
}

async function feishuRequest(fetchImpl, path, method, token, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetchImpl(`${FEISHU_API_HOST}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  return { statusCode: response.status, data };
}

async function tenantAccessToken(env, fetchImpl) {
  const { statusCode, data } = await feishuRequest(
    fetchImpl,
    '/open-apis/auth/v3/tenant_access_token/internal',
    'POST',
    null,
    { app_id: env.FEISHU_APP_ID, app_secret: env.FEISHU_APP_SECRET },
  );
  if (data.code !== 0 || !data.tenant_access_token) throw upstreamError(statusCode, data);
  return data.tenant_access_token;
}

async function uploadAttachment(env, fetchImpl, file, token) {
  const formData = new FormData();
  formData.append('file_name', file.name || 'attachment.bin');
  formData.append('parent_type', file.type?.startsWith('image/') ? 'bitable_image' : 'bitable_file');
  formData.append('parent_node', env.FEISHU_APP_TOKEN);
  formData.append('size', String(file.size));
  formData.append('extra', JSON.stringify({ drive_route_token: env.FEISHU_APP_TOKEN }));
  formData.append('file', file, file.name || 'attachment.bin');
  const response = await fetchImpl(`${FEISHU_API_HOST}/open-apis/drive/v1/medias/upload_all`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: formData,
  });
  const data = await response.json().catch(() => ({}));
  if (data.code !== 0 || !data.data?.file_token) throw upstreamError(response.status, data);
  return data.data.file_token;
}

async function createRecord(env, fetchImpl, token, fields) {
  const { statusCode, data } = await feishuRequest(
    fetchImpl,
    `/open-apis/bitable/v1/apps/${env.FEISHU_APP_TOKEN}/tables/${env.FEISHU_TABLE_ID}/records`,
    'POST',
    token,
    { fields },
  );
  if (data.code !== 0 || !data.data?.record?.record_id) throw upstreamError(statusCode, data);
  return { recordId: data.data.record.record_id, createdTime: data.data.record.created_time };
}

async function updateRecord(env, fetchImpl, tableId, recordId, token, fields) {
  const { statusCode, data } = await feishuRequest(
    fetchImpl,
    `/open-apis/bitable/v1/apps/${env.FEISHU_APP_TOKEN}/tables/${tableId}/records/${recordId}`,
    'PUT',
    token,
    { fields },
  );
  if (data.code !== 0) throw upstreamError(statusCode, data);
}

async function listRecords(env, fetchImpl, tableId, token) {
  const items = [];
  let pageToken = '';
  for (let page = 0; page < 100; page += 1) {
    const query = new URLSearchParams({ page_size: '500' });
    if (pageToken) query.set('page_token', pageToken);
    const { statusCode, data } = await feishuRequest(
      fetchImpl,
      `/open-apis/bitable/v1/apps/${env.FEISHU_APP_TOKEN}/tables/${tableId}/records?${query.toString()}`,
      'GET',
      token,
    );
    if (data.code !== 0 || !Array.isArray(data.data?.items)) throw upstreamError(statusCode, data);
    items.push(...data.data.items);
    if (!data.data.has_more || !data.data.page_token) return items;
    pageToken = data.data.page_token;
  }
  throw Object.assign(new Error('Feishu record pagination exceeded the safety limit'), { code: 'upstream_incomplete' });
}

function parseDevices(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  try {
    const parsed = JSON.parse(String(value));
    if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
  } catch {
    // Older rows may contain newline-separated anonymous device hashes.
  }
  return String(value).split('\n').map((item) => item.trim()).filter(Boolean);
}

async function exchangeLicense(input, env, fetchImpl) {
  if (!env.FEISHU_AUTH_TABLE_ID) return { valid: false, reason: 'license_unavailable' };
  const token = await tenantAccessToken(env, fetchImpl);
  const records = await listRecords(env, fetchImpl, env.FEISHU_AUTH_TABLE_ID, token);
  const record = records.find((item) => String(item.fields?.['授权码'] || '') === input.authCode);
  if (!record) return { valid: false, reason: 'invalid_code' };
  const fields = record.fields || {};
  const status = String(fields['状态'] || '').trim().toLowerCase();
  if (fields['已吊销'] === true || ['revoked', 'disabled', '已吊销', '禁用'].includes(status)) {
    return { valid: false, reason: 'license_revoked' };
  }
  const expiresAt = fields['过期时间'] || null;
  if (expiresAt) {
    const numeric = Number(expiresAt);
    const date = Number.isFinite(numeric)
      ? new Date(numeric < 10_000_000_000 ? numeric * 1000 : numeric)
      : new Date(expiresAt);
    if (!Number.isNaN(date.getTime()) && date.getTime() <= Date.now()) return { valid: false, reason: 'expired' };
  }
  const devices = parseDevices(fields['设备标识符']);
  const maxDevices = Math.max(1, Math.min(100, Number(fields['最大设备数']) || 5));
  if (!devices.includes(input.installationIdHash) && devices.length >= maxDevices) {
    return { valid: false, reason: 'device_limit_reached', deviceCount: devices.length, maxDevices };
  }
  if (!devices.includes(input.installationIdHash)) {
    devices.push(input.installationIdHash);
    await updateRecord(env, fetchImpl, env.FEISHU_AUTH_TABLE_ID, record.record_id, token, {
      '设备标识符': JSON.stringify(devices),
    });
  }
  return { valid: true, deviceCount: devices.length, maxDevices, expiresAt };
}

async function uploadFeedback(input, env, fetchImpl) {
  let formData;
  try {
    formData = await new Response(input.request.body, {
      headers: { 'Content-Type': input.request.contentType || 'application/octet-stream' },
    }).formData();
  } catch {
    throw Object.assign(new Error('attachment multipart body is invalid'), { code: 'invalid_request' });
  }
  const file = formData.get('file');
  if (!file || typeof file === 'string') throw Object.assign(new Error('attachment file is missing'), { code: 'invalid_request' });
  const actualHash = await sha256(new Uint8Array(await file.arrayBuffer()));
  if (actualHash !== input.attachmentHash) throw Object.assign(new Error('attachment hash does not match'), { code: 'invalid_request' });
  const token = await tenantAccessToken(env, fetchImpl);
  const fileToken = await uploadAttachment(env, fetchImpl, file, token);
  return { fileToken, fileName: file.name };
}

async function submitFeedback(input, env, fetchImpl) {
  const { feedbackId, fields, fileTokens, remoteRecordId } = input.data || {};
  const bitableFields = { ...fields };
  const tokens = Array.isArray(fileTokens) ? fileTokens : [];
  if (tokens.length) bitableFields.screenshot = tokens.map((fileToken) => ({ file_token: fileToken }));
  const token = await tenantAccessToken(env, fetchImpl);
  let targetRecordId = remoteRecordId;
  if (!targetRecordId) {
    const records = await listRecords(env, fetchImpl, env.FEISHU_TABLE_ID, token);
    targetRecordId = records.find((item) => String(item.fields?.feedbackId || '') === String(feedbackId || ''))?.record_id || '';
  }
  if (targetRecordId) {
    await updateRecord(env, fetchImpl, env.FEISHU_TABLE_ID, targetRecordId, token, bitableFields);
    return { recordId: targetRecordId, status: remoteRecordId ? 'updated' : 'deduplicated' };
  }
  const result = await createRecord(env, fetchImpl, token, bitableFields);
  return { recordId: result.recordId, status: 'created' };
}

function createFeishuRelayHandlers(env, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('Relay upstream fetch is unavailable');
  return {
    exchangeLicense: (input) => exchangeLicense(input, env, fetchImpl),
    uploadFeedback: (input) => uploadFeedback(input, env, fetchImpl),
    submitFeedback: (input) => submitFeedback(input, env, fetchImpl),
  };
}

module.exports = {
  createFeishuRelayHandlers,
  normalizeFeishuError,
  parseDevices,
};
