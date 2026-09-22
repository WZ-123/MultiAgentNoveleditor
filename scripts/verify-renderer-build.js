#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const MAX_CHUNK_BYTES = 600 * 1024;
const MAX_ENTRY_BYTES = 400 * 1024;

function run() {
  const html = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8');
  const entry = html.match(/<script[^>]+src="\.\/(assets\/index-[^"]+\.js)"/u)?.[1];
  assert.ok(entry, 'renderer entry chunk was not found in dist/index.html');
  const assets = fs.readdirSync(path.join(DIST, 'assets')).filter((file) => file.endsWith('.js'));
  const oversized = assets.map((file) => ({ file, size: fs.statSync(path.join(DIST, 'assets', file)).size }))
    .filter((item) => item.size > MAX_CHUNK_BYTES);
  assert.deepEqual(oversized, [], `renderer chunks exceed ${MAX_CHUNK_BYTES} bytes: ${JSON.stringify(oversized)}`);
  const entrySize = fs.statSync(path.join(DIST, entry)).size;
  assert.ok(entrySize <= MAX_ENTRY_BYTES, `renderer entry is ${entrySize} bytes; limit is ${MAX_ENTRY_BYTES}`);
  const css = fs.readdirSync(path.join(DIST, 'assets')).filter((file) => file.endsWith('.css'))
    .map((file) => fs.readFileSync(path.join(DIST, 'assets', file), 'utf8')).join('\n');
  assert.equal(/:is\(\s*,?\s*\)/u.test(css), false, 'renderer CSS contains an empty :is() selector');
  assert.match(
    css,
    /@media\s*\(prefers-reduced-motion:reduce\)\{[^}]*transition-property:none/u,
    'renderer CSS lost its reduced-motion transition override',
  );
  process.stdout.write(`VERIFY_PASS renderer-build chunks=${assets.length} entryBytes=${entrySize} maxChunkBytes=${Math.max(...assets.map((file) => fs.statSync(path.join(DIST, 'assets', file)).size))}\n`);
}

if (require.main === module) {
  try { run(); } catch (error) { process.stderr.write(`VERIFY_FAIL renderer-build: ${error.message}\n`); process.exitCode = 1; }
}

module.exports = { MAX_CHUNK_BYTES, MAX_ENTRY_BYTES, run };
