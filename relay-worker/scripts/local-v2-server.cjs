'use strict';

const http = require('node:http');
const { main_handler: handleScfEvent } = require('../src/scf-entry.cjs');
const { UPLOAD_BODY_LIMIT } = require('../src/relay-core.cjs');

const HOST = '127.0.0.1';
const PORT = Math.max(1, Math.min(65535, Number(process.env.PORT) || 8787));
const TRANSPORT_LIMIT = UPLOAD_BODY_LIMIT + 64 * 1024;

const server = http.createServer((request, response) => {
  const chunks = [];
  let size = 0;
  let rejected = false;
  request.on('data', (chunk) => {
    if (rejected) return;
    size += chunk.length;
    if (size > TRANSPORT_LIMIT) {
      rejected = true;
      response.writeHead(413, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify({ ok: false, code: 'request_too_large' }));
      return;
    }
    chunks.push(chunk);
  });
  request.on('end', async () => {
    if (rejected) return;
    try {
      const body = Buffer.concat(chunks);
      const result = await handleScfEvent({
        httpMethod: request.method,
        path: new URL(request.url || '/', `http://${HOST}:${PORT}`).pathname,
        headers: request.headers,
        body: body.toString('base64'),
        isBase64Encoded: true,
        requestContext: { sourceIp: request.socket.remoteAddress || 'unknown' },
      }, {});
      response.writeHead(result.statusCode, result.headers || {});
      response.end(result.body || '');
    } catch {
      response.writeHead(500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify({ ok: false, code: 'internal_error' }));
    }
  });
});

server.listen(PORT, HOST, () => process.stdout.write(`[relay-v2] listening on http://${HOST}:${PORT}\n`));
process.on('SIGINT', () => server.close(() => process.exit(0)));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
