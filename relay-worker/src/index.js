import relayCore from './relay-core.cjs';
import feishuHandlers from './feishu-handlers.cjs';
import { createCloudflareRelayState } from './cloudflare-state.js';

const { createRelayCore } = relayCore;
const { createFeishuRelayHandlers } = feishuHandlers;

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function toWorkerResponse(result, env) {
  const headers = new Headers(result.headers || {});
  const allowedOrigin = String(env.RELAY_ALLOWED_ORIGIN || '').trim();
  if (allowedOrigin) {
    headers.set('Access-Control-Allow-Origin', allowedOrigin);
    headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, Idempotency-Key, X-Feedback-Id, X-Attachment-Sha256');
  }
  return new Response(result.status === 204 ? null : result.body, { status: result.status, headers });
}

export async function handleCloudflareRequest(request, env) {
  const url = new URL(request.url);
  const body = request.method === 'GET' || request.method === 'HEAD'
    ? new Uint8Array()
    : new Uint8Array(await request.arrayBuffer());
  const core = createRelayCore({
    env: { ...env, RELAY_STATE_STORE: createCloudflareRelayState(env.RELAY_DB) },
    handlers: createFeishuRelayHandlers(env),
  });
  const result = await core({
    method: request.method,
    path: url.pathname,
    headers: request.headers,
    body,
    contentType: request.headers.get('content-type') || '',
    remoteAddress: request.headers.get('cf-connecting-ip') || 'unknown',
  });
  return toWorkerResponse(result, env);
}

export default {
  async fetch(request, env) {
    try {
      return await handleCloudflareRequest(request, env);
    } catch {
      console.error('[worker] unhandled relay error');
      return jsonResponse({ ok: false, code: 'internal_error' }, 500);
    }
  },
};
