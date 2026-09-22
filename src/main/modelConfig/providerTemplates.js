'use strict';

const TEMPLATES = Object.freeze([
  { id: 'openai', name: 'OpenAI', hosts: ['api.openai.com'], authCandidates: ['bearer'], documentedBases: ['https://api.openai.com/v1'] },
  { id: 'kimi', name: 'Kimi', hosts: ['api.kimi.com', 'api.moonshot.cn'], authCandidates: ['bearer'], documentedBases: [] },
  {
    id: 'deepseek', name: 'DeepSeek', hosts: ['api.deepseek.com'], authCandidates: ['bearer', 'x-api-key'], documentedBases: ['https://api.deepseek.com'], legacyBasePaths: ['/anthropic'], preferredModelHint: 'flash',
    // Official DeepSeek Codex catalog contract. This is transport metadata,
    // not a fallback model list: it is applied only after /models actually
    // returns the matching model id for the documented origin.
    codexModels: {
      // Verified against DeepSeek's official Codex catalog on 2026-09-14.
      'deepseek-flash': { contextWindow: 1048576, truncationLimit: 10000, reasoningEfforts: ['low', 'high', 'max'], inputModalities: ['text', 'image'], defaultVerbosity: 'low', multiAgentVersion: 'v2', supportsImageDetailOriginal: true },
      'deepseek-v4-pro': { contextWindow: 1048576, truncationLimit: 10000, reasoningEfforts: ['low', 'high', 'max'], inputModalities: ['text'], defaultVerbosity: 'low', multiAgentVersion: 'v2' },
      'deepseek-v4-flash': { contextWindow: 1048576, truncationLimit: 10000, reasoningEfforts: ['none', 'low', 'high', 'max'], inputModalities: ['text'], defaultVerbosity: 'low', multiAgentVersion: 'v2' },
    },
  },
  { id: 'anthropic', name: 'Anthropic', hosts: ['api.anthropic.com'], authCandidates: ['x-api-key', 'bearer'], documentedBases: [] },
  { id: 'generic', name: 'OpenAI-compatible', hosts: [], authCandidates: ['bearer', 'x-api-key', 'api-key'], documentedBases: [] },
]);

function exactHostMatch(hostname, allowed) {
  const host = String(hostname || '').toLowerCase();
  return allowed.some((item) => host === item || host.endsWith(`.${item}`));
}
function templateById(id) { return TEMPLATES.find((item) => item.id === id) || TEMPLATES.at(-1); }
function matchTemplate(url, requestedId) {
  if (requestedId && requestedId !== 'auto') return templateById(requestedId);
  return TEMPLATES.find((item) => item.hosts.length && exactHostMatch(url.hostname, item.hosts)) || templateById('generic');
}
function stripEndpointPath(pathname) {
  const value = String(pathname || '/').replace(/\/+$/u, '') || '/';
  return value.replace(/\/(?:models|responses)$/iu, '').replace(/\/chat\/completions$/iu, '') || '/';
}
function baseCandidate(value) {
  const url = new URL(value);
  url.hash = '';
  url.pathname = stripEndpointPath(url.pathname);
  const queryParams = Object.fromEntries(url.searchParams.entries());
  url.search = '';
  return { baseUrl: url.toString().replace(/\/+$/u, ''), queryParams };
}
function discoveryPreview({ inputUrl, templateId = 'auto', authMode = 'auto', customHeaderName = '' }) {
  const parsed = new URL(String(inputUrl || '').trim());
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('连接地址必须使用 HTTP 或 HTTPS');
  const template = matchTemplate(parsed, templateId);
  const base = baseCandidate(parsed);
  const normalizedBasePath = new URL(base.baseUrl).pathname.replace(/\/+$/u, '') || '/';
  const baseUrl = template.legacyBasePaths?.includes(normalizedBasePath)
    ? new URL(base.baseUrl).origin
    : base.baseUrl;
  const bases = [baseUrl, ...template.documentedBases].filter((item, index, array) => array.indexOf(item) === index);
  if (!/\/v1$/iu.test(new URL(baseUrl).pathname)) bases.push(`${baseUrl}/v1`);
  const candidates = bases.map((baseUrl) => {
    const models = new URL(`${baseUrl.replace(/\/+$/u, '')}/models`);
    for (const [key, value] of Object.entries(base.queryParams)) models.searchParams.set(key, value);
    return { baseUrl, modelsUrl: models.toString(), origin: new URL(baseUrl).origin };
  });
  const authCandidates = authMode === 'auto' ? template.authCandidates : [authMode];
  return {
    template: { id: template.id, name: template.name },
    candidates,
    authCandidates,
    customHeaderName: authMode === 'custom' ? String(customHeaderName || '').trim() : '',
    queryParams: base.queryParams,
    insecureHttp: parsed.protocol === 'http:' && !['localhost', '127.0.0.1', '::1'].includes(parsed.hostname),
  };
}

module.exports = { TEMPLATES, baseCandidate, discoveryPreview, exactHostMatch, matchTemplate, templateById };
