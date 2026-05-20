'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');

async function runAuthForceModeRegressionTest() {
  const results = { total: 0, passed: 0, failed: 0 };

  function pass(name, detail) {
    results.total += 1;
    results.passed += 1;
    console.log(`TEST_PASS ${name}${detail ? ': ' + detail : ''}`);
  }

  function fail(name, reason) {
    results.total += 1;
    results.failed += 1;
    console.log(`TEST_FAIL ${name}: ${reason}`);
  }

  const ROOT = path.resolve(__dirname, '..');
  const authVerifierPath = path.join(ROOT, 'src/main/license/authVerifier.js');
  const appConfigPath = path.join(ROOT, 'src/main/store/appConfig.js');

  const oldForceAuth = process.env.MANA_FORCE_AUTH;

  try {
    delete require.cache[authVerifierPath];
    delete require.cache[appConfigPath];

    const appConfig = require(appConfigPath);
    const originalLoad = appConfig.load;

    try {
      appConfig.load = async () => ({
        feishuSync: {
          relayUrl: '',
          relayApiKey: '',
        },
        license: {
          authCode: '',
          verifiedUntil: '',
          deviceId: '',
        },
      });

      process.env.MANA_FORCE_AUTH = '1';
      delete require.cache[authVerifierPath];
      const authVerifierForce = require(authVerifierPath);
      const forcedResult = await authVerifierForce.verifyLicense({ silent: true });

      assert.equal(forcedResult.valid, false);
      assert.equal(forcedResult.reason, 'missing_relay_config');
      pass('AUTH1_force_mode_blocks_without_relay', 'force auth mode no longer bypasses missing relay config');

      delete process.env.MANA_FORCE_AUTH;
      delete require.cache[authVerifierPath];
      const authVerifierNormal = require(authVerifierPath);
      const normalResult = await authVerifierNormal.verifyLicense({ silent: true });

      assert.equal(normalResult.valid, true);
      assert.equal(normalResult.reason, 'no_relay_config');
      pass('AUTH2_normal_mode_still_allows_dev_skip', 'non-force mode keeps existing dev/test fallback');
    } finally {
      appConfig.load = originalLoad;
      delete require.cache[authVerifierPath];
      delete require.cache[appConfigPath];
    }
  } catch (err) {
    fail('AUTH_force_mode_regression', err?.message || String(err));
  } finally {
    if (oldForceAuth === undefined) delete process.env.MANA_FORCE_AUTH;
    else process.env.MANA_FORCE_AUTH = oldForceAuth;
  }

  console.log('');
  console.log(`TEST_SUMMARY ${results.passed}/${results.total} passed, ${results.failed} failed`);
  console.log('TEST_DONE');
  return results;
}

module.exports = { runAuthForceModeRegressionTest };

if (require.main === module) {
  runAuthForceModeRegressionTest().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
