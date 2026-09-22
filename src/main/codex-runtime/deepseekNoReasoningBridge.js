'use strict';

const crypto = require('node:crypto');
const http = require('node:http');
const { Readable } = require('node:stream');

const NO_REASONING_OUTPUT_CAP = 6_000;
const CONSISTENCY_REVIEW_OUTPUT_CAP = 1_200;
const DEEPSEEK_UPSTREAM_TIMEOUT_MS = 50_000;
const CONSISTENCY_REVIEW_TIMEOUT_MS = 18_000;
const NOVEL_TOOL_NAMES = new Set(['connection_probe', 'list_novel_resources', 'read_novel_resource', 'search_novel_resources', 'scan_de_ai_patterns', 'check_de_ai_minimality', 'check_timeline_feasibility']);

function normalizeNoReasoningRequest(body) {
  if (!body || typeof body !== 'object' || body.reasoning?.effort !== 'none') return body;
  const input = Array.isArray(body.input) ? body.input.filter((item) => item?.type !== 'reasoning') : body.input;
  const requested = Number(body.max_output_tokens);
  const textOnly = Array.isArray(body.tools) && body.tools.length <= 2;
  const consistencyReview = isConsistencyReviewRequest(body);
  const outputCap = consistencyReview ? CONSISTENCY_REVIEW_OUTPUT_CAP : NO_REASONING_OUTPUT_CAP;
  return {
    ...body,
    ...(body.model === 'deepseek-v4-flash' ? { model: 'deepseek-chat' } : {}),
    input,
    ...(textOnly ? { tools: [], tool_choice: 'none' } : {}),
    reasoning: { ...(body.reasoning || {}), effort: 'none' },
    thinking: { type: 'disabled' },
    max_output_tokens: Number.isFinite(requested) && requested > 0
      ? Math.min(requested, outputCap)
      : outputCap,
  };
}

function isConsistencyReviewRequest(body) {
  return Array.isArray(body?.input) && body.input.some((item) => item?.type === 'message' && messageText(item).includes('<name>mana-consistency-review</name>'));
}

function upstreamTimeoutMs(body) {
  return isConsistencyReviewRequest(body) ? CONSISTENCY_REVIEW_TIMEOUT_MS : DEEPSEEK_UPSTREAM_TIMEOUT_MS;
}

function messageText(item) {
  if (typeof item?.content === 'string') return item.content;
  if (!Array.isArray(item?.content)) return '';
  return item.content.map((part) => String(part?.text || '')).join('');
}

function isTextOnlyRequest(body) {
  return body?.reasoning?.effort === 'none' && Array.isArray(body.tools) && body.tools.length <= 2
    && (!Array.isArray(body.input) || body.input.every((item) => item?.type === 'message'));
}

function responsesInputToChatMessages(body) {
  const messages = [];
  const systemParts = [];
  if (body.instructions) systemParts.push(String(body.instructions));
  const input = (Array.isArray(body.input) ? body.input : []).filter((item) => item?.type !== 'reasoning');
  for (let index = 0; index < input.length;) {
    const item = input[index];
    if (item?.type === 'message') {
      const role = ['assistant', 'system', 'developer', 'user'].includes(item.role) ? item.role : 'user';
      if (role === 'system' || role === 'developer') systemParts.push(messageText(item));
      else messages.push({ role, content: messageText(item) });
      index += 1;
      continue;
    }
    if (item?.type === 'function_call' || item?.type === 'custom_tool_call') {
      const toolCalls = [];
      while (index < input.length && (input[index]?.type === 'function_call' || input[index]?.type === 'custom_tool_call')) {
        const call = input[index];
        const isCustom = call.type === 'custom_tool_call';
        toolCalls.push({
          id: call.call_id || call.id,
          type: 'function',
          function: {
            name: call.name,
            arguments: isCustom ? JSON.stringify({ patch: String(call.input || '') }) : String(call.arguments || '{}'),
          },
        });
        index += 1;
      }
      messages.push({ role: 'assistant', content: null, tool_calls: toolCalls });
      continue;
    }
    if (item?.type === 'function_call_output' || item?.type === 'custom_tool_call_output') {
      const output = typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? '');
      messages.push({ role: 'tool', tool_call_id: item.call_id, content: output });
    }
    index += 1;
  }
  return systemParts.length ? [{ role: 'system', content: systemParts.filter(Boolean).join('\n\n') }, ...messages] : messages;
}

