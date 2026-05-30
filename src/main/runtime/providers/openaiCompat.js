'use strict';

const { fetchWithRetry } = require('./retry');

/**
 * OpenAI-compat (Chat Completions) adapter.
 * Converts to/from Anthropic-style content blocks so the runtime stays canonical.
 *
 * Anthropic → OpenAI (request):
 *   - system string -> messages[0] role:'system'
 *   - assistant content blocks:
 *       text -> messages[i].content (string)
 *       tool_use -> messages[i].tool_calls[*]
 *   - user content blocks:
 *       tool_result -> messages[j] role:'tool' (one per tool_use_id, content is string)
 *
 * OpenAI → Anthropic (response):
 *   - choices[0].message.content (string) -> { type:'text', text }
 *   - choices[0].message.tool_calls[*]    -> { type:'tool_use', id, name, input }
 */

function endpoint(baseUrl) {
  const b = (baseUrl || '').replace(/\/$/, '');
  return `${b}/chat/completions`;
}

function normalizeStopReason(stopReason, content) {
  if (Array.isArray(content) && content.some((block) => block?.type === 'tool_use')) {
    return 'tool_use';
  }
  return stopReason || 'end_turn';
}

function authHeader(apiKey) {
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
}

function blockContentToOpenaiText(blocks) {
  if (typeof blocks === 'string') return blocks;
  if (!Array.isArray(blocks)) return '';
  return blocks
    .filter((b) => b && b.type === 'text')
    .map((b) => b.text || '')
    .join('');
}

function toolUseBlocksAsOpenaiToolCalls(blocks) {
  if (!Array.isArray(blocks)) return [];
  return blocks
    .filter((b) => b && b.type === 'tool_use')
    .map((b) => ({
      id: b.id,
      type: 'function',
      function: {
        name: b.name,
        arguments: JSON.stringify(b.input ?? {}),
      },
    }));
}

function toolResultBlocksAsOpenaiToolMessages(blocks) {
  if (!Array.isArray(blocks)) return [];
  return blocks
    .filter((b) => b && b.type === 'tool_result')
    .map((b) => ({
      role: 'tool',
      tool_call_id: b.tool_use_id,
      content: typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? ''),
    }));
}

function convertMessages({ system, messages }) {
  const out = [];
  if (system) out.push({ role: 'system', content: system });
  for (const m of messages) {
    if (m.role === 'user') {
      const blocks = Array.isArray(m.content) ? m.content : [{ type: 'text', text: String(m.content || '') }];
      const toolMsgs = toolResultBlocksAsOpenaiToolMessages(blocks);
      const text = blockContentToOpenaiText(blocks);
      if (toolMsgs.length) {
        out.push(...toolMsgs);
      }
      if (text) out.push({ role: 'user', content: text });
      if (!text && !toolMsgs.length) {
        out.push({ role: 'user', content: '' });
      }
    } else if (m.role === 'assistant') {
      const blocks = Array.isArray(m.content) ? m.content : [{ type: 'text', text: String(m.content || '') }];
      const text = blockContentToOpenaiText(blocks);
      const tools = toolUseBlocksAsOpenaiToolCalls(blocks);
      const msg = { role: 'assistant', content: text || '' };
      if (tools.length) msg.tool_calls = tools;
      out.push(msg);
    } else if (m.role === 'system') {
      out.push({ role: 'system', content: typeof m.content === 'string' ? m.content : '' });
    }
  }
  return out;
}

function convertTools(tools) {
  if (!Array.isArray(tools) || !tools.length) return undefined;
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description || '',
      parameters: t.input_schema || { type: 'object', properties: {} },
    },
  }));
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
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trimEnd();
      buf = buf.slice(nl + 1);
      if (!line || line.startsWith(':')) continue;
      if (line.startsWith('data:')) {
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') return;
        try {
          yield JSON.parse(payload);
        } catch (_) {
          // skip malformed
        }
      }
    }
  }
}

