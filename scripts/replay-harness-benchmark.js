#!/usr/bin/env node
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { evaluateReport } = require('./harness-benchmark-lib');

async function main() {
  const reportArg = process.argv.find((arg) => arg.startsWith('--report='));
  if (!reportArg) throw new Error('usage: node scripts/replay-harness-benchmark.js --report=...');
  const reportPath = path.resolve(reportArg.slice('--report='.length));
  const report = JSON.parse(await fs.readFile(reportPath, 'utf8'));
  const replay = {
    corpusVersion: report.corpusVersion,
    benchmarkPolicyVersion: report.benchmarkPolicyVersion || '',
    promptSignature: report.promptSignature || '',
    modelIds: report.provider?.models || [],
    replayedAt: new Date().toISOString(),
    acceptance: evaluateReport(report),
  };
  const out = reportPath.replace(/\.json$/u, '.replay.json');
  await fs.writeFile(out, JSON.stringify(replay, null, 2), 'utf8');
  console.log(JSON.stringify(replay, null, 2));
  if (!replay.acceptance.passed) process.exitCode = 1;
}

main().catch((err) => { console.error(err?.stack || err); process.exit(1); });
