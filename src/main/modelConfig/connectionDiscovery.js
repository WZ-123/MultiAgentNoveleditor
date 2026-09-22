'use strict';

const { discoveryPreview } = require('./providerTemplates');

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_MODELS = 500;
const DEFAULT_TIMEOUT_MS = 12_000;

function codedError(message, code, details) { const value = new Error(message); value.code = code; if (details) value.details = details; return value; }
function headerFor(mode, apiKey, customHeaderName) {
  if (mode === 'bearer') return { Authorization: `Bearer ${apiKey}` };
  const headerName = mode === 'custom' ? customHeaderName : mode;
  if (!/^[A-Za-z0-9-]{1,80}$/u.test(headerName || '')) throw codedError('认证 Header 名称无效', 'invalid_auth_header');
  return { [headerName]: apiKey };
}
async function limitedText(response, limit = MAX_RESPONSE_BYTES) {
  if (!response.body || typeof response.body[Symbol.asyncIterator] !== 'function') {
    const text = await response.text();
    if (Buffer.byteLength(text) > limit) throw codedError('模型列表响应过大', 'models_response_too_large');
    return text;
  }
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    const buffer = Buffer.from(chunk); size += buffer.length;
    if (size > limit) throw codedError('模型列表响应过大', 'models_response_too_large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}
function modelArray(payload) {
  if (Array.isArray(payload)) return payload;
  for (const key of ['data', 'models', 'items']) if (Array.isArray(payload?.[key])) return payload[key];
  return [];
}
function boolOrNull(value) { return typeof value === 'boolean' ? value : null; }
function firstDefined(...values) { return values.find((value) => value !== undefined && value !== null); }
function positiveOrNull(value) { const number = Number(value); return Number.isSafeInteger(number) && number > 0 ? number : null; }
function list(value) { return [...new Set((Array.isArray(value) ? value : []).map(String).map((item) => item.trim()).filter(Boolean))]; }
function normalizeDiscoveredModel(raw) {
  const id = String(raw?.id || raw?.model || raw?.name || '').trim();
  if (!id) return null;
  const supported = list(raw.supported_parameters || raw.supportedParameters);
  const contextWindow = positiveOrNull(firstDefined(raw.context_window, raw.contextWindow, raw.context_length, raw.max_context_length, raw.input_token_limit));
  const maxOutputTokens = positiveOrNull(firstDefined(raw.max_output_tokens, raw.maxOutputTokens, raw.output_token_limit));
  const inputModalities = list(firstDefined(raw.input_modalities, raw.inputModalities, raw.architecture?.input_modalities));
  const reasoningEfforts = list(firstDefined(raw.reasoning_efforts, raw.reasoningEfforts, raw.supported_reasoning_efforts));
  const verbosityLevels = list(firstDefined(raw.verbosity_levels, raw.verbosityLevels, raw.supported_verbosity));
  const supportsTools = boolOrNull(firstDefined(raw.supports_tools, raw.supportsTools, supported.length ? supported.includes('tools') : null));
  const supportsStructuredOutput = boolOrNull(firstDefined(raw.supports_structured_output, raw.supportsStructuredOutput, supported.length ? (supported.includes('response_format') || supported.includes('json_schema')) : null));
  const capabilities = { contextWindow, maxOutputTokens, inputModalities, supportsTools, supportsStructuredOutput, reasoningEfforts, verbosityLevels };
  return { id, name: String(raw.display_name || raw.displayName || raw.name || id), capabilities, fieldSources: Object.fromEntries(Object.entries(capabilities).filter(([, value]) => value !== null && (!Array.isArray(value) || value.length)).map(([key]) => [key, 'provider'])), availability: 'available', verification: { responses: 'unknown', tools: 'unknown', verifiedEfforts: [] }, source: 'provider' };
}
function approved(preview, approvedCandidateUrls) {
  const expected = preview.candidates.map((item) => item.modelsUrl);
  const supplied = Array.isArray(approvedCandidateUrls) ? approvedCandidateUrls.map(String) : [];
  return supplied.length > 0 && supplied.every((item) => expected.includes(item));
}
async function discoverConnection(options, dependencies = {}) {
  const fetchImpl = dependencies.fetchImpl || globalThis.fetch;
  const preview = discoveryPreview(options);
  if (!approved(preview, options.approvedCandidateUrls)) throw codedError('探测地址尚未由用户确认', 'discovery_confirmation_required', { preview });
  const apiKey = String(options.apiKey || '');
  if (!apiKey) throw codedError('API Key 不可用', 'credential_unavailable');
  const timeoutMs = Number.isInteger(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
  let lastFailure = null;
  for (const candidate of preview.candidates.filter((item) => options.approvedCandidateUrls.includes(item.modelsUrl))) {
    for (const authMode of preview.authCandidates) {
      options.signal?.throwIfAborted();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response;
      try {
        response = await fetchImpl(candidate.modelsUrl, { method: 'GET', redirect: 'manual', signal: options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal, headers: { Accept: 'application/json', ...headerFor(authMode, apiKey, preview.customHeaderName) } });
      } catch (cause) {
        clearTimeout(timer);
        options.signal?.throwIfAborted();
        lastFailure = codedError(cause?.name === 'AbortError' ? '模型发现超时' : '无法连接模型列表地址', cause?.name === 'AbortError' ? 'discovery_timeout' : 'discovery_network_error');
        break;
      }
      try {
      if (response.status >= 300 && response.status < 400) throw codedError('模型地址返回重定向，需要重新确认目标地址', 'redirect_requires_confirmation', { location: response.headers?.get?.('location') || '' });
      if ([401, 403].includes(response.status)) { lastFailure = codedError('API Key 或认证方式无效', 'discovery_unauthorized'); continue; }
      if (response.status === 429) throw codedError('供应商限制了模型发现请求，请稍后重试', 'discovery_rate_limited');
      if (!response.ok) { lastFailure = codedError(`模型列表返回 HTTP ${response.status}`, 'discovery_http_error'); break; }
      let payload;
      try { payload = JSON.parse(await limitedText(response)); }
      catch (cause) { options.signal?.throwIfAborted(); if (controller.signal.aborted) throw codedError('模型发现超时', 'discovery_timeout'); if (cause?.code) throw cause; throw codedError('模型列表不是有效 JSON', 'discovery_invalid_json'); }
      clearTimeout(timer);
      options.signal?.throwIfAborted();
      const rawModels = modelArray(payload);
      if (!rawModels.length) throw codedError('模型列表响应中没有可识别的模型', 'discovery_empty');
      if (rawModels.length > MAX_MODELS) throw codedError(`模型数量超过上限 ${MAX_MODELS}`, 'discovery_too_many_models');
      const models = rawModels.map(normalizeDiscoveredModel).filter(Boolean);
      if (!models.length) throw codedError('模型列表缺少有效模型 ID', 'discovery_empty');
      const headerName = authMode === 'bearer' ? '' : authMode === 'custom' ? preview.customHeaderName : authMode;
      return { ok: true, template: preview.template, baseUrl: candidate.baseUrl, modelsUrl: candidate.modelsUrl, queryParams: preview.queryParams, auth: authMode === 'bearer' ? { mode: 'bearer' } : { mode: 'header', headerName }, models, discoveredAt: new Date().toISOString(), insecureHttp: preview.insecureHttp };
      } finally { clearTimeout(timer); }
    }
  }
  throw lastFailure || codedError('没有可用的模型发现地址', 'discovery_failed');
}

module.exports = { DEFAULT_TIMEOUT_MS, MAX_MODELS, MAX_RESPONSE_BYTES, discoverConnection, limitedText, modelArray, normalizeDiscoveredModel };
