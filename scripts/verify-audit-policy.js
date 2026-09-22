#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

function audit(cwd, omitDev) {
  const command = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const args = ['audit', '--json'];
  if (omitDev) args.push('--omit=dev');
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  let report;
  try { report = JSON.parse(result.stdout || '{}'); }
  catch { throw new Error(`npm audit did not return JSON for ${cwd}`); }
  return report;
}

function vulnerabilities(report) {
  return Object.entries(report.vulnerabilities || {}).map(([name, value]) => ({ name, severity: value.severity }));
}

function loadExceptions(file) {
  const document = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(document.schemaVersion, 1);
  assert(Array.isArray(document.exceptions));
  return new Map(document.exceptions.map((item) => {
    assert.match(String(item.package || ''), /^[a-z0-9@/_.-]+$/iu);
    assert.ok(String(item.reason || '').trim(), `${item.package} needs a reason`);
    assert.match(String(item.deadline || ''), /^\d{4}-\d{2}-\d{2}$/u);
    return [item.package, item];
  }));
}

function validateFullAudit(report, exceptions, now = new Date()) {
  const issues = vulnerabilities(report);
  const forbidden = issues.filter((item) => ['moderate', 'high', 'critical'].includes(item.severity));
  assert.deepEqual(forbidden, [], `full audit contains moderate-or-higher vulnerabilities: ${forbidden.map((item) => item.name).join(', ')}`);
  const low = issues.filter((item) => item.severity === 'low');
  for (const issue of low) {
    const exception = exceptions.get(issue.name);
    assert.ok(exception, `low vulnerability has no exception record: ${issue.name}`);
    const deadline = new Date(`${exception.deadline}T23:59:59.999Z`);
    assert.ok(deadline >= now, `low vulnerability exception expired: ${issue.name}`);
  }
  const stale = [...exceptions.keys()].filter((name) => !low.some((item) => item.name === name));
  assert.deepEqual(stale, [], `audit exception is stale: ${stale.join(', ')}`);
  return { low: low.length };
}

function verify(options = {}) {
  const exceptionFile = path.resolve(options.exceptions || path.join(ROOT, 'security', 'audit-low-exceptions.json'));
  const roots = [ROOT, path.join(ROOT, 'relay-worker')];
  const results = [];
  for (const root of roots) {
    const production = audit(root, true);
    const productionIssues = vulnerabilities(production);
    assert.deepEqual(productionIssues, [], `${path.basename(root)} production audit is not zero`);
    const full = audit(root, false);
    results.push({ root, ...validateFullAudit(full, loadExceptions(exceptionFile)) });
  }
  process.stdout.write(`VERIFY_PASS audit-policy roots=${results.length} production=zero\n`);
  return results;
}

if (require.main === module) {
  try { verify(); }
  catch (error) {
    process.stderr.write(`VERIFY_FAIL audit-policy: ${error.stack || error}\n`);
    process.exitCode = 1;
  }
}

module.exports = { audit, loadExceptions, validateFullAudit, verify, vulnerabilities };
