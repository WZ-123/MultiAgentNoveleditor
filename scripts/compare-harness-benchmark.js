#!/usr/bin/env node
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { compareSummaries } = require('./harness-benchmark-lib');

async function main() {
  const candidateArg = process.argv.find((arg) => arg.startsWith('--candidate='));
  const baselineArg = process.argv.find((arg) => arg.startsWith('--baseline='));
  if (!candidateArg || !baselineArg) throw new Error('usage: node scripts/compare-harness-benchmark.js --candidate=... --baseline=...');
  const candidate = JSON.parse(await fs.readFile(path.resolve(candidateArg.slice('--candidate='.length)), 'utf8'));
  const baseline = JSON.parse(await fs.readFile(path.resolve(baselineArg.slice('--baseline='.length)), 'utf8'));
  const comparable = candidate.corpusVersion === baseline.corpusVersion
    && candidate.benchmarkPolicyVersion === baseline.benchmarkPolicyVersion
    && JSON.stringify(candidate.provider?.models || []) === JSON.stringify(baseline.provider?.models || [])
    && candidate.promptSignature === baseline.promptSignature;
  const comparison = comparable
    ? compareSummaries(candidate.acceptance?.summary || {}, baseline.acceptance?.summary || {})
    : { passed: false, comparable: false, reason: 'Corpus、Benchmark 策略、模型 ID 或 Prompt 签名不一致，不能直接比较。' };
  console.log(JSON.stringify({ comparable, comparison }, null, 2));
  if (!comparison.passed) process.exitCode = 1;
}

main().catch((err) => { console.error(err?.stack || err); process.exit(1); });
