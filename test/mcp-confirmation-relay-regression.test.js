'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const net = require('node:net');
const path = require('node:path');

async function waitFor(predicate, timeoutMs = 2000) {
  const start = Date.now();
  while ((Date.now() - start) < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timed out waiting for condition');
}

async function runMcpConfirmationRelayRegressionTest() {
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
  process.env.MANA_USER_DATA_ROOT = path.join(ROOT, 'tmp-test-mcp-confirmation-relay-userdata');
  process.env.MANA_USE_STDIO_MCP = '1';

  try {
    const serverManagerPath = path.join(ROOT, 'src/main/mcp/serverManager.js');
    const eventBusPath = path.join(ROOT, 'src/main/runtime/eventBus.js');

    delete require.cache[serverManagerPath];
    delete require.cache[eventBusPath];

    const serverManager = require(serverManagerPath);
    const eventBus = require(eventBusPath);
    const originalEmit = eventBus.emit;
    const emitted = [];
    eventBus.emit = async (event) => {
      emitted.push(event);
      return event;
    };

    try {
      const relay = await serverManager.ensureConfirmationRelay();
      assert.ok(relay?.port > 0, 'expected relay port');

      const responsePromise = new Promise((resolve, reject) => {
        const socket = net.createConnection({ host: '127.0.0.1', port: relay.port });
        let buffer = '';

        socket.setEncoding('utf8');
        socket.on('connect', () => {
          socket.write(JSON.stringify({
            type: 'confirm-request',
            id: 'cf-relay-1',
            name: 'write_chapter',
            arguments: { name: 'chapter-001.md' },
            runId: 'run-relay-1',
            toolUseId: 'tool-relay-1',
            subagentId: 'sa-test',
            nodeId: 'node-1',
          }) + '\n');
        });
        socket.on('data', (chunk) => {
          buffer += chunk;
          while (true) {
            const newlineIndex = buffer.indexOf('\n');
            if (newlineIndex < 0) break;
            const line = buffer.slice(0, newlineIndex).trim();
            buffer = buffer.slice(newlineIndex + 1);
            if (!line) continue;
            const msg = JSON.parse(line);
            if (msg.type === 'error') {
              reject(new Error(msg.message || 'relay error'));
              socket.destroy();
              return;
            }
            if (msg.type === 'confirm-response') {
              resolve(msg);
              socket.destroy();
              return;
            }
          }
        });
        socket.on('error', reject);
      });

      await waitFor(() => serverManager.listPendingConfirmations().some((p) => p.toolUseId === 'tool-relay-1'));
      assert.ok(
        emitted.some((event) => event.kind === 'awaiting_confirmation' && event.data?.toolUseId === 'tool-relay-1'),
        'expected awaiting_confirmation event'
      );

      const resolved = serverManager.resolveConfirmation('run-relay-1', 'tool-relay-1', {
        accept: true,
        patch: { approved: true },
        reason: 'approved by test',
      });
      assert.equal(resolved, true);

      const response = await responsePromise;
      assert.deepEqual(response, {
        type: 'confirm-response',
        id: 'cf-relay-1',
        accept: true,
        patch: { approved: true },
        reason: 'approved by test',
      });
      assert.equal(serverManager.listPendingConfirmations().length, 0);

      pass(
        'MCP1_confirmation_relay_round_trip',
        'main-process relay accepted confirm-request and returned confirm-response'
      );
    } finally {
      eventBus.emit = originalEmit;
      await serverManager.dispose();
      delete require.cache[serverManagerPath];
      delete require.cache[eventBusPath];
    }
  } catch (err) {
    fail('MCP1_confirmation_relay_round_trip', err?.message || String(err));
  }

  try {
    const driverPath = path.join(ROOT, 'src/main/runtime/drivers/claudeCodeVscode.js');
    const appConfigPath = path.join(ROOT, 'src/main/store/appConfig.js');
    const mcpClientPath = path.join(ROOT, 'src/main/mcp/mcpClientStdio.js');

    delete require.cache[driverPath];
    delete require.cache[appConfigPath];
    delete require.cache[mcpClientPath];

    const driver = require(driverPath);
    const appConfig = require(appConfigPath);
    const mcpClient = require(mcpClientPath);
    const originalLoad = appConfig.load;
    const originalSave = appConfig.save;
    const originalEnsureRelay = mcpClient.ensureConfirmationRelay;

    appConfig.load = async () => ({
      drivers: {
        [driver.id]: { binPath: process.execPath },
      },
    });
    appConfig.save = async () => {};
    mcpClient.ensureConfirmationRelay = async () => ({ port: 43123 });

    let handle = null;
    try {
      handle = await driver.prepare({
        mode: 'subagent',
        runId: 'run-relay-config',
        input: 'test',
        subagentId: 'sa-test',
        subagents: [{
          id: 'sa-test',
          name: 'sa-test',
          displayName: 'SA Test',
          systemPrompt: 'test prompt',
        }],
        novelContext: {
          novelId: 'novel-123',
          novelDir: '/tmp/novel-123',
        },
      });

      const config = JSON.parse(await fs.readFile(handle.resources.mcpConfigPath, 'utf8'));
      const serverConfig = config?.mcpServers?.['novel-tools'];
      assert.ok(serverConfig, 'expected novel-tools config');
      assert.equal(serverConfig.env.MANA_MAIN_PORT, '43123');
      assert.ok(serverConfig.args.includes('--main-port'));
      assert.ok(serverConfig.args.includes('43123'));

      pass(
        'MCP2_driver_prepare_writes_main_port_to_mcp_config',
        'driver.prepare persisted relay port into mcp-config env and args'
      );
    } finally {
      if (handle) await driver.dispose(handle);
      appConfig.load = originalLoad;
      appConfig.save = originalSave;
      mcpClient.ensureConfirmationRelay = originalEnsureRelay;
      delete require.cache[driverPath];
      delete require.cache[appConfigPath];
      delete require.cache[mcpClientPath];
    }
  } catch (err) {
    fail('MCP2_driver_prepare_writes_main_port_to_mcp_config', err?.message || String(err));
  }

  console.log('');
  console.log(`TEST_SUMMARY ${results.passed}/${results.total} passed, ${results.failed} failed`);
  console.log('TEST_DONE');
  return results;
}

module.exports = { runMcpConfirmationRelayRegressionTest };

if (require.main === module) {
  runMcpConfirmationRelayRegressionTest().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}