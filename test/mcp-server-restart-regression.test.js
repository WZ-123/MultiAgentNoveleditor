'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function runMcpServerRestartRegressionTest() {
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
  const serverManagerPath = path.join(ROOT, 'src/main/mcp/serverManager.js');
  const providerManagerPath = path.join(ROOT, 'src/main/providerManager');
  const userRoot = path.join(ROOT, 'tmp-test-mcp-server-restart-userdata');
  const providersFile = path.join(userRoot, 'providers.json');

  process.env.MANA_USER_DATA_ROOT = userRoot;
  process.env.MANA_USE_STDIO_MCP = '1';

  function clearModule(modulePath) {
    try {
      delete require.cache[require.resolve(modulePath)];
    } catch {
      // ignore cache misses
    }
  }

  async function disposeServerManager() {
    try {
      const serverManager = require(serverManagerPath);
      await serverManager.dispose();
    } catch {
      // ignore cleanup failures in regression test
    } finally {
      clearModule(serverManagerPath);
    }
  }

  async function seedProviders(activeProviderId = 'anthropic') {
    await fs.rm(userRoot, { recursive: true, force: true });
    await fs.mkdir(userRoot, { recursive: true });
    await fs.writeFile(providersFile, JSON.stringify({
      schemaVersion: 2,
      providers: [
        {
          id: 'anthropic',
          name: 'Anthropic',
          type: 'anthropic',
          baseUrl: '',
          apiKey: '',
          isBuiltin: true,
          models: [{ id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', contextWindow: 200000 }],
        },
        {
          id: 'deepseek-v4-pro',
          name: 'DeepSeek V4 Pro',
          type: 'anthropic',
          baseUrl: 'https://api.deepseek.com/anthropic',
          apiKey: 'sk-test',
          isBuiltin: false,
          models: [{ id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', contextWindow: 200000 }],
        },
      ],
      activeProviderId,
    }, null, 2), 'utf8');
  }

  try {
    await seedProviders();
    process.env.MANA_TEST_MCP_SERVER_TOKEN = 'token-a';
    clearModule(providerManagerPath);
    clearModule(serverManagerPath);
    const serverManager = require(serverManagerPath);

    try {
      const toolsA = await serverManager.listTools();
      const pidA = serverManager._debugGetChildPid();
      const tokenA = serverManager._debugGetChildServerToken();

      assert.ok(Array.isArray(toolsA) && toolsA.length > 0, 'expected MCP tools from first child');
      assert.ok(pidA, 'expected first MCP child pid');
      assert.equal(tokenA, 'forced:token-a');

      process.env.MANA_TEST_MCP_SERVER_TOKEN = 'token-b';
      const toolsB = await serverManager.listTools();
      const pidB = serverManager._debugGetChildPid();
      const tokenB = serverManager._debugGetChildServerToken();

      assert.ok(Array.isArray(toolsB) && toolsB.length > 0, 'expected MCP tools from restarted child');
      assert.ok(pidB, 'expected restarted MCP child pid');
      assert.notEqual(pidA, pidB, 'expected child restart after token change');
      assert.equal(tokenB, 'forced:token-b');

      pass(
        'MCPR1_server_manager_restarts_child_when_server_token_changes',
        'stdio MCP child is recycled when the parent detects a newer server token'
      );
    } finally {
      delete process.env.MANA_TEST_MCP_SERVER_TOKEN;
      await disposeServerManager();
      clearModule(providerManagerPath);
    }
  } catch (err) {
    fail('MCPR1_server_manager_restarts_child_when_server_token_changes', err?.message || String(err));
  }

  try {
    await seedProviders('anthropic');
    process.env.MANA_TEST_MCP_SERVER_TOKEN = 'token-provider';
    clearModule(providerManagerPath);
    clearModule(serverManagerPath);
    const serverManager = require(serverManagerPath);
    const providerManager = require(providerManagerPath);

    try {
      const toolsA = await serverManager.listTools();
      const pidA = serverManager._debugGetChildPid();
      const serverTokenA = serverManager._debugGetChildServerToken();
      const providerTokenA = serverManager._debugGetChildProviderToken();

      assert.ok(Array.isArray(toolsA) && toolsA.length > 0, 'expected MCP tools from first provider-backed child');
      assert.ok(pidA, 'expected first provider-backed MCP child pid');
      assert.equal(serverTokenA, 'forced:token-provider');
      assert.ok(providerTokenA && providerTokenA.startsWith('providers:'), 'expected provider token from first child');

      await providerManager.use('DeepSeek V4 Pro');
      const expectedProviderTokenB = providerManager.getProviderStateTokenSync();
      const toolsB = await serverManager.listTools();
      const pidB = serverManager._debugGetChildPid();
      const serverTokenB = serverManager._debugGetChildServerToken();
      const providerTokenB = serverManager._debugGetChildProviderToken();

      assert.ok(Array.isArray(toolsB) && toolsB.length > 0, 'expected MCP tools from restarted provider-backed child');
      assert.ok(pidB, 'expected restarted provider-backed MCP child pid');
      assert.notEqual(pidA, pidB, 'expected child restart after provider config change');
      assert.equal(serverTokenB, 'forced:token-provider');
      assert.equal(providerTokenB, expectedProviderTokenB);
      assert.notEqual(providerTokenA, providerTokenB, 'expected provider token to change after provider switch');

      pass(
        'MCPR2_server_manager_restarts_child_when_provider_config_changes',
        'switching the active provider recycles the stdio MCP child so tool state follows the new config'
      );
    } finally {
      delete process.env.MANA_TEST_MCP_SERVER_TOKEN;
      await disposeServerManager();
      clearModule(providerManagerPath);
    }
  } catch (err) {
    fail('MCPR2_server_manager_restarts_child_when_provider_config_changes', err?.message || String(err));
  }

  try {
    await fs.rm(userRoot, { recursive: true, force: true });
  } catch {
    // ignore cleanup failures
  }

  console.log('');
  console.log(`TEST_SUMMARY ${results.passed}/${results.total} passed, ${results.failed} failed`);
  console.log('TEST_DONE');
  return results;
}

module.exports = { runMcpServerRestartRegressionTest };

if (require.main === module) {
  runMcpServerRestartRegressionTest().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
