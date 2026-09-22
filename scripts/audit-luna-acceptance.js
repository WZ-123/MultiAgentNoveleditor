'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { bodyChineseCharacterCount, proseRepetitionEvidence } = require('../src/main/mcp/novelResources');

async function auditLunaAcceptance(artifactRoot) {
  const novelDir = path.join(artifactRoot, 'novel');
  const chapterDir = path.join(novelDir, 'chapters');
  const files = fs.existsSync(chapterDir) ? (await fsp.readdir(chapterDir)).filter((name) => name.endsWith('.md')).sort() : [];
  const chapters = await Promise.all(files.map(async (name) => {
    const content = await fsp.readFile(path.join(chapterDir, name), 'utf8');
    return { name, content, hash: crypto.createHash('sha256').update(content).digest('hex'), bodyCjk: bodyChineseCharacterCount(content) };
  }));
  const bodyCjk = chapters.reduce((sum, item) => sum + item.bodyCjk, 0);
  const repetition = proseRepetitionEvidence(chapters.map((item) => ({ resourceRef: `chapter:${item.name}`, hash: item.hash, content: item.content })));
  const ledgerFile = path.join(artifactRoot, 'user-data', 'codex-task-ledger.jsonl');
  const ledger = fs.existsSync(ledgerFile) ? (await fsp.readFile(ledgerFile, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  const finished = ledger.filter((item) => item.type === 'task_finished');
  const firstCommitMs = finished.map((item) => item.timeToFirstCommitMs).filter(Number.isFinite).sort((a, b) => a - b)[0] ?? null;
  const slowestFirstCommitMs = finished.map((item) => item.timeToFirstCommitMs).filter(Number.isFinite).sort((a, b) => b - a)[0] ?? null;
  const modelDurationMs = finished.reduce((sum, item) => sum + (Number(item.modelDurationMs) || 0), 0);
  let uiState = null;
  try { uiState = JSON.parse(await fsp.readFile(path.join(artifactRoot, 'ui-state.json'), 'utf8')); } catch {}
  const checks = {
    wordCount: { status: 'evidence_only', blocking: false, actual: bodyCjk, minimum: 50_000, maximum: 55_000, belowBy: Math.max(0, 50_000 - bodyCjk), aboveBy: Math.max(0, bodyCjk - 55_000) },
    repetition: { status: 'evidence_only', qualityConclusion: 'not_evaluated', actual: repetition.repeatedOccurrenceRatio, evidence: repetition },
    completeEnding: { status: 'unverified', reason: '模型自述不是独立审查证据' },
    interruptionRecovery: { status: finished.some((item) => item.outcome === 'interrupted' && item.taskResult?.savedResources?.length) ? 'passed' : 'unverified' },
    commitIntegrity: { status: chapters.length > 0 && chapters.every((item) => item.hash) ? 'passed' : 'failed', chapterCount: chapters.length },
    firstVisibleSave: { status: slowestFirstCommitMs != null && slowestFirstCommitMs <= 300_000 ? 'passed' : 'failed', slowestFirstCommitMs, evaluationThresholdMs: 300_000, note: '该阈值只用于性能判定，不会中断正常长推理' },
    uiState: uiState?.chapterTreeMatchesDisk === true ? { status: 'passed', ...uiState } : { status: 'unverified', ...(uiState || {}) },
    localRewrite: { status: 'unverified' },
    characterRoleplay: { status: 'unverified' },
    deAiEdit: { status: 'unverified' },
    consistencyReview: { status: 'unverified' },
  };
  const statuses = Object.values(checks).map((item) => item.status);
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    overallStatus: statuses.includes('failed') ? 'failed' : statuses.includes('unverified') ? 'unverified' : 'passed',
    checks,
    runtime: { taskCount: finished.length, modelDurationMs, firstCommitMs, slowestFirstCommitMs, usage: 'unknown' },
    manuscript: { chapterCount: chapters.length, bodyChineseCharacterCount: bodyCjk, resources: chapters.map(({ name, hash, bodyCjk: count }) => ({ name, hash, bodyChineseCharacterCount: count })) },
  };
  const reportFile = path.join(artifactRoot, 'acceptance-report.json');
  await fsp.writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  return { report, reportFile };
}

if (require.main === module) {
  const artifactRoot = path.resolve(process.argv[2] || path.join(__dirname, '..', 'artifacts', 'luna-50k-acceptance'));
  auditLunaAcceptance(artifactRoot).then(({ report, reportFile }) => {
    console.log(JSON.stringify({ reportFile, ...report }, null, 2));
    if (report.overallStatus === 'failed') process.exitCode = 1;
  }).catch((error) => { console.error(error); process.exitCode = 1; });
}

module.exports = { auditLunaAcceptance };
