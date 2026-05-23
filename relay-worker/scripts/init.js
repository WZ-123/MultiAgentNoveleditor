#!/usr/bin/env node
'use strict';

/**
 * One-click init script for the Cloudflare Worker backup relay deployment.
 * Tencent Cloud SCF Web Function is the primary production path; use this only
 * to prepare the standby Cloudflare deployment.
 *
 * Usage:
 *   cd relay-worker
 *   node scripts/init.js
 *
 * Steps:
 *   1. Check prerequisites (wrangler login)
 *   2. Prompt for Feishu credentials and relay API key
 *   3. Create .dev.vars
 *   4. Deploy Worker
 *   5. Set encrypted secrets
 *   6. Print client config command
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function ask(question) {
  return new Promise((resolve) => rl.question(question, resolve));
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: opts.silent ? 'pipe' : 'inherit',
      cwd: opts.cwd || path.resolve(__dirname, '..'),
      ...opts,
    });
    let stdout = '';
    let stderr = '';
    if (opts.silent) {
      child.stdout.on('data', (d) => { stdout += d.toString(); });
      child.stderr.on('data', (d) => { stderr += d.toString(); });
    }
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(`Command failed: ${cmd} ${args.join(' ')}\n${stderr}`));
      else resolve(stdout);
    });
  });
}

async function checkWrangler() {
  console.log('Checking wrangler...');
  try {
    await run('npx', ['wrangler', '--version'], { silent: true });
  } catch {
    console.log('Wrangler not found. Installing...');
    await run('npm', ['install', 'wrangler']);
  }

  console.log('Checking wrangler login status...');
  try {
    await run('npx', ['wrangler', 'whoami'], { silent: true });
  } catch {
    console.log('\nYou need to login to Cloudflare first.');
    console.log('Running: npx wrangler login');
    await run('npx', ['wrangler', 'login']);
  }
}

async function promptConfig() {
  console.log('\n=== Feishu Configuration ===');
  console.log('Get these from https://open.feishu.cn/app → your app → Credentials\n');

  const appId = await ask('Feishu App ID (cli_xxx): ');
  const appSecret = await ask('Feishu App Secret: ');
  const appToken = await ask('Feishu App Token (base_xxx): ');
  const tableId = await ask('Feishu Feedback Table ID (tbl_xxx): ');
  const authTableId = await ask('Feishu Auth Table ID (tbl_xxx): ');

  console.log('\n=== Relay Security ===');
  const relayApiKey = await ask('Relay API Key (for client auth): ') || `relay-${Date.now().toString(36)}`;

  return { appId, appSecret, appToken, tableId, authTableId, relayApiKey };
}

async function createDevVars(cfg) {
  const devVarsPath = path.resolve(__dirname, '..', '.dev.vars');
  const content = [
    `FEISHU_APP_ID=${cfg.appId}`,
    `FEISHU_APP_SECRET=${cfg.appSecret}`,
    `FEISHU_APP_TOKEN=${cfg.appToken}`,
    `FEISHU_TABLE_ID=${cfg.tableId}`,
    `FEISHU_AUTH_TABLE_ID=${cfg.authTableId}`,
    `RELAY_API_KEY=${cfg.relayApiKey}`,
  ].join('\n') + '\n';

  fs.writeFileSync(devVarsPath, content);
  console.log('\nCreated .dev.vars for local development');
}

async function deployWorker() {
  console.log('\n=== Deploying Worker ===');
  await run('npx', ['wrangler', 'deploy']);
}

async function setSecrets(cfg) {
  console.log('\n=== Setting Encrypted Secrets ===');

  const secrets = [
    { name: 'FEISHU_APP_ID', value: cfg.appId },
    { name: 'FEISHU_APP_SECRET', value: cfg.appSecret },
    { name: 'FEISHU_APP_TOKEN', value: cfg.appToken },
    { name: 'FEISHU_TABLE_ID', value: cfg.tableId },
    { name: 'FEISHU_AUTH_TABLE_ID', value: cfg.authTableId },
    { name: 'RELAY_API_KEY', value: cfg.relayApiKey },
  ];

  for (const secret of secrets) {
    console.log(`Setting ${secret.name}...`);
    const child = spawn('npx', ['wrangler', 'secret', 'put', secret.name], {
      cwd: path.resolve(__dirname, '..'),
      stdio: ['pipe', 'inherit', 'inherit'],
    });
    child.stdin.write(secret.value + '\n');
    child.stdin.end();
    await new Promise((resolve, reject) => {
      child.on('close', (code) => {
        if (code !== 0) reject(new Error(`Failed to set secret ${secret.name}`));
        else resolve();
      });
    });
  }
}

async function getWorkerUrl() {
  console.log('\n=== Getting Worker URL ===');
  try {
    const output = await run('npx', ['wrangler', 'deploy', '--dry-run'], { silent: true });
    // Try to extract URL from output
    const match = output.match(/(https?:\/\/[^\s]+\.workers\.dev)/);
    if (match) return match[1];
  } catch {
    // dry-run may not always output URL, fall through
  }

  // Fallback: read from wrangler.toml or ask user
  console.log('\nCould not auto-detect Worker URL.');
  const url = await ask('Worker URL (e.g. https://feedback-relay.xxx.workers.dev): ');
  return url;
}

function printSummary(cfg, workerUrl) {
  console.log('\n========================================');
  console.log('  Relay Worker Deployed Successfully');
  console.log('========================================');
  console.log(`\nWorker URL: ${workerUrl}`);
  console.log(`Health Check: ${workerUrl}/api/v1/health`);
  console.log('\n--- Client Configuration ---');
  console.log(`\nRun this on the client machine:`);
  console.log(`\n  node scripts/feishu-debug.js --action=configure \\\n    --relayUrl=${workerUrl} \\\n    --relayApiKey=${cfg.relayApiKey} \\\n    --enabled=true`);
  console.log('\n--- Environment Variables (for CI/CD) ---');
  console.log(`\n  CLOUDFLARE_API_TOKEN=xxx  (GitHub Secret)`);
  console.log(`  CLOUDFLARE_ACCOUNT_ID=xxx (GitHub Secret)`);
  console.log('\n--- Local Development ---');
  console.log(`\n  cd relay-worker`);
  console.log(`  npx wrangler dev        # Start local server`);
  console.log(`  node scripts/test-relay.js  # Run tests`);
  console.log('\n========================================');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

(async () => {
  try {
    await checkWrangler();
    const cfg = await promptConfig();
    await createDevVars(cfg);
    await deployWorker();
    await setSecrets(cfg);
    const workerUrl = await getWorkerUrl();
    printSummary(cfg, workerUrl);
    process.exit(0);
  } catch (err) {
    console.error('\n[ERROR]', err.message);
    process.exit(1);
  } finally {
    rl.close();
  }
})();
