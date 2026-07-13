'use strict';

function tokenNumber(value) {
  return Number.isFinite(Number(value)) ? Math.max(0, Math.trunc(Number(value))) : 0;
}

function estimateTokens(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value || '');
  if (!text) return 0;
  const ascii = (text.match(/[\x00-\x7f]/g) || []).length;
  const nonAscii = Math.max(0, text.length - ascii);
  return Math.max(1, Math.ceil(ascii / 4 + nonAscii / 1.5));
}

function normalizeProviderUsage(value, fallback = {}) {
  const raw = value && typeof value === 'object' ? value : {};
  let inputTokens = tokenNumber(raw.inputTokens ?? raw.input_tokens ?? raw.prompt_tokens);
  let outputTokens = tokenNumber(raw.outputTokens ?? raw.output_tokens ?? raw.completion_tokens);
  let estimated = raw.estimated === true;
  if (!inputTokens && fallback.input != null) {
    inputTokens = estimateTokens(fallback.input);
    estimated = true;
  }
  if (!outputTokens && fallback.output != null) {
    outputTokens = estimateTokens(fallback.output);
    estimated = true;
  }
  return {
    inputTokens,
    outputTokens,
    totalTokens: tokenNumber(raw.totalTokens ?? raw.total_tokens) || inputTokens + outputTokens,
    cacheReadTokens: tokenNumber(raw.cacheReadTokens ?? raw.cache_read_input_tokens ?? raw.prompt_tokens_details?.cached_tokens),
    cacheWriteTokens: tokenNumber(raw.cacheWriteTokens ?? raw.cache_creation_input_tokens),
    estimated,
  };
}

function addUsage(left, right) {
  const a = normalizeProviderUsage(left);
  const b = normalizeProviderUsage(right);
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    totalTokens: a.totalTokens + b.totalTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    estimated: a.estimated || b.estimated,
  };
}

module.exports = { addUsage, estimateTokens, normalizeProviderUsage };