async function sendMessageStreaming(opts) {
  const { system, messages, tools, tier, abortSignal, onEvent, runId, nodeId, subagentId } = opts;
  const apiKey = tier.apiKey || '';
  if (!apiKey) throw new Error('OpenAI-compat API key missing for tier');
  const url = endpoint(tier.baseUrl);
  const body = {
    model: tier.model,
    stream: true,
    messages: convertMessages({ system, messages }),
  };
  const cvtTools = convertTools(tools);
  if (cvtTools) body.tools = cvtTools;
  if (tier.extra?.responseFormat) body.response_format = tier.extra.responseFormat;
  if (tier.extra && typeof tier.extra === 'object') {
    for (const [k, v] of Object.entries(tier.extra)) {
      if (k === 'streaming' || k === 'responseFormat' || k === 'thinking') continue;
      body[k] = v;
    }
  }

  const res = await fetchWithRetry(
    url,
    {
      method: 'POST',
      headers: authHeader(apiKey),
      body: JSON.stringify(body),
      signal: abortSignal,
    },
    'OpenAI-compat',
    abortSignal,
  );

  let assistantText = '';
  const toolCallsByIndex = new Map();
  let stopReason = 'end_turn';

  for await (const chunk of streamSse(res, abortSignal)) {
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta || {};
    if (typeof delta.content === 'string' && delta.content) {
      assistantText += delta.content;
      onEvent && onEvent({ runId, nodeId, subagentId, kind: 'text', data: { delta: delta.content } });
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const tcDelta of delta.tool_calls) {
        const idx = tcDelta.index ?? 0;
        const cur = toolCallsByIndex.get(idx) || { id: '', name: '', argsBuf: '' };
        if (tcDelta.id) cur.id = tcDelta.id;
        if (tcDelta.function?.name) cur.name = tcDelta.function.name;
        if (typeof tcDelta.function?.arguments === 'string') {
          cur.argsBuf += tcDelta.function.arguments;
        }
        toolCallsByIndex.set(idx, cur);
      }
    }
    if (choice.finish_reason) {
      const fr = choice.finish_reason;
      if (fr === 'tool_calls') stopReason = 'tool_use';
      else if (fr === 'length') stopReason = 'max_tokens';
      else if (fr === 'stop') stopReason = 'end_turn';
      else stopReason = fr;
    }
  }

  const content = [];
  if (assistantText) content.push({ type: 'text', text: assistantText });
  for (const idx of Array.from(toolCallsByIndex.keys()).sort((a, b) => a - b)) {
    const tc = toolCallsByIndex.get(idx);
    let input = {};
    try { input = tc.argsBuf ? JSON.parse(tc.argsBuf) : {}; }
    catch (_) { input = { __raw: tc.argsBuf }; }
    if (!tc.id) tc.id = `tc_${idx}_${Date.now().toString(36)}`;
    content.push({ type: 'tool_use', id: tc.id, name: tc.name, input });
    onEvent && onEvent({
      runId, nodeId, subagentId, kind: 'tool_use',
      data: { id: tc.id, name: tc.name, input },
    });
  }

  return { stopReason: normalizeStopReason(stopReason, content), content };
}

async function sendMessageNonStreaming(opts) {
  const { system, messages, tools, tier, abortSignal } = opts;
  const apiKey = tier.apiKey || '';
  if (!apiKey) throw new Error('OpenAI-compat API key missing for tier');
  const url = endpoint(tier.baseUrl);
  const body = {
    model: tier.model,
    messages: convertMessages({ system, messages }),
  };
  const cvtTools = convertTools(tools);
  if (cvtTools) body.tools = cvtTools;
  if (tier.extra?.responseFormat) body.response_format = tier.extra.responseFormat;
  if (tier.extra && typeof tier.extra === 'object') {
    for (const [k, v] of Object.entries(tier.extra)) {
      if (k === 'streaming' || k === 'responseFormat' || k === 'thinking') continue;
      body[k] = v;
    }
  }
  const res = await fetchWithRetry(
    url,
    {
      method: 'POST',
      headers: authHeader(apiKey),
      body: JSON.stringify(body),
      signal: abortSignal,
    },
    'OpenAI-compat',
    abortSignal,
  );
  const data = await res.json();
  const choice = data.choices?.[0];
  const content = [];
  const textOut = choice?.message?.content;
  if (typeof textOut === 'string' && textOut) content.push({ type: 'text', text: textOut });
  const tcs = choice?.message?.tool_calls;
  if (Array.isArray(tcs)) {
    for (const tc of tcs) {
      let input = {};
      try { input = tc.function?.arguments ? JSON.parse(tc.function.arguments) : {}; }
      catch (_) { input = { __raw: tc.function?.arguments }; }
      content.push({ type: 'tool_use', id: tc.id, name: tc.function?.name || '', input });
    }
  }
  let stopReason = 'end_turn';
  if (choice?.finish_reason === 'tool_calls') stopReason = 'tool_use';
  else if (choice?.finish_reason === 'length') stopReason = 'max_tokens';
  return { stopReason: normalizeStopReason(stopReason, content), content };
}

async function sendMessage(opts) {
  if (opts.tier?.extra?.streaming === false) return sendMessageNonStreaming(opts);
  return sendMessageStreaming(opts);
}

module.exports = { sendMessage, _internal: { convertMessages, convertTools } };
