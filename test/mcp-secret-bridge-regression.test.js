'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function runMcpSecretBridgeRegressionTest() {
  const ROOT = path.resolve(__dirname, '..');
  const userRoot = path.join(ROOT, 'tmp-test-mcp-secret-bridge-userdata');
  const serverManagerPath = path.join(ROOT, 'src/main/mcp/serverManager.js');
  const secretsPath = path.join(ROOT, 'src/main/store/secrets.js');
  const results = { total: 0, passed: 0, failed: 0 };
  const pass = (name, detail) => {
    results.total += 1;
    results.passed += 1;
    console.log(`TEST_PASS ${name}: ${detail}`);
  };
  const fail = (name, error) => {
    results.total += 1;
    results.failed += 1;
    console.log(`TEST_FAIL ${name}: ${error?.message || String(error)}`);
  };

  let serverManager;
  let originalGetSecretStatus;
  const oldUserRoot = process.env.MANA_USER_DATA_ROOT;
  const oldStdio = process.env.MANA_USE_STDIO_MCP;

  try {
    let hostSecretRequests = 0;

    await fs.rm(userRoot, { recursive: true, force: true });
    await fs.mkdir(userRoot, { recursive: true });
    await fs.writeFile(path.join(userRoot, 'model-config.json'), JSON.stringify({
      schemaVersion: 3,
      revision: 1,
      providers: [{
        id: 'bridge-provider', name: 'Bridge Provider', adapterId: 'openai-chat-completions', baseUrl: 'http://127.0.0.1:1/v1', endpoints: {},
        auth: { mode: 'bearer', secretRef: 'provider:bridge-provider:api-key', headerName: 'Authorization' },
        models: [{ id: 'bridge-model', name: 'Bridge Model', capabilities: { contextWindow: 128000, maxOutputTokens: 4096, supportsThinking: false, supportsTools: true, supportsStreaming: true, supportsStructuredOutput: true } }],
      }],
      profiles: [{
        id: 'profile-bridge', name: 'Bridge Profile', description: '', workloadTags: ['editing'], priority: 'balanced',
        targetsByDriver: { 'direct-api': { primary: { id: 'target-bridge', providerId: 'bridge-provider', modelId: 'bridge-model', params: { contextLimit: 128000, maxOutputTokens: 512, temperature: 0.7, thinking: false } }, fallbacks: [] } },
      }],
      routing: { defaultProfileId: 'profile-bridge', systemAssignments: {}, subagentAssignments: { 'sa-de-ai-ifier': 'profile-bridge' }, legacyTierProfileMap: {} },
      migration: { source: 'test', migratedAt: new Date().toISOString(), warnings: [] },
    }, null, 2));
    // Deliberately unreadable in Electron-as-Node. The host must service the
    // request via private IPC without putting the key in an env var or file.
    await fs.writeFile(path.join(userRoot, 'secrets.json'), JSON.stringify({
      records: { 'provider:bridge-provider:api-key': { plain: false, value: 'unreadable-from-child' } },
    }));

    process.env.MANA_USER_DATA_ROOT = userRoot;
    process.env.MANA_USE_STDIO_MCP = '1';
    delete require.cache[require.resolve(serverManagerPath)];
    const secrets = require(secretsPath);
    originalGetSecretStatus = secrets.getSecretStatus;
    secrets.getSecretStatus = async (secretRef) => {
      assert.equal(secretRef, 'provider:bridge-provider:api-key');
      hostSecretRequests += 1;
      return { value: 'bridge-only-test-key', present: true, readable: true, issue: null };
    };
    serverManager = require(serverManagerPath);

    const result = await serverManager.callTool({
      name: 'de_ai_ify',
      arguments: { text: '然后她笑了。那是一个很淡的笑。' },
    });
    assert.equal(result.isError, true, 'the deliberately unreachable test Provider should fail after credential resolution');
    assert.ok(hostSecretRequests >= 1, 'expected the MCP child to request the encrypted provider credential from its host');
    assert.doesNotMatch(result.content[0].text, /尚未配置 API Key|无法从系统安全存储读取/u);
    pass('MCP_SECRET_1_child_uses_private_host_secret_bridge', 'de_ai_ify passes the encrypted-key boundary and reaches the Provider request without writing a key to child storage');
  } catch (error) {
    fail('MCP_SECRET_1_child_uses_private_host_secret_bridge', error);
  } finally {
    if (serverManager) await serverManager.dispose();
    if (originalGetSecretStatus) require(secretsPath).getSecretStatus = originalGetSecretStatus;
    await fs.rm(userRoot, { recursive: true, force: true });
    if (oldUserRoot == null) delete process.env.MANA_USER_DATA_ROOT;
    else process.env.MANA_USER_DATA_ROOT = oldUserRoot;
    if (oldStdio == null) delete process.env.MANA_USE_STDIO_MCP;
    else process.env.MANA_USE_STDIO_MCP = oldStdio;
    delete require.cache[require.resolve(serverManagerPath)];
  }

  console.log(`TEST_SUMMARY ${results.passed}/${results.total} passed, ${results.failed} failed`);
  console.log('TEST_DONE');
  return results;
}

module.exports = { runMcpSecretBridgeRegressionTest };

if (require.main === module) {
  runMcpSecretBridgeRegressionTest().then((results) => {
    if (results.failed) process.exitCode = 1;
  });
}
