#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const MAX_TEXT_FILE_BYTES = 64 * 1024 * 1024;
const FORBIDDEN_REPOSITORY_PATHS = new Set([
  '.dev.vars',
  'relay-worker/.dev.vars',
  '.mana-data/app-config.json',
  '.claude/settings.json',
]);
const FORBIDDEN_ARTIFACT_SEGMENTS = [
  '/.dev.vars',
  '/.mana-data/',
  '/test/',
  '/tests/',
  '/qa-screenshots/',
  '/knowledge-base/',
  '/scripts/',
  '/fault-injection/',
];

function secretRules() {
  return [
    { id: 'provider-api-key', pattern: /\bsk-[A-Za-z0-9]{24,}\b/gu },
    { id: 'github-token', pattern: /\b(?:github_pat_[A-Za-z0-9_]{40,}|gh[pousr]_[A-Za-z0-9]{30,})\b/gu },
    // A PEM format marker is part of normal crypto/JWT library source. Treat
    // it as a secret only when an actual base64 payload and matching footer
    // are present; otherwise packaged dependencies such as `jose` can never
    // pass the release scanner.
    { id: 'private-key', pattern: /-----BEGIN ((?:RSA |EC |OPENSSH )?PRIVATE KEY)-----\r?\n[A-Za-z0-9+/=\r\n]{32,}-----END \1-----/gu },
    { id: 'credential-url', pattern: /https?:\/\/[^/@\s]{12,}@(?:github\.com|api\.)/gu },
    {
      id: 'quoted-secret-assignment',
      pattern: /(?:FEISHU_APP_SECRET|DEEPSEEK_API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY|RELEASE_RELAY_API_KEY|BETA_RELAY_API_KEY|RELAY_SIGNING_PRIVATE_JWK)\s*[:=]\s*["']([^"']{12,})["']/gu,
      capture: 1,
    },
    {
      id: 'dotenv-secret-assignment',
      pattern: /^(?:FEISHU_APP_SECRET|DEEPSEEK_API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY|RELEASE_RELAY_API_KEY|BETA_RELAY_API_KEY|RELAY_SIGNING_PRIVATE_JWK)=([^\s#]{12,})/gmu,
      capture: 1,
    },
    {
      id: 'sensitive-json-value',
      pattern: /"(?:apiKey|relayApiKey|authCode|appSecret|accessToken|offlineLease|privateKey)"\s*:\s*"([^"]{12,})"/gu,
      capture: 1,
    },
  ];
}

function looksLikePlaceholder(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return true;
  return /(?:fake|test|example|placeholder|replace[-_ ]?me|dummy|redacted|your[-_]|xxxx|<[^>]+>)/u.test(normalized)
    || /^([a-z0-9])\1{15,}$/u.test(normalized);
}

function lineNumber(text, offset) {
  let line = 1;
  for (let index = 0; index < offset; index += 1) if (text.charCodeAt(index) === 10) line += 1;
  return line;
}

function scanText(text, location) {
  const findings = [];
  for (const rule of secretRules()) {
    rule.pattern.lastIndex = 0;
    for (const match of text.matchAll(rule.pattern)) {
      const candidate = rule.capture ? match[rule.capture] : match[0];
      if (looksLikePlaceholder(candidate)) continue;
      findings.push({ rule: rule.id, location, line: lineNumber(text, match.index || 0) });
    }
  }
  return findings;
}

