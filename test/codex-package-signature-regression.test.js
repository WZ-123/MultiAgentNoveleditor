'use strict';

const assert = require('node:assert/strict');
const { assessMacSignature } = require('../scripts/verify-packaged-codex-runtime');
const { assessDeepSignature } = require('../scripts/verify-release-package');

function info({ ok = true, teamId = '', authority = '' } = {}) {
  return { ok, teamId, authority, output: `TeamIdentifier=${teamId}` };
}

function run() {
  const local = assessMacSignature(
    info({ teamId: 'not set' }),
    info({ teamId: '2DC432GLL2', authority: 'OpenAI release signature' }),
    false
  );
  assert.equal(local.signed, false, 'an unsigned local app must be reported, not misrepresented as release-signed');
  assert.equal(local.appTeamId, null);
  assert.equal(local.sidecarTeamId, '2DC432GLL2');
  assert.equal(assessDeepSignature(1, false), false, 'unsigned local package verification must continue without claiming a release signature');
  assert.throws(() => assessDeepSignature(1, true), /deep code signature/u, 'release verification must still fail closed on an invalid deep signature');

  assert.throws(() => assessMacSignature(
    info({ teamId: 'MANA_TEAM' }),
    info({ teamId: '2DC432GLL2' }),
    true
  ), /different signing identities/u, 'Release CI must fail if the nested sidecar keeps a different Team ID');

  const release = assessMacSignature(
    info({ teamId: 'MANA_TEAM', authority: 'Developer ID Application' }),
    info({ teamId: 'MANA_TEAM', authority: 'Developer ID Application' }),
    true
  );
  assert.equal(release.signed, true);
  assert.equal(release.teamId, 'MANA_TEAM');
  console.log('TEST_PASS codex-package-signature-regression');
}

if (require.main === module) run();

module.exports = { run };
