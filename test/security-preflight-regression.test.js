'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseArgs: parseSecurityArgs, scanArtifact, scanText } = require('../scripts/security-preflight');
const { REMOVED_PATHS, filterArguments } = require('../scripts/clean-git-history-mirror');

function run() {
  const providerKey = `sk-${'a1'.repeat(16)}`;
  const findings = scanText(`const credential = "${providerKey}";`, 'fixture.js');
  assert.equal(findings.length, 1);
  assert.deepEqual(Object.keys(findings[0]).sort(), ['line', 'location', 'rule']);
  assert.equal(JSON.stringify(findings).includes(providerKey), false, 'reports must never contain a matched secret value');
  assert.equal(scanText('const credential = "sk-test-placeholder-value";', 'safe.js').length, 0);
  assert.equal(scanText("value.indexOf('-----BEGIN PRIVATE KEY-----') === 0", 'jose-format-check.js').length, 0, 'a PEM format marker without payload is library code, not a leaked key');
  const privateKey = `-----BEGIN PRIVATE KEY-----\n${'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo='.repeat(2)}\n-----END PRIVATE KEY-----`;
  const privateKeyFindings = scanText(privateKey, 'leaked-key.pem');
  assert.equal(privateKeyFindings.length, 1, 'an actual PEM payload must remain blocked');
  assert.equal(privateKeyFindings[0].rule, 'private-key');
  assert.equal(JSON.stringify(privateKeyFindings).includes('QUJDREV'), false, 'PEM payload must not enter reports');
  assert(REMOVED_PATHS.includes('.mana-data/app-config.json'));
  assert.equal(parseSecurityArgs(['--history', '--repo', '/private/tmp/mirror.git']).repo, '/private/tmp/mirror.git');
  const filterArgs = filterArguments('/private/tmp/redactions.txt');
  assert(filterArgs.includes('--invert-paths'));
  assert(filterArgs.includes('--replace-text'));

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mana-security-artifact-'));
  try {
    fs.mkdirSync(path.join(root, 'test'), { recursive: true });
    fs.writeFileSync(path.join(root, 'test', 'fault-injection.js'), 'module.exports = true;');
    fs.writeFileSync(path.join(root, 'main.js'), `export const token = "${providerKey}";`);
    const result = scanArtifact(root);
    assert(result.findings.some((item) => item.rule === 'forbidden-artifact-path'));
    assert(result.findings.some((item) => item.rule === 'provider-api-key'));
    assert.equal(JSON.stringify(result).includes(providerKey), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log('TEST_PASS security-preflight-regression');
}

if (require.main === module) run();

module.exports = { run };
