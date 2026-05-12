'use strict';

/**
 * Anthropic Messages API adapter.
 * Canonical content-block format is preserved end-to-end.
 *
 * sendMessage({ system, messages, tools, tier, abortSignal, onEvent })
 *   -> { stopReason, content }
 */

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

function buildBody({ system, messages, tools, model, maxTokens, extra, stream, thinking }) {
  const body = {
    model,
    max_tokens: maxTokens || 4096,
    messages,
    stream: !!stream,
  };
  if (system) body.system = system;
  if (Array.isArray(tools) && tools.length) body.tools = tools;
  if (extra && typeof extra === 'object') Object.assign(body, extra);
  if (thinking && typeof thinking === 'object') body.thinking = thinking;
  return body;
}

async function* streamSse(response, abortSignal) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    if (abortSignal?.aborted) {
      try { await reader.cancel(); } catch (_) {}
      throw new DOMException('aborted', 'AbortError');
    }
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

  const res = await fetch(url, {
    method: 'POST',
    headers: authHeader(apiKey),
    body: JSON.stringify(body),
    signal: abortSignal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Anthropic ${res.status}: ${text.slice(0, 500)}`);
  }

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
  return { stopReason, content };
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
  const res = await fetch(url, {
    method: 'POST',
    headers: authHeader(apiKey),
    body: JSON.stringify(body),
    signal: abortSignal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Anthropic ${res.status}: ${text.slice(0, 500)}`);
  }
  const data = await res.json();
  return { stopReason: data.stop_reason || 'end_turn', content: data.content || [] };
}

async function sendMessage(opts) {
  if (opts.tier?.extra?.streaming === false) return sendMessageNonStreaming(opts);
  return sendMessageStreaming(opts);
}

module.exports = { sendMessage };
