'use strict';
const assert = require('node:assert/strict');
const { PassThrough, Writable } = require('node:stream');
const { EventEmitter } = require('node:events');
const Module = require('node:module');
const path = require('node:path');
const { JsonRpcClient } = require('../src/main/codex-runtime/jsonRpcClient');
const originalLoad = Module._load;
// Real manager/client; only OS spawn, isolation paths and runtime metadata are
// fixtures. This does not launch or validate the official Codex binary.
Module._load = function(request, parent, ...args) {
  if (parent?.filename.endsWith(path.join('codex-runtime', 'processManager.js'))) {
    if (request === '../store/paths') return { paths: () => ({ root: '/unused-fixture' }) };
    if (request === './runtimeManifest') return { readManifest: () => ({ runtimeVersion: 'fixture' }), targetFor: () => ({ companions: [] }) };
  }
  return originalLoad.call(this, request, parent, ...args);
};
const { CodexProcessManager } = require('../src/main/codex-runtime/processManager');
Module._load = originalLoad;
const tick = () => new Promise(resolve => setImmediate(resolve));
async function main() {
  const children = [];
  const manager = new CodexProcessManager({ binary: process.execPath, spawnImpl: () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
    children.push(child); return child;
  } });
  manager._prepareIsolation = async () => { manager.codexHome = '/fixture'; manager.runDirectory = process.cwd(); };
  const start = manager.start(); await tick();
  const firstClient = manager.client;
  let early = false;
  const concurrent = manager.start().then(client => { early = true; return client; });
  await tick(); assert.equal(early, false, 'concurrent start must wait for initialize handshake');
  children[0].stdout.write(JSON.stringify({ id: 1, result: {} }) + '\n');
  assert.equal(await start, firstClient); assert.equal(await concurrent, firstClient);
  let exits = 0; manager.on('exit', () => { exits++; });
  children[0].emit('close', 1, null);
  assert.equal(firstClient.closed, true); assert.equal(manager.client, null); assert.equal(exits, 1);
  const restart = manager.start(); await tick();
  const secondClient = manager.client;
  children[1].stdout.write(JSON.stringify({ id: 1, result: {} }) + '\n');
  assert.equal(await restart, secondClient); assert.notEqual(secondClient, firstClient);
  children[0].emit('error', new Error('late old child error'));
  assert.equal(manager.client, secondClient, 'late child events cannot invalidate replacement');
  children[1].emit('close', 1, null);

  let release;
  const readable = new PassThrough(), writable = new PassThrough(); let writes = '';
  writable.on('data', data => { writes += data; });
  const client = new JsonRpcClient({ readable, writable, requestHandler: () => new Promise(resolve => { release = resolve; }) });
  const answer = client._handleServerRequest({ id: 7, method: 'approval' });
  client.close(); release({ decision: 'cancel' }); await answer;
  assert.equal(writes, '', 'settlement after exit does not write to dead transport');
  let writeCalls = 0;
  const broken = new Writable({ write(chunk, enc, callback) { callback(); } });
  broken.write = () => { writeCalls++; throw new Error('write failed'); };
  const failed = new JsonRpcClient({ readable: new PassThrough(), writable: broken, requestHandler: async () => ({ decision: 'accept' }) });
  await failed._handleServerRequest({ id: 8, method: 'approval' });
  assert.equal(writeCalls, 1, 'transport failure never sends a duplicate RPC error answer');
  assert.equal(failed.closed, true);
  console.log('runtime-transport-recovery: ok (real manager/client, fake child streams; handshake, restart, stale exit, closed approval transport)');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
