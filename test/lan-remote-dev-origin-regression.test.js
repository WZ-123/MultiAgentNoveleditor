'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const {
  RENDERER_DEV_URL_ENV,
  getRendererDevOrigin,
  normalizeRendererDevOrigin,
} = require('../src/main/lan/rendererDevOrigin');
const { findAvailablePort } = require('../scripts/dev-start');
const remoteServer = require('../src/main/lan/remoteServer');

function listen(server, port = 0) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server.address().port);
    });
  });
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

function source(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

async function authenticate(origin, accessCode) {
  const response = await fetch(`${origin}/api/lan/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code: accessCode }),
    redirect: 'manual',
  });
  assert.equal(response.status, 302, 'valid LAN access code should create a session');
  const setCookie = response.headers.get('set-cookie') || '';
  const cookie = setCookie.split(';')[0];
  assert.match(cookie, /^mana_lan_token=/u, 'LAN auth should return its session cookie');
  return cookie;
}

function testOriginValidation() {
  assert.equal(normalizeRendererDevOrigin(''), null);
  assert.equal(normalizeRendererDevOrigin('http://127.0.0.1:5174/'), 'http://127.0.0.1:5174');
  assert.equal(normalizeRendererDevOrigin('http://localhost:5175'), 'http://localhost:5175');
  assert.equal(
    getRendererDevOrigin({ [RENDERER_DEV_URL_ENV]: 'http://127.0.0.1:5199' }),
    'http://127.0.0.1:5199'
  );
  assert.throws(() => normalizeRendererDevOrigin('https://127.0.0.1:5173'), /must use http/u);
  assert.throws(() => normalizeRendererDevOrigin('http://example.com:5173'), /loopback host/u);
  assert.throws(() => normalizeRendererDevOrigin('http://127.0.0.1:5173/editor'), /only an origin/u);
}

async function testOccupiedPortSelection() {
  const blocker = http.createServer((_req, res) => res.end('foreign-project'));
  const occupiedPort = await listen(blocker);
  try {
    const selectedPort = await findAvailablePort(occupiedPort);
    assert.notEqual(selectedPort, occupiedPort, 'editor launcher must not reuse another project port');
  } finally {
    await close(blocker);
  }
}

async function testLanProxyUsesOnlyConfiguredEditor() {
  const previousOrigin = process.env[RENDERER_DEV_URL_ENV];
  const editorMarker = 'MANA_NOVEL_EDITOR_RENDERER_TEST';
  const editor = http.createServer((req, res) => {
    if (req.url === '/editor-asset.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
      res.end(`window.__rendererMarker = '${editorMarker}';`);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html><head><title>${editorMarker}</title></head><body>${editorMarker}</body></html>`);
  });

  try {
    const editorPort = await listen(editor);
    process.env[RENDERER_DEV_URL_ENV] = `http://127.0.0.1:${editorPort}`;

    const lanPort = await findAvailablePort(18788);
    const status = await remoteServer.start({ port: lanPort });
    const lanOrigin = `http://127.0.0.1:${lanPort}`;
    const cookie = await authenticate(lanOrigin, status.accessCode);

    const pageResponse = await fetch(`${lanOrigin}/`, { headers: { Cookie: cookie } });
    assert.equal(pageResponse.status, 200);
    const page = await pageResponse.text();
    assert.match(page, new RegExp(editorMarker, 'u'), 'LAN root must render the configured novel editor');
    assert.match(page, /__mana_remote_bridge\.js/u, 'LAN bridge must still be injected into editor HTML');

    const assetResponse = await fetch(`${lanOrigin}/editor-asset.js`, { headers: { Cookie: cookie } });
    assert.equal(assetResponse.status, 200);
    assert.match(await assetResponse.text(), new RegExp(editorMarker, 'u'));

    delete process.env[RENDERER_DEV_URL_ENV];
    const packagedResponse = await fetch(`${lanOrigin}/`, { headers: { Cookie: cookie } });
    assert.equal(packagedResponse.status, 200, 'without an explicit dev origin LAN should serve the packaged editor');
    assert.doesNotMatch(
      await packagedResponse.text(),
      new RegExp(editorMarker, 'u'),
      'LAN must not retain or discover an unrelated dev server'
    );
  } finally {
    await remoteServer.stop();
    if (editor.listening) await close(editor);
    if (previousOrigin === undefined) delete process.env[RENDERER_DEV_URL_ENV];
    else process.env[RENDERER_DEV_URL_ENV] = previousOrigin;
  }
}

function testNoBlindPortScanningContract() {
  const remoteSource = source('src/main/lan/remoteServer.js');
  const mainSource = source('main.js');
  const launcherSource = source('scripts/dev-start.js');

  assert.doesNotMatch(remoteSource, /DEV_PORTS|findDevOrigin/u);
  assert.doesNotMatch(mainSource, /candidatePorts/u);
  assert.match(remoteSource, /getRendererDevOrigin\(\)/u);
  assert.match(mainSource, /getRendererDevOrigin\(\)/u);
  assert.match(launcherSource, /MANA_RENDERER_DEV_URL/u);
  assert.match(launcherSource, /--strictPort/u);
}

async function run() {
  testOriginValidation();
  testNoBlindPortScanningContract();
  if (!process.argv.includes('--contract-only')) {
    await testOccupiedPortSelection();
    await testLanProxyUsesOnlyConfiguredEditor();
  }
  console.log('TEST_PASS lan-remote-dev-origin-regression');
}

run().catch((error) => {
  console.error('TEST_FAIL lan-remote-dev-origin-regression', error?.stack || error);
  process.exitCode = 1;
});
