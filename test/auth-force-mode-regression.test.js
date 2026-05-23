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
  const electronPath = require.resolve('electron');

  const oldForceAuth = process.env.MANA_FORCE_AUTH;
  const oldNodeEnv = process.env.NODE_ENV;
  const originalElectron = require.cache[electronPath]?.exports;

  function stubElectron(isPackaged) {
    require.cache[electronPath] = {
      id: electronPath,
      filename: electronPath,
      loaded: true,
      exports: {
        app: { isPackaged },
        dialog: { showErrorBox() {} },
      },
    };
  }

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

      stubElectron(true);
      process.env.MANA_FORCE_AUTH = '1';
      delete require.cache[authVerifierPath];
      const authVerifierForce = require(authVerifierPath);
      const forcedResult = await authVerifierForce.verifyLicense({ silent: true });

      assert.equal(forcedResult.valid, false);
      assert.equal(forcedResult.reason, 'missing_relay_config');
      pass('AUTH1_force_mode_blocks_without_relay', 'force auth mode no longer bypasses missing relay config');

      delete process.env.MANA_FORCE_AUTH;
  process.env.NODE_ENV = 'development';
  stubElectron(false);
      delete require.cache[authVerifierPath];
      const authVerifierNormal = require(authVerifierPath);
      const normalResult = await authVerifierNormal.verifyLicense({ silent: true });

      assert.equal(normalResult.valid, true);
      assert.equal(normalResult.reason, 'dev_mode');
      pass('AUTH2_normal_mode_still_allows_dev_skip', 'non-force mode keeps the unpackaged dev-mode bypass');

      process.env.NODE_ENV = 'production';
      stubElectron(true);
      delete require.cache[authVerifierPath];
      const authVerifierPackaged = require(authVerifierPath);
      const packagedResult = await authVerifierPackaged.verifyLicense({ silent: true });

      assert.equal(packagedResult.valid, false);
      assert.equal(packagedResult.reason, 'missing_relay_config');
      pass('AUTH3_packaged_mode_blocks_without_relay', 'packaged app must fail closed when relay config is missing');
    } finally {
      appConfig.load = originalLoad;
      delete require.cache[authVerifierPath];
      delete require.cache[appConfigPath];
      if (originalElectron) {
        require.cache[electronPath] = {
          id: electronPath,
          filename: electronPath,
          loaded: true,
          exports: originalElectron,
        };
      } else {
        delete require.cache[electronPath];
      }
    }
  } catch (err) {
    fail('AUTH_force_mode_regression', err?.message || String(err));
  } finally {
    if (oldForceAuth === undefined) delete process.env.MANA_FORCE_AUTH;
    else process.env.MANA_FORCE_AUTH = oldForceAuth;
    if (oldNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = oldNodeEnv;
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
