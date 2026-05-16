'use strict';

const https = require('node:https');
const http = require('node:http');
const fs = require('node:fs').promises;
const path = require('node:path');

/**
 * Relay client: talks to the feedback relay server instead of Feishu directly.
 *
 * This module mirrors the feishuAdapter API surface so that feedbackSyncWorker
 * can swap adapters without changing its logic.
 */

function request(options) {
  return new Promise((resolve, reject) => {
    const client = options.protocol === 'https:' ? https : http;
    const req = client.request(options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        let data = null;
        try { data = JSON.parse(body); } catch { data = { raw: body }; }
        resolve({ statusCode: res.statusCode, headers: res.headers, data });
      });
    });
    req.on('error', (err) => reject(err));
    if (options.body) req.write(options.body);
    req.end();
  });
}

class RelayClient {
  constructor({ relayUrl, relayApiKey }) {
    this.relayUrl = relayUrl;
    this.relayApiKey = relayApiKey;
    const parsed = new URL(relayUrl);
    this.protocol = parsed.protocol;
    this.hostname = parsed.hostname;
    this.port = parsed.port || (parsed.protocol === 'https:' ? 443 : 80);
    this.basePath = parsed.pathname.replace(/\/$/, '');
  }

  _buildReq(method, path, headers, body) {
    const opts = {
      protocol: this.protocol,
      hostname: this.hostname,
      port: this.port,
      path: `${this.basePath}${path}`,
      method,
      headers: {
        'X-Relay-Api-Key': this.relayApiKey,
        ...headers,
      },
    };
    if (body && typeof body === 'object' && !(body instanceof Buffer)) {
      const json = JSON.stringify(body);
      opts.body = Buffer.from(json, 'utf8');
      opts.headers['Content-Type'] = 'application/json';
      opts.headers['Content-Length'] = opts.body.length;
    } else if (body instanceof Buffer) {
      opts.body = body;
      opts.headers['Content-Length'] = body.length;
    }
    return opts;
  }

  _normalizeError(statusCode, data) {
    const feishuErr = data?.feishuError;
    if (feishuErr) {
      // Relay already normalized it; pass through
      return {
        type: feishuErr.type || 'retryable',
        code: feishuErr.code || 'unknown',
        message: feishuErr.message || data.error || `HTTP ${statusCode}`,
        httpStatus: statusCode,
        feishuCode: feishuErr.feishuCode,
      };
    }
    if (statusCode >= 500) return { type: 'retryable', code: 'server_error', message: data?.error || `HTTP ${statusCode}`, httpStatus: statusCode };
    if (statusCode === 429) return { type: 'retryable', code: 'rate_limited', message: data?.error || 'Rate limited', httpStatus: statusCode };
    if (statusCode === 401 || statusCode === 403) return { type: 'terminal', code: 'auth_failed', message: data?.error || 'Auth failed', httpStatus: statusCode };
    if (statusCode === 404) return { type: 'terminal', code: 'not_found', message: data?.error || 'Not found', httpStatus: statusCode };
    if (statusCode >= 400 && statusCode < 500) return { type: 'terminal', code: 'client_error', message: data?.error || `HTTP ${statusCode}`, httpStatus: statusCode };
    return { type: 'retryable', code: 'unknown', message: data?.error || `HTTP ${statusCode}`, httpStatus: statusCode };
  }

  async uploadAttachment(filePath) {
    const buffer = await fs.readFile(filePath);
    const fileName = path.basename(filePath);
    const boundary = `----RelayBoundary${Date.now()}${Math.random().toString(36).slice(2, 10)}`;

    const head = Buffer.from([
      `--${boundary}\r\n`,
      `Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n`,
      'Content-Type: application/octet-stream\r\n\r\n',
    ].join(''), 'utf8');
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
    const body = Buffer.concat([head, buffer, tail]);

    const res = await request({
      protocol: this.protocol,
      hostname: this.hostname,
      port: this.port,
      path: `${this.basePath}/api/v1/feedback/upload`,
      method: 'POST',
      headers: {
        'X-Relay-Api-Key': this.relayApiKey,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
      },
      body,
    });

    if (res.statusCode !== 200 || !res.data?.fileToken) {
      const err = this._normalizeError(res.statusCode, res.data);
      throw Object.assign(new Error(err.message), { feishuError: err });
    }

    return {
      fileToken: res.data.fileToken,
      fileName: res.data.fileName || fileName,
    };
  }

  async createRecord(feedbackId, fields, fileTokens) {
    const res = await request(this._buildReq(
      'POST',
      '/api/v1/feedback/submit',
      {},
      { feedbackId, fields, fileTokens }
    ));

    if (res.statusCode !== 200 || !res.data?.recordId) {
      const err = this._normalizeError(res.statusCode, res.data);
      throw Object.assign(new Error(err.message), { feishuError: err });
    }

    return {
      recordId: res.data.recordId,
      status: res.data.status,
    };
  }

  async updateRecord(feedbackId, remoteRecordId, fields, fileTokens) {
    const res = await request(this._buildReq(
      'POST',
      '/api/v1/feedback/submit',
      {},
      { feedbackId, fields, fileTokens, remoteRecordId }
    ));

    if (res.statusCode !== 200) {
      const err = this._normalizeError(res.statusCode, res.data);
      throw Object.assign(new Error(err.message), { feishuError: err });
    }

    return {
      recordId: res.data.recordId || remoteRecordId,
      status: res.data.status,
    };
  }
}

module.exports = { RelayClient };
