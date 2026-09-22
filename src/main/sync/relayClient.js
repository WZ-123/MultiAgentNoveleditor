'use strict';

const crypto = require('node:crypto');
const https = require('node:https');
const http = require('node:http');
const fs = require('node:fs').promises;
const path = require('node:path');
const { appError, normalizeAppError } = require('../appError');

const REQUEST_TIMEOUT_MS = 15_000;

function request(options) {
  return new Promise((resolve, reject) => {
    const client = options.protocol === 'https:' ? https : http;
    const req = client.request(options, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) {
          req.destroy(Object.assign(new Error('relay_response_too_large'), { code: 'relay_response_too_large' }));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        let data = {};
        let invalidJson = false;
        try { data = JSON.parse(body || '{}'); } catch { data = {}; invalidJson = true; }
        resolve({ statusCode: res.statusCode, headers: res.headers, data, invalidJson });
      });
    });
    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(Object.assign(new Error('relay_timeout'), { code: 'relay_timeout' })));
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

class RelayClient {
  constructor({ relayUrl, getAccessToken }) {
    this.relayUrl = String(relayUrl || '').replace(/\/$/, '');
    if (typeof getAccessToken !== 'function') throw new Error('RelayClient requires an access-token provider');
    this.getAccessToken = getAccessToken;
    let parsed;
    try { parsed = new URL(this.relayUrl); }
    catch (error) { throw appError(error, { domain: 'relay', phase: 'configuration', code: 'relay_config_invalid' }); }
    if (!['http:', 'https:'].includes(parsed.protocol)) throw appError({ code: 'relay_config_invalid' }, { domain: 'relay', phase: 'configuration' });
    this.protocol = parsed.protocol;
    this.hostname = parsed.hostname;
    this.port = parsed.port || (parsed.protocol === 'https:' ? 443 : 80);
    this.basePath = parsed.pathname.replace(/\/$/, '');
  }

  _buildReq(method, requestPath, token, headers, body) {
    const opts = {
      protocol: this.protocol,
      hostname: this.hostname,
      port: this.port,
      path: `${this.basePath}${requestPath}`,
      method,
      headers: { Authorization: `Bearer ${token}`, ...headers },
    };
    if (body && typeof body === 'object' && !Buffer.isBuffer(body)) {
      opts.body = Buffer.from(JSON.stringify(body), 'utf8');
      opts.headers['Content-Type'] = 'application/json';
      opts.headers['Content-Length'] = opts.body.length;
    } else if (Buffer.isBuffer(body)) {
      opts.body = body;
      opts.headers['Content-Length'] = body.length;
    }
    return opts;
  }

  async _authorizedRequest(scope, factory) {
    try {
      let token = await this.getAccessToken(scope, { forceRefresh: false });
      let result = await request(factory(token));
      if (result.statusCode === 401) {
        token = await this.getAccessToken(scope, { forceRefresh: true });
        result = await request(factory(token));
      }
      return result;
    } catch (error) {
      throw appError(error, { domain: 'relay', phase: 'feedback_request' });
    }
  }

  _normalizeError(statusCode, data) {
    // HTTP status is authoritative for transport/service failures.  Never
    // turn an opaque upstream `server_error` body into the generic legacy
    // network classification.
    const bodyCode = String(data?.code || '');
    const knownBodyCode = new Set(['auth_invalid', 'auth_expired', 'auth_revoked', 'auth_device_limit', 'auth_rate_limited', 'relay_config_missing', 'relay_config_invalid', 'relay_timeout', 'relay_unreachable', 'relay_response_invalid', 'relay_unavailable', 'relay_rate_limited', 'upgrade_required']);
    const code = statusCode >= 500 ? 'relay_unavailable'
      : statusCode === 429 ? 'relay_rate_limited'
        : statusCode === 426 ? 'upgrade_required'
          : statusCode === 401 || statusCode === 403 ? 'auth_invalid'
            : knownBodyCode.has(bodyCode) ? bodyCode
              : 'relay_response_invalid';
    const normalized = normalizeAppError({ code }, {
      domain: 'relay', phase: 'feedback_response', httpStatus: statusCode,
      diagnosticId: data?.diagnosticId || undefined,
      retryable: statusCode >= 500 || statusCode === 429 || code === 'request_in_progress',
    });
    return { ...normalized, type: normalized.retryable ? 'retryable' : 'terminal' };
  }

  _assertSuccess(result, predicate) {
    if (result.statusCode === 200 && !result.invalidJson && predicate(result.data)) return result.data;
    const normalized = this._normalizeError(result.statusCode, result.data);
    throw Object.assign(appError(normalized, normalized), { relayError: normalized, feishuError: normalized });
  }

  async uploadAttachment(filePath, feedbackId) {
    const buffer = await fs.readFile(filePath);
    if (buffer.length > 10 * 1024 * 1024) throw Object.assign(new Error('反馈附件超过 10 MiB 限制'), { code: 'request_too_large' });
    const fileName = path.basename(filePath);
    const attachmentHash = crypto.createHash('sha256').update(buffer).digest('hex');
    const boundary = `----ManaRelay${crypto.randomBytes(12).toString('hex')}`;
    const safeFileName = fileName.replace(/["\r\n]/g, '_');
    const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${safeFileName}"\r\nContent-Type: application/octet-stream\r\n\r\n`, 'utf8');
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
    const body = Buffer.concat([head, buffer, tail]);
    const idempotencyKey = `${String(feedbackId || 'feedback')}:${attachmentHash}`;
    const result = await this._authorizedRequest('feedback:upload', (token) => this._buildReq(
      'POST',
      '/api/v2/feedback/upload',
      token,
      {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Idempotency-Key': idempotencyKey,
        'X-Feedback-Id': String(feedbackId || ''),
        'X-Attachment-Sha256': attachmentHash,
      },
      body
    ));
    const data = this._assertSuccess(result, (value) => Boolean(value?.fileToken));
    return { fileToken: data.fileToken, fileName: data.fileName || fileName, attachmentHash };
  }

  async createRecord(feedbackId, fields, fileTokens) {
    const result = await this._authorizedRequest('feedback:submit', (token) => this._buildReq(
      'POST', '/api/v2/feedback/submit', token, { 'Idempotency-Key': String(feedbackId) }, { feedbackId, fields, fileTokens }
    ));
    const data = this._assertSuccess(result, (value) => Boolean(value?.recordId));
    return { recordId: data.recordId, status: data.status };
  }

  async updateRecord(feedbackId, remoteRecordId, fields, fileTokens) {
    const result = await this._authorizedRequest('feedback:submit', (token) => this._buildReq(
      'POST', '/api/v2/feedback/submit', token, { 'Idempotency-Key': String(feedbackId) }, { feedbackId, fields, fileTokens, remoteRecordId }
    ));
    const data = this._assertSuccess(result, (value) => Boolean(value?.recordId));
    return { recordId: data.recordId || remoteRecordId, status: data.status };
  }
}

module.exports = { REQUEST_TIMEOUT_MS, RelayClient, request };
