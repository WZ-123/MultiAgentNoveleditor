#!/usr/bin/env node
'use strict';

/**
 * Cross-platform `npm run start` wrapper.
 * Replaces: concurrently "vite" "unset ELECTRON_RUN_AS_NODE && electron . --no-sandbox"
 *
 * On Windows, `unset` does not exist and `$()` shell substitution fails.
 * This script starts both processes using Node child_process directly.
 */

const { spawn } = require('node:child_process');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const DEV_HOST = '127.0.0.1';
const FIRST_DEV_PORT = 5173;
const MAX_PORT_ATTEMPTS = 100;
const RENDERER_DEV_URL_ENV = 'MANA_RENDERER_DEV_URL';

function canListen(port, host = DEV_HOST) {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.once('error', (error) => {
      if (error?.code === 'EADDRINUSE' || error?.code === 'EACCES') {
        resolve(false);
        return;
      }
      reject(error);
    });
    probe.listen({ host, port, exclusive: true }, () => {
      probe.close(() => resolve(true));
    });
  });
}

async function findAvailablePort(startPort = FIRST_DEV_PORT) {
  for (let offset = 0; offset < MAX_PORT_ATTEMPTS; offset += 1) {
    const port = startPort + offset;
    if (await canListen(port)) return port;
  }
  throw new Error(`No available editor dev port in ${startPort}-${startPort + MAX_PORT_ATTEMPTS - 1}`);
}

function waitForHttp(origin, child, timeoutMs = 15000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      if (child.exitCode !== null) {
        reject(new Error(`Vite exited before the editor was ready (code ${child.exitCode})`));
        return;
      }
      const req = http.get(origin, (res) => {
        res.resume();
        if ((res.statusCode || 500) < 500) {
          resolve();
          return;
        }
        scheduleNext();
      });
      req.setTimeout(500, () => req.destroy());
      req.on('error', scheduleNext);
    };
    const scheduleNext = () => {
      if (Date.now() - startedAt >= timeoutMs) {
        reject(new Error(`Timed out waiting for editor dev server at ${origin}`));
        return;
      }
      setTimeout(attempt, 100);
    };
    attempt();
  });
}

async function main() {
  const port = await findAvailablePort();
  const rendererDevOrigin = `http://${DEV_HOST}:${port}`;
  console.log(`[dev-start] editor renderer: ${rendererDevOrigin}`);

  const viteProc = spawn(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['vite', '--host', DEV_HOST, '--port', String(port), '--strictPort'],
    { cwd: ROOT, stdio: 'inherit' }
  );

  let electronProc = null;
  let shuttingDown = false;
  const shutdown = (code = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (electronProc && electronProc.exitCode === null) electronProc.kill();
    if (viteProc.exitCode === null) viteProc.kill();
    process.exit(code);
  };

  viteProc.on('exit', (code) => {
    if (!shuttingDown) shutdown(code ?? 1);
  });
  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));

  await waitForHttp(rendererDevOrigin, viteProc);

  const electronEnv = {
    ...process.env,
    NODE_ENV: 'development',
    [RENDERER_DEV_URL_ENV]: rendererDevOrigin,
  };
  delete electronEnv.ELECTRON_RUN_AS_NODE;

  electronProc = spawn(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['electron', '.', '--no-sandbox'],
    { cwd: ROOT, stdio: 'inherit', env: electronEnv }
  );

  electronProc.on('exit', (code) => shutdown(code ?? 0));
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[dev-start] startup failed:', error?.stack || error);
    process.exit(1);
  });
}

module.exports = {
  canListen,
  findAvailablePort,
  waitForHttp,
};
