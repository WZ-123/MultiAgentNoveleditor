'use strict';

/**
 * Anthropic Messages API adapter.
 * Canonical content-block format is preserved end-to-end.
 *
 * sendMessage({ system, messages, tools, tier, abortSignal, onEvent })
 *   -> { stopReason, content }
 */

const { fetchWithRetry } = require('./retry');

const ANTHROPIC_VERSION = '2023-06-01';

function authHeader(apiKey) {
  return {
    'x-api-key': apiKey,
    'anthropic-version': ANTHROPIC_VERSION,
    'content-type': 'application/json',
  };
}

function endpoint(baseUrl) {
  const b = (baseUrl || 'https://api.anthropic.com').replace(/\/$/, '');
  return `${b}/v1/messages`;
}

function endpointLabel(baseUrl) {
  const url = endpoint(baseUrl);
  if ((baseUrl || '').includes('api.anthropic.com')) return 'Anthropic API';
  return `Anthropic-compatible endpoint (${url})`;
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function sanitizeSchemaNode(node, isRoot = false) {
  if (typeof node === 'boolean') return node;
  if (!isPlainObject(node)) {
    return isRoot ? { type: 'object', properties: {} } : {};
  }

  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (value == null) continue;

    if (key === 'properties') {
      if (!isPlainObject(value)) continue;
      const props = {};
      for (const [propName, propSchema] of Object.entries(value)) {
        if (propSchema == null) continue;
        props[propName] = sanitizeSchemaNode(propSchema);
      }
      out.properties = props;
      continue;
    }

    if (key === 'additionalProperties') {
      if (typeof value === 'boolean') out.additionalProperties = value;
      else if (isPlainObject(value)) out.additionalProperties = sanitizeSchemaNode(value);
      continue;
    }

    if (key === 'items') {
      out.items = typeof value === 'boolean' ? value : sanitizeSchemaNode(value);
      continue;
    }

    if (key === 'oneOf' || key === 'anyOf' || key === 'allOf') {
      if (!Array.isArray(value)) continue;
      const branches = value
        .filter((entry) => entry != null)
        .map((entry) => (typeof entry === 'boolean' ? entry : sanitizeSchemaNode(entry)));
      if (branches.length) out[key] = branches;
      continue;
    }

    if (Array.isArray(value)) {
      out[key] = value
        .filter((entry) => entry != null)
        .map((entry) => (isPlainObject(entry) ? sanitizeSchemaNode(entry) : entry));
      continue;
    }

    if (isPlainObject(value)) {
      out[key] = sanitizeSchemaNode(value);
      continue;
    }

    out[key] = value;
  }

  if (out.type === 'object' && !isPlainObject(out.properties)) {
    out.properties = {};
  }
  if (out.type === 'array' && !Object.prototype.hasOwnProperty.call(out, 'items')) {
    out.items = {};
  }

  return out;
}

function normalizeTools(tools) {
  if (!Array.isArray(tools) || !tools.length) return undefined;
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description || '',
    input_schema: sanitizeSchemaNode(tool.input_schema || tool.inputSchema || { type: 'object', properties: {} }, true),
  }));
}

function normalizeStopReason(stopReason, content) {
  if (Array.isArray(content) && content.some((block) => block?.type === 'tool_use')) {
    return 'tool_use';
  }
  return stopReason || 'end_turn';
}

function buildBody({ system, messages, tools, model, maxTokens, extra, stream, thinking }) {
  const body = {
    model,
    max_tokens: maxTokens || 4096,
    messages,
    stream: !!stream,
  };
  if (system) body.system = system;
  const normalizedTools = normalizeTools(tools);
  if (normalizedTools) body.tools = normalizedTools;
  if (extra && typeof extra === 'object') Object.assign(body, extra);
  if (thinking && typeof thinking === 'object') body.thinking = thinking;
  return body;
}

async function* streamSse(response, abortSignal) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  // Wire abortSignal to cancel the reader mid-read, preventing hangs when
  // the server stalls mid-stream (reader.read() would otherwise hang forever).
  const onAbort = () => { try { reader.cancel(); } catch (_) {} };
  if (abortSignal) {
    if (abortSignal.aborted) {
      try { await reader.cancel(); } catch (_) {}
      throw new DOMException('aborted', 'AbortError');
    }
    abortSignal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const lines = block.split('\n');
        let dataPayload = '';
        for (const line of lines) {
          if (line.startsWith('data:')) dataPayload += line.slice(5).trim();
        }
        if (!dataPayload || dataPayload === '[DONE]') continue;
        try {
          const obj = JSON.parse(dataPayload);
          yield obj;
        } catch (_) {
          // malformed line — skip
        }
      }
    }
  } finally {
    if (abortSignal) {
      abortSignal.removeEventListener('abort', onAbort);
    }
  }
}