function normalizeLocation(value) {
  return String(value || '').replaceAll('\\', '/').replace(/^\.\//u, '');
}

function artifactPathFinding(relativePath) {
  const normalized = `/${normalizeLocation(relativePath).toLowerCase()}`;
  return FORBIDDEN_ARTIFACT_SEGMENTS.some((segment) => normalized.startsWith(segment))
    || /(?:^|\/)\.dev\.vars(?:$|\.)/u.test(normalized)
    || /^\/(?:test|tests)[-_].*\.(?:c?js|mjs)$/u.test(normalized);
}

function scanAsar(asarPath, displayPath) {
  const asar = require('@electron/asar');
  const findings = [];
  for (const entry of asar.listPackage(asarPath)) {
    const name = normalizeLocation(entry).replace(/^\//u, '');
    const location = `${displayPath}!/${name}`;
    if (artifactPathFinding(name)) findings.push({ rule: 'forbidden-artifact-path', location, line: 0 });
    let content;
    try { content = asar.extractFile(asarPath, name); }
    catch { continue; }
    if (!Buffer.isBuffer(content) || content.length > MAX_TEXT_FILE_BYTES || content.includes(0)) continue;
    findings.push(...scanText(content.toString('utf8'), location));
  }
  return findings;
}

function scanFile(file, displayPath, options = {}) {
  const findings = [];
  if (options.artifact && artifactPathFinding(displayPath)) {
    findings.push({ rule: 'forbidden-artifact-path', location: displayPath, line: 0 });
  }
  if (file.endsWith('.asar')) {
    try { findings.push(...scanAsar(file, displayPath)); }
    catch { findings.push({ rule: 'unreadable-asar', location: displayPath, line: 0 }); }
    return findings;
  }
  let stat;
  try { stat = fs.lstatSync(file); } catch { return findings; }
  if (!stat.isFile() || stat.size > MAX_TEXT_FILE_BYTES) return findings;
  const content = fs.readFileSync(file);
  if (content.includes(0)) return findings;
  findings.push(...scanText(content.toString('utf8'), displayPath));
  return findings;
}

function walk(root) {
  const output = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) output.push(absolute);
    }
  };
  const stat = fs.lstatSync(root);
  if (stat.isDirectory()) visit(root); else output.push(root);
  return output;
}

function git(repo, args, options = {}) {
  const result = spawnSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0 && !options.allowNoMatch) {
    throw new Error(`git ${args[0]} failed without exposing command output`);
  }
  return result;
}

function currentFiles(repo) {
  const result = git(repo, ['ls-files', '-co', '--exclude-standard', '-z']);
  return result.stdout.split('\0').filter(Boolean).map(normalizeLocation);
}

function scanCurrent(repo = ROOT) {
  const findings = [];
  const tracked = new Set(git(repo, ['ls-files', '-z']).stdout.split('\0').filter(Boolean).map(normalizeLocation));
  for (const forbidden of FORBIDDEN_REPOSITORY_PATHS) {
    if (tracked.has(forbidden) && fs.existsSync(path.join(repo, forbidden))) {
      findings.push({ rule: 'forbidden-tracked-secret-container', location: forbidden, line: 0 });
    }
  }
  const files = currentFiles(repo);
  for (const relative of files) findings.push(...scanFile(path.join(repo, relative), relative));
  return { scope: 'current', scannedFiles: files.length, findings };
}

const HISTORY_PATTERNS = [
  ['provider-api-key', 'sk-[A-Za-z0-9]{24,}'],
  ['github-token', '(github_pat_[A-Za-z0-9_]{40,}|gh[pousr]_[A-Za-z0-9]{30,})'],
  ['private-key', '-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----'],
  ['credential-url', 'https?://[^/@[:space:]]{12,}@github\\.com'],
  ['quoted-secret-assignment', "(FEISHU_APP_SECRET|DEEPSEEK_API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY|RELEASE_RELAY_API_KEY|BETA_RELAY_API_KEY)[[:space:]]*[:=][[:space:]]*[\"'][^\"']{12,}[\"']"],
  ['dotenv-secret-assignment', "^(FEISHU_APP_SECRET|DEEPSEEK_API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY|RELEASE_RELAY_API_KEY|BETA_RELAY_API_KEY)=[^[:space:]#]{12,}"],
];

