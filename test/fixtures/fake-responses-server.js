'use strict';

const http = require('node:http');
const crypto = require('node:crypto');

function id(prefix) { return `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`; }
function responseShape(responseId, model, status, output, usage) {
  return {
    id: responseId, object: 'response', created_at: Math.floor(Date.now() / 1000), status,
    error: null, incomplete_details: null, instructions: null, max_output_tokens: null,
    model, output, parallel_tool_calls: true, previous_response_id: null,
    reasoning: { effort: null, summary: null }, store: false, temperature: 1,
    text: { format: { type: 'text' } }, tool_choice: 'auto', tools: [], top_p: 1,
    truncation: 'disabled', usage: usage || null, user: null, metadata: {},
  };
}
function completedEvents({ model, text }) {
  const responseId = id('resp');
  const message = { id: id('msg'), type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', annotations: [], text }] };
  const response = responseShape(responseId, model, 'completed', [message], { input_tokens: 12, output_tokens: 5, total_tokens: 17, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } });
  return [
    { type: 'response.created', response: responseShape(responseId, model, 'in_progress', []) },
    { type: 'response.output_item.added', output_index: 0, item: { ...message, status: 'in_progress', content: [] } },
    { type: 'response.content_part.added', item_id: message.id, output_index: 0, content_index: 0, part: { type: 'output_text', annotations: [], text: '' } },
    { type: 'response.output_text.delta', item_id: message.id, output_index: 0, content_index: 0, delta: text, logprobs: [] },
    { type: 'response.output_text.done', item_id: message.id, output_index: 0, content_index: 0, text, logprobs: [] },
    { type: 'response.content_part.done', item_id: message.id, output_index: 0, content_index: 0, part: message.content[0] },
    { type: 'response.output_item.done', output_index: 0, item: message },
    { type: 'response.completed', response },
  ];
}
function toolEvents({ model, toolName, namespace, arguments: toolArguments = {} }) {
  const responseId = id('resp');
  const encodedArguments = JSON.stringify(toolArguments);
  const call = { id: id('fc'), type: 'function_call', status: 'completed', call_id: id('call'), name: toolName, arguments: encodedArguments };
  if (namespace) call.namespace = namespace;
  const response = responseShape(responseId, model, 'completed', [call], { input_tokens: 10, output_tokens: 4, total_tokens: 14, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } });
  return [
    { type: 'response.created', response: responseShape(responseId, model, 'in_progress', []) },
    { type: 'response.output_item.added', output_index: 0, item: call },
    { type: 'response.function_call_arguments.delta', item_id: call.id, output_index: 0, delta: encodedArguments },
    { type: 'response.function_call_arguments.done', item_id: call.id, output_index: 0, arguments: encodedArguments },
    { type: 'response.output_item.done', output_index: 0, item: call },
    { type: 'response.completed', response },
  ];
}
function customToolEvents({ model, toolName, input }) {
  const responseId = id('resp');
  const call = { id: id('ctc'), type: 'custom_tool_call', status: 'completed', call_id: id('call'), name: toolName, input: String(input || '') };
  const response = responseShape(responseId, model, 'completed', [call], { input_tokens: 10, output_tokens: 4, total_tokens: 14, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } });
  return [
    { type: 'response.created', response: responseShape(responseId, model, 'in_progress', []) },
    { type: 'response.output_item.added', output_index: 0, item: call },
    { type: 'response.custom_tool_call_input.delta', item_id: call.id, output_index: 0, delta: call.input },
    { type: 'response.custom_tool_call_input.done', item_id: call.id, output_index: 0, input: call.input },
    { type: 'response.output_item.done', output_index: 0, item: call },
    { type: 'response.completed', response },
  ];
}
function encodeSse(event) { return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`; }
async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
function hasToolOutput(input) {
  const values = Array.isArray(input) ? input : [];
  return values.some((item) => ['function_call_output', 'custom_tool_call_output'].includes(item?.type));
}
function requestInputText(input, maxLength = 200_000) {
  const values = Array.isArray(input) ? input : [];
  const parts = [];
  let length = 0;
  const append = (value) => {
    if (length >= maxLength || value == null) return;
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    const clipped = text.slice(0, maxLength - length);
    parts.push(clipped);
    length += clipped.length;
  };
  const ordered = [
    ...values.filter((item) => ['function_call_output', 'custom_tool_call_output'].includes(item?.type)),
    ...values.filter((item) => !['function_call_output', 'custom_tool_call_output'].includes(item?.type)),
  ];
  for (const item of ordered) {
    if (!item || typeof item !== 'object') continue;
    append(item.type);
    append(item.name);
    append(item.arguments);
    if (['function_call_output', 'custom_tool_call_output'].includes(item.type)) append(item.output);
    if (item.type === 'message') append(item.content);
  }
  return parts.join('\n');
}
async function createFakeResponsesServer(options = {}) {
  const requests = [];
  const modelRequests = [];
  const server = http.createServer(async (request, response) => {
    if (request.method === 'GET' && ['/models', '/v1/models'].includes(request.url)) {
      modelRequests.push({ url: request.url, headers: { authorization: request.headers.authorization || '', xApiKey: request.headers['x-api-key'] || '', apiKey: request.headers['api-key'] || '' } });
      response.writeHead(options.modelsStatus || 200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      return response.end(JSON.stringify(options.modelsPayload || { data: options.models || [] }));
    }
    if (request.method !== 'POST' || new URL(request.url, 'http://fixture.local').pathname !== '/responses') return response.writeHead(404).end();
    try {
      const body = await readJson(request);
      requests.push({ body, url: request.url, headers: { authorization: request.headers.authorization || '', xApiKey: request.headers['x-api-key'] || '', apiKey: request.headers['api-key'] || '' } });
      const selected = typeof options.respond === 'function' ? await options.respond(body, requests) : null;
      const events = selected?.customToolName
        ? customToolEvents({ model: body.model, toolName: selected.customToolName, input: selected.input })
        : selected?.toolName
          ? toolEvents({ model: body.model, toolName: selected.toolName, namespace: selected.namespace, arguments: selected.arguments })
        : options.toolName && !hasToolOutput(body.input)
          ? toolEvents({ model: body.model, toolName: options.toolName, namespace: options.namespace })
          : completedEvents({ model: body.model, text: selected?.text || options.text || 'FAKE_RESPONSES_OK' });
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
      for (const event of events) {
        if (response.destroyed) break;
        response.write(encodeSse(event));
        if (event.type === 'response.output_text.delta' && selected?.delayAfterDeltaMs) await new Promise(resolve => setTimeout(resolve, selected.delayAfterDeltaMs));
      }
      response.end('data: [DONE]\n\n');
    } catch (error) {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: error.message } }));
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  return { origin: `http://127.0.0.1:${server.address().port}`, requests, modelRequests, close: () => new Promise((resolve) => server.close(resolve)) };
}

module.exports = { completedEvents, createFakeResponsesServer, customToolEvents, readJson, requestInputText, toolEvents };