function responsesToolsToChatTools(tools) {
  const unsupportedGenericMcpTools = new Set(['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource']);
  return (Array.isArray(tools) ? tools : []).map((tool) => {
    if (tool?.type === 'function') {
      if (unsupportedGenericMcpTools.has(tool.name)) return null;
      const name = tool.namespace === 'mcp__novel_tools'
        ? `novel_${tool.name}`
        : tool.name.startsWith('mcp__novel_tools__') ? `novel_${tool.name.slice('mcp__novel_tools__'.length)}` : tool.name;
      return { type: 'function', function: { name, description: tool.description || '', parameters: tool.parameters || tool.input_schema || tool.inputSchema || { type: 'object', properties: {} } } };
    }
    if (tool?.type === 'custom' && tool.name === 'apply_patch') {
      return { type: 'function', function: { name: 'apply_patch', description: tool.description || 'Apply a patch.', parameters: { type: 'object', properties: { patch: { type: 'string' } }, required: ['patch'], additionalProperties: false } } };
    }
    return null;
  }).filter(Boolean);
}

function parseToolArguments(value) {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(String(value || '{}')); } catch { return null; }
}

function normalizePatchInput(value) {
  const input = String(value || '').trim();
  if (/^\*\*\* (?:Update|Add|Delete) File:/u.test(input) && !input.startsWith('*** Begin Patch')) {
    return `*** Begin Patch\n${input}${input.endsWith('*** End Patch') ? '' : '\n*** End Patch'}`;
  }
  return input;
}