function scanHistory(repo = ROOT) {
  const findings = [];
  const commits = git(repo, ['rev-list', '--all']).stdout.split(/\r?\n/u).filter(Boolean);
  const chunks = [];
  for (let index = 0; index < commits.length; index += 48) chunks.push(commits.slice(index, index + 48));
  for (const [rule, pattern] of HISTORY_PATTERNS) {
    for (const chunk of chunks) {
      const result = git(repo, ['grep', '-I', '-l', '-E', '-e', pattern, ...chunk, '--', '.'], { allowNoMatch: true });
      if (![0, 1].includes(result.status)) throw new Error('history secret scan failed without exposing content');
      for (const revisionLocation of result.stdout.split(/\r?\n/u).filter(Boolean)) {
        const separator = revisionLocation.indexOf(':');
        const location = separator >= 0 ? revisionLocation.slice(separator + 1) : revisionLocation;
        findings.push({ rule, location: normalizeLocation(location), line: 0, occurrences: 1 });
      }
    }
  }
  for (const forbidden of FORBIDDEN_REPOSITORY_PATHS) {
    const result = git(repo, ['log', '--all', '--format=', '--name-only', '--', forbidden]);
    if (result.stdout.trim()) findings.push({ rule: 'forbidden-history-path', location: forbidden, line: 0 });
  }
  const aggregated = new Map();
  for (const item of findings) {
    const key = `${item.rule}:${item.location}`;
    const current = aggregated.get(key);
    if (current) current.occurrences = Number(current.occurrences || 1) + Number(item.occurrences || 1);
    else aggregated.set(key, { ...item });
  }
  const unique = [...aggregated.values()];
  return { scope: 'history', scannedCommits: commits.length, findings: unique };
}

function scanArtifact(target) {
  const absolute = path.resolve(target);
  if (!fs.existsSync(absolute)) throw new Error('artifact path does not exist');
  const files = walk(absolute);
  const findings = [];
  for (const file of files) {
    const display = normalizeLocation(path.relative(absolute, file) || path.basename(file));
    findings.push(...scanFile(file, display, { artifact: true }));
  }
  return { scope: 'artifact', target: absolute, scannedFiles: files.length, findings };
}

function parseArgs(argv) {
  const options = { current: false, history: false, artifacts: [], report: '', repo: ROOT };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--current') options.current = true;
    else if (arg === '--history') options.history = true;
    else if (arg === '--artifact') options.artifacts.push(argv[++index]);
    else if (arg.startsWith('--artifact=')) options.artifacts.push(arg.slice('--artifact='.length));
    else if (arg === '--report') options.report = argv[++index];
    else if (arg.startsWith('--report=')) options.report = arg.slice('--report='.length);
    else if (arg === '--repo') options.repo = path.resolve(argv[++index]);
    else if (arg.startsWith('--repo=')) options.repo = path.resolve(arg.slice('--repo='.length));
    else throw new Error(`unknown security-preflight option: ${arg}`);
  }
  if (!options.current && !options.history && !options.artifacts.length) options.current = true;
  return options;
}

function printResult(result) {
  const count = Number(result.scannedFiles ?? result.scannedCommits ?? 0);
  process.stdout.write(`[security-preflight] scope=${result.scope} scanned=${count} findings=${result.findings.length}\n`);
  for (const finding of result.findings) {
    process.stdout.write(`[security-preflight] rule=${finding.rule} location=${finding.location}${finding.line ? `:${finding.line}` : ''}${finding.occurrences ? ` occurrences=${finding.occurrences}` : ''}\n`);
  }
}

function writeReport(file, results) {
  const absolute = path.resolve(file);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, `${JSON.stringify({ schemaVersion: 1, generatedAt: new Date().toISOString(), results }, null, 2)}\n`, { mode: 0o600 });
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const results = [];
  if (options.current) results.push(scanCurrent(options.repo));
  if (options.history) results.push(scanHistory(options.repo));
  for (const artifact of options.artifacts) results.push(scanArtifact(artifact));
  for (const result of results) printResult(result);
  if (options.report) writeReport(options.report, results);
  if (results.some((result) => result.findings.length)) process.exitCode = 1;
  return results;
}

if (require.main === module) main().catch((error) => {
  process.stderr.write(`[security-preflight] failed: ${error.message}\n`);
  process.exitCode = 2;
});

module.exports = {
  FORBIDDEN_ARTIFACT_SEGMENTS,
  FORBIDDEN_REPOSITORY_PATHS,
  artifactPathFinding,
  looksLikePlaceholder,
  parseArgs,
  scanArtifact,
  scanCurrent,
  scanHistory,
  scanText,
};
