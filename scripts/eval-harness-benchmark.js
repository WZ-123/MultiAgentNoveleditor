#!/usr/bin/env node
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { BENCHMARK_POLICY_VERSION, evaluateReport, safeJson } = require('./harness-benchmark-lib');

async function main() {
  const reportArg = process.argv.find((arg) => arg.startsWith('--report='));
  const baselineArg = process.argv.find((arg) => arg.startsWith('--baseline='));
  const acceptBaseline = process.argv.includes('--accept-baseline');
  const rebasePolicy = process.argv.includes('--rebase-policy');
  if (!reportArg) throw new Error('usage: node scripts/eval-harness-benchmark.js --report=... [--baseline=...]');
  const reportPath = path.resolve(reportArg.slice('--report='.length));
  const report = JSON.parse(await fs.readFile(reportPath, 'utf8'));
  const baseline = baselineArg ? JSON.parse(await fs.readFile(path.resolve(baselineArg.slice('--baseline='.length)), 'utf8')) : null;
  const evaluatedReport = rebasePolicy
    ? { ...report, benchmarkPolicyVersion: BENCHMARK_POLICY_VERSION, policyRebasedFrom: report.benchmarkPolicyVersion || '', policyRebasedAt: new Date().toISOString() }
    : report;
  evaluatedReport.acceptance = evaluateReport(evaluatedReport, baseline);
  const out = reportPath.replace(/\.json$/u, '.acceptance.json');
  await fs.writeFile(out, JSON.stringify(safeJson({
    schemaVersion: 2,
    reportPath: path.basename(reportPath),
    corpusVersion: evaluatedReport.corpusVersion || '',
    benchmarkPolicyVersion: evaluatedReport.benchmarkPolicyVersion || '',
    promptSignature: evaluatedReport.promptSignature || '',
    modelIds: evaluatedReport.provider?.models || [],
    policyRebasedFrom: evaluatedReport.policyRebasedFrom || '',
    acceptance: evaluatedReport.acceptance,
  }), null, 2), 'utf8');
  if (acceptBaseline) {
    if (!evaluatedReport.acceptance.passed) {
      console.log('[harness-benchmark] baseline not updated because acceptance failed');
    } else {
      const baselinePath = path.join(__dirname, '..', 'test', 'fixtures', 'chapter-harness-benchmark', `baseline-${evaluatedReport.mode}-${evaluatedReport.profile}.json`);
      await fs.writeFile(baselinePath, JSON.stringify(safeJson(evaluatedReport), null, 2), 'utf8');
      console.log(`[harness-benchmark] accepted baseline: ${baselinePath}`);
    }
  }
  console.log(JSON.stringify(evaluatedReport.acceptance, null, 2));
  console.log(`[harness-benchmark] acceptance: ${out}`);
  if (!evaluatedReport.acceptance.passed) process.exitCode = 1;
}

main().catch((err) => { console.error(err?.stack || err); process.exit(1); });
