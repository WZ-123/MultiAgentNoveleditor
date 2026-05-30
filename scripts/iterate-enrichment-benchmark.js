#!/usr/bin/env node
'use strict';

/**
 * 改→测→评循环（最多 N 轮），直至 acceptance 达标或轮次用尽。
 *
 * 用法:
 *   node scripts/iterate-enrichment-benchmark.js --max-rounds=5 --concurrency=3
 */

const { spawn } = require('node:child_process');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const out = { maxRounds: 5, concurrency: 3, onlyWork: null };
  for (const arg of argv) {
    if (arg.startsWith('--max-rounds=')) out.maxRounds = Math.max(1, Number(arg.split('=')[1]) || 5);
    if (arg.startsWith('--concurrency=')) out.concurrency = Math.max(1, Number(arg.split('=')[1]) || 3);
    if (arg.startsWith('--only-work=')) out.onlyWork = arg.slice('--only-work='.length);
  }
  return out;
}

function runNode(script, extraArgs = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'scripts', script), ...extraArgs], {
      cwd: ROOT,
      stdio: 'inherit',
      env: process.env,
    });
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${script} exited ${code}`));
    });
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const runArgs = [`--concurrency=${args.concurrency}`];
  if (args.onlyWork) runArgs.push(`--only-work=${args.onlyWork}`);

  for (let round = 1; round <= args.maxRounds; round++) {
    console.log(`\n[iterate] === round ${round}/${args.maxRounds} ===`);
    await runNode('run-enrichment-benchmark.js', runArgs);
    try {
      await runNode('eval-enrichment-benchmark.js');
      console.log('[iterate] acceptance PASSED');
      return;
    } catch {
      console.log('[iterate] acceptance not met, continue if rounds remain');
    }
  }
  console.error('[iterate] max rounds reached without passing acceptance');
  process.exitCode = 1;
}

main().catch((err) => {
  console.error('[iterate] FATAL:', err);
  process.exit(1);
});