function normalizeChatToolCall(call) {
  let name = String(call?.function?.name || '');
  let raw = String(call?.function?.arguments || '{}');
  let parsed = parseToolArguments(raw);
  if (name === 'invoke' && !parsed) {
    const dsmlSource = raw.replaceAll('\\"', '"').replaceAll('\\n', '\n');
    const malformedDsml = dsmlSource.match(/"function"\s*:\s*"(read_novel_resource)"?>[\s\S]*?(\{"resourceRef"\s*:\s*"[^"]+"\})/iu);
    if (malformedDsml) {
      name = malformedDsml[1];
      raw = malformedDsml[2];
      parsed = parseToolArguments(raw);
    }
  }
  if (name === 'invoke' && parsed && typeof parsed.function === 'string') {
    const dsml = parsed.function.match(/^([a-z_][a-z0-9_.-]*)">[\s\S]*?(\{[\s\S]*\})$/iu);
    name = dsml ? dsml[1] : parsed.function;
    raw = dsml ? dsml[2]
      : typeof parsed.parameter === 'string' ? parsed.parameter
        : typeof parsed.arguments === 'string' ? parsed.arguments
          : JSON.stringify(parsed.parameter || parsed.arguments || {});
    parsed = parseToolArguments(raw);
  }
  if (name === 'invoke' && parsed && typeof parsed.name === 'string') {
    name = parsed.name;
    raw = typeof parsed.arguments === 'string' ? parsed.arguments
      : typeof parsed.argument === 'string' ? parsed.argument
        : JSON.stringify(parsed.arguments || parsed.argument || {});
    parsed = parseToolArguments(raw);
  }
  if (name === 'invoke' && parsed && typeof parsed.tool === 'string') {
    name = parsed.tool;
    raw = typeof parsed.arguments === 'string' ? parsed.arguments : JSON.stringify(parsed.arguments || {});
    parsed = parseToolArguments(raw);
  }
  if ((name === 'invoke_function' || name === 'functions.exec') && parsed && typeof parsed.function === 'string') {
    name = parsed.function;
    raw = typeof parsed.parameter === 'string' ? parsed.parameter
      : typeof parsed.arguments === 'string' ? parsed.arguments
        : JSON.stringify(parsed.parameter || parsed.arguments || {});
    parsed = parseToolArguments(raw);
  }
  if (name === 'functions.exec' && parsed && Array.isArray(parsed.tools) && typeof parsed.tools[0] === 'string') {
    name = parsed.tools[0];
    raw = typeof parsed.arguments === 'string' ? parsed.arguments : JSON.stringify(parsed.arguments || {});
    parsed = parseToolArguments(raw);
  }
  if (name === 'functions.exec' && parsed && Array.isArray(parsed.tools) && parsed.tools[0] && typeof parsed.tools[0] === 'object') {
    const declaredTool = parsed.tools[0];
    const declaredName = String(declaredTool.name || '');
    if (declaredName && (declaredTool.mcpserver === 'novel_tools' || NOVEL_TOOL_NAMES.has(declaredName))) {
      name = declaredName;
      raw = typeof parsed.arguments === 'string' ? parsed.arguments : JSON.stringify(parsed.arguments || {});
      parsed = parseToolArguments(raw);
    }
  }
  if ((name === 'novel_tools' || name === 'mcp__novel_tools') && parsed && typeof parsed.command === 'string') {
    const commandAliases = { read: 'read_novel_resource', list: 'list_novel_resources', search: 'search_novel_resources', probe: 'connection_probe' };
    name = commandAliases[parsed.command] || parsed.command;
    const { command: _command, ...commandArguments } = parsed;
    raw = typeof commandArguments.arguments === 'string' && Object.keys(commandArguments).length === 1
      ? commandArguments.arguments
      : JSON.stringify(commandArguments.arguments && typeof commandArguments.arguments === 'object' && Object.keys(commandArguments).length === 1 ? commandArguments.arguments : commandArguments);
    parsed = parseToolArguments(raw);
  }
  if ((name === 'novel_tools' || name === 'mcp__novel_tools') && parsed && typeof parsed.tool_name === 'string') {
    name = parsed.tool_name;
    raw = typeof parsed.arguments === 'string' ? parsed.arguments : JSON.stringify(parsed.arguments || {});
    parsed = parseToolArguments(raw);
  }
  if (name.startsWith('novel_tools_')) name = name.slice('novel_tools_'.length);
  if (name.startsWith('novel_tools.')) name = name.slice('novel_tools.'.length);
  if (name.startsWith('mcp__novel_tools.')) name = name.slice('mcp__novel_tools.'.length);
  if (name.startsWith('functions.mcp.novel_tools.')) name = name.slice('functions.mcp.novel_tools.'.length);
  if (name.startsWith('functions.novel_tools.')) name = name.slice('functions.novel_tools.'.length);
  if (parsed && typeof parsed.arguments === 'string' && Object.keys(parsed).length === 1) raw = parsed.arguments;
  else if (parsed && typeof parsed.argument === 'string' && Object.keys(parsed).length === 1) raw = parsed.argument;
  parsed = parseToolArguments(raw);
  if (name === 'read_novel_resource' && parsed && typeof parsed.resourceRef === 'string' && parsed.resourceRef.trim().startsWith('{')) {
    const nestedResource = parseToolArguments(parsed.resourceRef);
    if (nestedResource && typeof nestedResource.resourceRef === 'string') {
      parsed.resourceRef = nestedResource.resourceRef;
      raw = JSON.stringify(parsed);
    }
  }
  if (NOVEL_TOOL_NAMES.has(name) && parsed && typeof parsed === 'object' && Object.hasOwn(parsed, 'novelId')) {
    delete parsed.novelId;
    raw = JSON.stringify(parsed);
  }
  return { name, arguments: raw };
}

function explicitResourceRefs(body) {
  const refs = [];
  const seen = new Set();
  const pattern = /(?:chapter:chapter-\d{3}\.md|outline:chapter:\d+:\d+:\d+|outline:master|world:lore|style:memory|character:[a-z0-9-]+|timeline:event:[a-z0-9-]+)/giu;
  for (const item of Array.isArray(body?.input) ? body.input : []) {
    if (item?.type !== 'message' || item.role !== 'user') continue;
    for (const match of messageText(item).match(pattern) || []) {
      if (!seen.has(match)) { seen.add(match); refs.push(match); }
    }
  }
  return refs;
}

function normalizeChatToolCalls(calls, body) {
  return (Array.isArray(calls) ? calls : []).map((call) => {
    const normalized = normalizeChatToolCall(call);
    if (normalized.name !== 'read_novel_resource') return { call, normalized };
    const parsed = parseToolArguments(normalized.arguments);
    if (typeof parsed?.resourceRef !== 'string' || !parsed.resourceRef.trim()) {
      normalized.arguments = JSON.stringify({});
    }
    return { call, normalized };
  });
}

function originalToolName(chatName, tools) {
  const expected = String(chatName || '').startsWith('novel_') ? `mcp__novel_tools__${String(chatName).slice('novel_'.length)}` : String(chatName || '');
  const available = (Array.isArray(tools) ? tools : []).map((tool) => String(tool?.name || '')).filter(Boolean);
  if (available.includes(expected)) return expected;
  const suffixMatches = available.filter((name) => name.startsWith('mcp__novel_tools__') && name.endsWith(`__${String(chatName || '')}`));
  return suffixMatches.length === 1 ? suffixMatches[0] : String(chatName || '');
}

function originalToolCall(chatName, tools) {
  const available = Array.isArray(tools) ? tools : [];
  const bare = String(chatName || '').startsWith('novel_') ? String(chatName).slice('novel_'.length) : String(chatName || '');
  if (NOVEL_TOOL_NAMES.has(bare)) return { name: bare, namespace: 'mcp__novel_tools' };
  const namespaced = available.filter((tool) => tool?.namespace === 'mcp__novel_tools' && tool?.name === bare);
  if (namespaced.length === 1) return { name: bare, namespace: 'mcp__novel_tools' };
  return { name: originalToolName(chatName, available) };
}

function responseSse(response) {
  let sequence = 0;
  const events = [];
  const add = (event, data) => events.push([event, { type: event, sequence_number: sequence++, ...data }]);
  const started = { ...response, status: 'in_progress', output: [], usage: null };
  add('response.created', { response: started });
  add('response.in_progress', { response: started });
  response.output.forEach((item, outputIndex) => {
    if (item.type === 'message') {
      add('response.output_item.added', { output_index: outputIndex, item: { ...item, status: 'in_progress', content: [] } });
      add('response.content_part.added', { item_id: item.id, output_index: outputIndex, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
      add('response.output_text.delta', { item_id: item.id, output_index: outputIndex, content_index: 0, delta: item.content[0].text });
      add('response.output_text.done', { item_id: item.id, output_index: outputIndex, content_index: 0, text: item.content[0].text });
      add('response.content_part.done', { item_id: item.id, output_index: outputIndex, content_index: 0, part: item.content[0] });
    } else {
      const pending = { ...item, status: 'in_progress', ...(item.type === 'function_call' ? { arguments: '' } : { input: '' }) };
      add('response.output_item.added', { output_index: outputIndex, item: pending });
      if (item.type === 'function_call') {
        add('response.function_call_arguments.delta', { item_id: item.id, output_index: outputIndex, delta: item.arguments });
        add('response.function_call_arguments.done', { item_id: item.id, output_index: outputIndex, arguments: item.arguments });
      } else {
        add('response.custom_tool_call_input.delta', { item_id: item.id, output_index: outputIndex, delta: item.input });
        add('response.custom_tool_call_input.done', { item_id: item.id, output_index: outputIndex, input: item.input });
      }
    }
    add('response.output_item.done', { output_index: outputIndex, item });
  });
  add('response.completed', { response });
  return events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
}

async function chatCompletionAsResponses({ body, headers, target }) {
  const messages = responsesInputToChatMessages(body);
  const tools = responsesToolsToChatTools(body.tools);
  const controller = new AbortController();
  const timeoutMs = upstreamTimeoutMs(body);
  const timeout = setTimeout(() => controller.abort(new Error(`DeepSeek upstream exceeded ${timeoutMs}ms`)), timeoutMs);
  let upstream;
  try {
    upstream = await fetch(`${target}/chat/completions`, {
      method: 'POST', headers, signal: controller.signal,
      body: JSON.stringify({
        model: body.model === 'deepseek-v4-flash' ? 'deepseek-v4-flash' : body.model,
        messages,
        ...(tools.length ? { tools } : {}),
        thinking: { type: 'disabled' },
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: Math.min(Number(body.max_output_tokens) || NO_REASONING_OUTPUT_CAP, NO_REASONING_OUTPUT_CAP),
      }),
    });
  } catch (error) {
    clearTimeout(timeout);
    throw error;
  }
  if (!upstream.ok || !upstream.body) {
    let error;
    try { error = await upstream.json(); } catch { error = { error: await upstream.text().catch(() => '') }; }
    clearTimeout(timeout);
    return { status: upstream.status, error };
  }
  const id = `resp_${crypto.randomUUID().replace(/-/gu, '')}`;
  const responseBase = {
    id, object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'completed',
    error: null, incomplete_details: null, instructions: null, max_output_tokens: body.max_output_tokens || null,
    model: 'deepseek-v4-flash', output: [],
    parallel_tool_calls: true, previous_response_id: null, reasoning: { effort: 'none', summary: null }, store: false,
    usage: null,
  };
  async function* convertedStream() {
    let sequence = 0;
    const encode = (event, data) => `event: ${event}\ndata: ${JSON.stringify({ type: event, sequence_number: sequence++, ...data })}\n\n`;
    const started = { ...responseBase, status: 'in_progress' };
    yield encode('response.created', { response: started });
    yield encode('response.in_progress', { response: started });
    const decoder = new TextDecoder();
    let buffer = '';
    let text = '';
    let messageItem = null;
    const toolCalls = new Map();
    let usage = null;
    try {
      for await (const chunk of upstream.body) {
        buffer += decoder.decode(chunk, { stream: true });
        while (buffer.includes('\n')) {
          const newline = buffer.indexOf('\n');
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          let packet;
          try { packet = JSON.parse(payload); } catch { continue; }
          if (packet.usage) usage = packet.usage;
          const delta = packet.choices?.[0]?.delta || {};
          const content = typeof delta.content === 'string' ? delta.content : '';
          if (content) {
            if (!messageItem) {
              messageItem = { type: 'message', id: `msg_${crypto.randomUUID().replace(/-/gu, '')}`, status: 'in_progress', role: 'assistant', content: [] };
              yield encode('response.output_item.added', { output_index: 0, item: messageItem });
              yield encode('response.content_part.added', { item_id: messageItem.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
            }
            text += content;
            yield encode('response.output_text.delta', { item_id: messageItem.id, output_index: 0, content_index: 0, delta: content });
          }
          for (const fragment of delta.tool_calls || []) {
            const index = Number.isInteger(fragment.index) ? fragment.index : toolCalls.size;
            const current = toolCalls.get(index) || { id: '', type: 'function', function: { name: '', arguments: '' } };
            if (fragment.id) current.id = fragment.id;
            if (fragment.function?.name) current.function.name += fragment.function.name;
            if (fragment.function?.arguments) current.function.arguments += fragment.function.arguments;
            toolCalls.set(index, current);
          }
        }
      }
      const output = [];
      if (messageItem) {
        const part = { type: 'output_text', text, annotations: [] };
        const complete = { ...messageItem, status: 'completed', content: [part] };
        yield encode('response.output_text.done', { item_id: messageItem.id, output_index: 0, content_index: 0, text });
        yield encode('response.content_part.done', { item_id: messageItem.id, output_index: 0, content_index: 0, part });
        yield encode('response.output_item.done', { output_index: 0, item: complete });
        output.push(complete);
      }
      for (const { call, normalized } of normalizeChatToolCalls([...toolCalls.values()], body)) {
        const outputIndex = output.length;
        const callId = call.id || `call_${crypto.randomUUID().replace(/-/gu, '')}`;
        let item;
        if (normalized.name === 'apply_patch') {
          let input = normalized.arguments;
          try { input = String(JSON.parse(input).patch || ''); } catch { /* keep raw model output */ }
          item = { type: 'custom_tool_call', id: `ctc_${crypto.randomUUID().replace(/-/gu, '')}`, call_id: callId, name: 'apply_patch', input: normalizePatchInput(input), status: 'completed' };
        } else {
          item = { type: 'function_call', id: `fc_${crypto.randomUUID().replace(/-/gu, '')}`, call_id: callId, ...originalToolCall(normalized.name, body.tools), arguments: normalized.arguments, status: 'completed' };
        }
        const pending = { ...item, status: 'in_progress', ...(item.type === 'function_call' ? { arguments: '' } : { input: '' }) };
        yield encode('response.output_item.added', { output_index: outputIndex, item: pending });
        const deltaEvent = item.type === 'function_call' ? 'response.function_call_arguments.delta' : 'response.custom_tool_call_input.delta';
        const doneEvent = item.type === 'function_call' ? 'response.function_call_arguments.done' : 'response.custom_tool_call_input.done';
        const key = item.type === 'function_call' ? 'arguments' : 'input';
        yield encode(deltaEvent, { item_id: item.id, output_index: outputIndex, delta: item[key] });
        yield encode(doneEvent, { item_id: item.id, output_index: outputIndex, [key]: item[key] });
        yield encode('response.output_item.done', { output_index: outputIndex, item });
        output.push(item);
      }
      const normalizedUsage = usage ? {
        input_tokens: Number(usage.prompt_tokens) || 0,
        input_tokens_details: { cached_tokens: Number(usage.prompt_cache_hit_tokens) || 0 },
        output_tokens: Number(usage.completion_tokens) || 0,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: Number(usage.total_tokens) || 0,
      } : null;
      yield encode('response.completed', { response: { ...responseBase, output, usage: normalizedUsage } });
    } finally {
      clearTimeout(timeout);
    }
  }
  return { status: 200, stream: Readable.from(convertedStream()) };
}

async function createDeepSeekNoReasoningBridge(targetBaseUrl) {
  const target = String(targetBaseUrl || '').replace(/\/$/u, '');
  if (!target) throw new Error('DeepSeek bridge target is required');
  const server = http.createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      let payload = Buffer.concat(chunks);
      if (request.method === 'POST' && new URL(request.url, 'http://127.0.0.1').pathname === '/responses') {
        const body = JSON.parse(payload.toString('utf8'));
        const headers = { ...request.headers };
        delete headers.host;
        delete headers['content-length'];
        delete headers.connection;
        if (body.reasoning?.effort === 'none' && body.model === 'deepseek-v4-flash') {
          const converted = await chatCompletionAsResponses({ body, headers, target });
          if (converted.stream) {
            response.writeHead(converted.status, { 'content-type': 'text/event-stream; charset=utf-8' });
            converted.stream.on('error', (error) => response.destroy(error));
            converted.stream.pipe(response);
            return;
          }
          response.writeHead(converted.status, { 'content-type': 'application/json' });
          response.end(JSON.stringify(converted.error));
          return;
        }
        payload = Buffer.from(JSON.stringify(normalizeNoReasoningRequest(body)));
      }
      const headers = { ...request.headers };
      delete headers.host;
      delete headers['content-length'];
      delete headers.connection;
      const upstream = await fetch(`${target}${request.url}`, {
        method: request.method,
        headers,
        ...(payload.length ? { body: payload } : {}),
      });
      const outgoing = {};
      for (const [key, value] of upstream.headers.entries()) {
        if (!['content-encoding', 'transfer-encoding', 'content-length', 'connection'].includes(key)) outgoing[key] = value;
      }
      response.writeHead(upstream.status, outgoing);
      if (!upstream.body) return response.end();
      Readable.fromWeb(upstream.body).pipe(response);
    } catch (error) {
      if (!response.headersSent) response.writeHead(502, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: error.message } }));
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

module.exports = { CONSISTENCY_REVIEW_OUTPUT_CAP, CONSISTENCY_REVIEW_TIMEOUT_MS, DEEPSEEK_UPSTREAM_TIMEOUT_MS, NOVEL_TOOL_NAMES, NO_REASONING_OUTPUT_CAP, chatCompletionAsResponses, createDeepSeekNoReasoningBridge, explicitResourceRefs, isConsistencyReviewRequest, isTextOnlyRequest, messageText, normalizeChatToolCall, normalizeChatToolCalls, normalizeNoReasoningRequest, normalizePatchInput, originalToolCall, originalToolName, responseSse, responsesInputToChatMessages, responsesToolsToChatTools, upstreamTimeoutMs };
