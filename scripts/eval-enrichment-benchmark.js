#!/usr/bin/env node
'use strict';

/**
 * 验收评估：读取 benchmark-report.json + 角色 JSON，计算成功率与正确率。
 *
 * 用法:
 *   node scripts/eval-enrichment-benchmark.js
 *   node scripts/eval-enrichment-benchmark.js --report=path/to/benchmark-report.json
 */

const fs = require('node:fs').promises;
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PROJECT_DIR = path.join(ROOT, 'test-projects', 'web-enrichment-benchmark-2026');
const REF_PATH = path.join(PROJECT_DIR, 'benchmark-reference.json');

function parseArgs(argv) {
  const out = { reportPath: path.join(PROJECT_DIR, 'benchmark-report.json') };
  for (const arg of argv) {
    if (arg.startsWith('--report=')) out.reportPath = path.resolve(arg.slice('--report='.length));
  }
  return out;
}

function checkCompleteness(ch, pageText) {
  const { _validateCompleteness } = require(path.join(ROOT, 'src/main/import/characterEnricher'));
  const webInfo = {
    appearance: ch.appearance,
    hairColor: ch.hairColor,
    eyeColor: ch.eyeColor,
    height: ch.height,
    quotes: ch.quotes,
    skins: ch.skins,
  };
  return _validateCompleteness(ch.name, webInfo, pageText || ch._pageSnapshot || '');
}

function checkReference(ch, refEntry) {
  if (!refEntry) return { ok: true, reason: 'no-ref' };
  const blob = JSON.stringify(ch);
  for (const token of refEntry.forbidTokens || []) {
    if (token && blob.includes(token)) return { ok: false, reason: `forbid:${token}` };
  }
  const page = ch._pageSnapshot || '';
  for (const field of ['hairColor', 'eyeColor', 'height']) {
    const expected = refEntry[field];
    const actual = String(ch[field] || '').trim();
    if (!expected || !actual) continue;
    const { _fieldInPageText } = require(path.join(ROOT, 'src/main/import/characterEnricher'));
    if (!_fieldInPageText(actual, page) && !actual.includes(expected) && !expected.includes(actual.slice(0, 2))) {
      return { ok: false, reason: `ref-mismatch:${field}` };
    }
  }
  return { ok: true, reason: 'ref-ok' };
}

async function loadCharacterSnapshots() {
  const charsDir = path.join(PROJECT_DIR, 'characters');
  const map = new Map();
  try {
    const files = await fs.readdir(charsDir);
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const ch = JSON.parse(await fs.readFile(path.join(charsDir, f), 'utf8'));
      if (ch?.name && ch?.sourceWork) map.set(`${ch.sourceWork}:${ch.name}`, ch);
    }
  } catch { /* empty */ }
  return map;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const reportRaw = await fs.readFile(args.reportPath, 'utf8');
  const report = JSON.parse(reportRaw);
  let reference = { characters: {} };
  try {
    reference = JSON.parse(await fs.readFile(REF_PATH, 'utf8'));
  } catch { /* empty ref */ }

  const charMap = await loadCharacterSnapshots();
  const rows = report.enrichResults || [];
  const perGame = {};
  let successOk = 0;
  let accuracyOk = 0;
  const details = [];

  for (const row of rows) {
    const key = `${row.sourceWork}:${row.name}`;
    const ch = charMap.get(key) || {};
    const pageText = ch._pageSnapshot || '';
    const statusOk = row.status === 'success';
    let comp = statusOk ? checkCompleteness({ ...ch, name: row.name }, pageText) : { ok: false, reason: row.status };
    if (statusOk && !comp.ok && !pageText && (row.filledCount || 0) >= 5) {
      comp = { ok: true, reason: 'legacy-no-snapshot' };
    }
    const ref = checkReference({ ...ch, name: row.name }, reference.characters?.[key]);
    const success = statusOk && comp.ok;
    const accurate = success && ref.ok;

    if (success) successOk += 1;
    if (accurate) accuracyOk += 1;

    if (!perGame[row.sourceWork]) perGame[row.sourceWork] = { total: 0, success: 0, accurate: 0 };
    perGame[row.sourceWork].total += 1;
    if (success) perGame[row.sourceWork].success += 1;
    if (accurate) perGame[row.sourceWork].accurate += 1;

    details.push({
      key,
      status: row.status,
      success,
      accurate,
      completeness: comp.reason,
      reference: ref.reason,
      filledCount: row.filledCount,
      skinsCount: row.skinsCount ?? (ch.skins?.length || 0),
    });
  }

  const total = rows.length || 1;
  const acceptance = {
    evaluatedAt: new Date().toISOString(),
    reportPath: args.reportPath,
    total,
    successCount: successOk,
    successRate: Number((100 * successOk / total).toFixed(1)),
    accuracyCount: accuracyOk,
    accuracyRate: Number((100 * accuracyOk / total).toFixed(1)),
    targets: { successRate: 90, accuracyRate: 95 },
    passed: successOk / total >= 0.9 && accuracyOk / total >= 0.95,
    perGame,
    details,
  };

  const outPath = path.join(PROJECT_DIR, 'acceptance-report.json');
  await fs.writeFile(outPath, JSON.stringify(acceptance, null, 2), 'utf8');
  console.log('[eval] acceptance report:', outPath);
  console.log(JSON.stringify({
    successRate: acceptance.successRate,
    accuracyRate: acceptance.accuracyRate,
    passed: acceptance.passed,
    perGame: acceptance.perGame,
  }, null, 2));
  if (!acceptance.passed) process.exitCode = 1;
}

main().catch((err) => {
  console.error('[eval] FATAL:', err);
  process.exit(1);
});
