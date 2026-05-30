'use strict';

/**
 * Proxy-aware HTTP fetch for enrichment search (Wikipedia, BWiki, etc.).
 * Reads HTTPS_PROXY / HTTP_PROXY / ALL_PROXY when appConfig.network.useSystemProxy !== false.
 */

const http = require('http');
const https = require('https');
const { HttpsProxyAgent } = require('https-proxy-agent');

function _getProxyUrl() {
  return String(
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    process.env.ALL_PROXY ||
    process.env.all_proxy ||
    ''
  ).trim();
}

function _useSystemProxy() {
  return true;
}

function _getProxyAgent() {
  const proxy = _getProxyUrl();
  if (!proxy || !_useSystemProxy()) return null;
  return new HttpsProxyAgent(proxy);
}

function _requestWithAgent(url, options = {}) {
  const parsed = new URL(url);
  const isHttps = parsed.protocol === 'https:';
  const lib = isHttps ? https : http;
  const agent = options.agent || _getProxyAgent();
  const method = (options.method || 'GET').toUpperCase();
  const headers = options.headers || {};
  const body = options.body;
  const signal = options.signal;

  return new Promise((resolve, reject) => {
    const reqOpts = {
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: `${parsed.pathname}${parsed.search}`,
      method,
      headers,
      agent: agent || undefined,
    };

    const req = lib.request(reqOpts, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const textBody = buf.toString('utf8');
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          statusText: res.statusMessage || '',
          headers: {
            get: (name) => {
              const key = String(name || '').toLowerCase();
              const val = res.headers[key];
              return Array.isArray(val) ? val[0] : (val || null);
            },
          },
          text: async () => textBody,
          json: async () => JSON.parse(textBody),
        });
      });
    });

    req.on('error', reject);
    if (signal) {
      const onAbort = () => {
        req.destroy();
        reject(new DOMException('Aborted', 'AbortError'));
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    if (body) req.write(body);
    req.end();
  });
}

/**
 * @param {string} url
 * @param {RequestInit & { timeout?: number }} [options]
 */
async function networkFetch(url, options = {}) {
  const proxy = _getProxyUrl();
  const useProxy = _useSystemProxy() && !!proxy;
  const { timeout, ...rest } = options;
  let signal = rest.signal;
  if (timeout && !signal) {
    signal = AbortSignal.timeout(timeout);
    rest.signal = signal;
  }

  if (!useProxy) {
    return fetch(url, rest);
  }

  return _requestWithAgent(url, { ...rest, agent: _getProxyAgent() });
}

/**
 * Fetch with retries (for Wikipedia etc.).
 */
async function networkFetchWithRetry(url, options = {}, retries = 2) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await networkFetch(url, options);
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
      }
    }
  }
  throw lastErr;
}

async function networkFetchJson(url, options = {}) {
  const res = await networkFetchWithRetry(url, options, options.retries ?? 2);
  const raw = await res.text();
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    throw new Error(`non-json response (${trimmed.slice(0, 40)}...)`);
  }
  return JSON.parse(trimmed);
}

function hasProxyConfigured() {
  return !!_getProxyUrl();
}

module.exports = {
  networkFetch,
  networkFetchWithRetry,
  networkFetchJson,
  hasProxyConfigured,
  getProxyUrl: _getProxyUrl,
};