async function sendMessageStreaming(opts) {
  const {
    system,
    messages,
    tools,
    tier,
    abortSignal,
    onEvent,
    runId,
    nodeId,
    subagentId,
  } = opts;

  const apiKey = tier.apiKey || '';
  if (!apiKey) {
    throw new Error('Anthropic API key missing for tier');
  }
  const url = endpoint(tier.baseUrl);
  const body = buildBody({
    system,
    messages,
    tools,
    model: tier.model,
    maxTokens: tier.extra?.maxTokens,
    extra: tier.extra,
    stream: true,
    thinking: tier.thinking,
  });

  const label = endpointLabel(tier.baseUrl);
  const res = await fetchWithRetry(
    url,
    {
      method: 'POST',
      headers: authHeader(apiKey),
      body: JSON.stringify(body),
      signal: abortSignal,
    },
    label,
    abortSignal,
  );

  const blocks = [];
  let stopReason = 'end_turn';
  const partialJsonByIndex = new Map();

  for await (const ev of streamSse(res, abortSignal)) {
    const t = ev.type;
    if (t === 'message_start') {
      onEvent && onEvent({ runId, nodeId, subagentId, kind: 'running', data: { model: ev.message?.model } });
    } else if (t === 'content_block_start') {
      const idx = ev.index;
      const cb = ev.content_block;
      if (cb?.type === 'text') {
        blocks[idx] = { type: 'text', text: '' };
      } else if (cb?.type === 'thinking') {
        blocks[idx] = { type: 'thinking', thinking: '' };
      } else if (cb?.type === 'tool_use') {
        blocks[idx] = { type: 'tool_use', id: cb.id, name: cb.name, input: {} };
        partialJsonByIndex.set(idx, '');
        onEvent && onEvent({
          runId, nodeId, subagentId, kind: 'tool_use',
          data: { id: cb.id, name: cb.name, input: {} },
        });
      }
    } else if (t === 'content_block_delta') {
      const idx = ev.index;
      const d = ev.delta;
      if (d?.type === 'text_delta') {
        blocks[idx] = blocks[idx] || { type: 'text', text: '' };
        blocks[idx].text += d.text || '';
        onEvent && onEvent({ runId, nodeId, subagentId, kind: 'text', data: { delta: d.text } });
      } else if (d?.type === 'thinking_delta') {
        blocks[idx] = blocks[idx] || { type: 'thinking', thinking: '' };
        blocks[idx].thinking += d.thinking || '';
        onEvent && onEvent({ runId, nodeId, subagentId, kind: 'thinking', data: { delta: d.thinking } });
      } else if (d?.type === 'input_json_delta') {
        const cur = partialJsonByIndex.get(idx) || '';
        partialJsonByIndex.set(idx, cur + (d.partial_json || ''));
      }
    } else if (t === 'content_block_stop') {
      const idx = ev.index;
      const block = blocks[idx];
      if (block?.type === 'tool_use') {
        const raw = partialJsonByIndex.get(idx) || '';
        try {
          block.input = raw ? JSON.parse(raw) : {};
        } catch (_) {
          block.input = { __raw: raw };
        }
      }
    } else if (t === 'message_delta') {
      if (ev.delta?.stop_reason) stopReason = ev.delta.stop_reason;
    } else if (t === 'message_stop') {
      // done
    } else if (t === 'error') {
      throw new Error(`Anthropic stream error: ${ev.error?.message || 'unknown'}`);
    }
  }

  const content = blocks.filter(Boolean);
  return { stopReason: normalizeStopReason(stopReason, content), content };
}

async function sendMessageNonStreaming(opts) {
  const { system, messages, tools, tier, abortSignal } = opts;
  const apiKey = tier.apiKey || '';
  if (!apiKey) throw new Error('Anthropic API key missing for tier');
  const url = endpoint(tier.baseUrl);
  const body = buildBody({
    system,
    messages,
    tools,
    model: tier.model,
    maxTokens: tier.extra?.maxTokens,
    extra: tier.extra,
    stream: false,
    thinking: tier.thinking,
  });
  const label = endpointLabel(tier.baseUrl);
  const res = await fetchWithRetry(
    url,
    {
      method: 'POST',
      headers: authHeader(apiKey),
      body: JSON.stringify(body),
      signal: abortSignal,
    },
    label,
    abortSignal,
  );
  const data = await res.json();
  const content = data.content || [];
  return { stopReason: normalizeStopReason(data.stop_reason || 'end_turn', content), content };
}

async function sendMessage(opts) {
  if (opts.tier?.extra?.streaming === false) return sendMessageNonStreaming(opts);
  return sendMessageStreaming(opts);
}

module.exports = { sendMessage };
