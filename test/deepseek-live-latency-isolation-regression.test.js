'use strict';

const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { prepareIsolatedUserRoot, responseUsage, writeCaptureReceipt } = require('../scripts/run-deepseek-live-latency-ui-e2e');

async function run() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'mana-latency-isolation-'));
  const source = path.join(root, 'provider-user-data');
  const target = path.join(root, 'latency-user-data');
  try {
    await fsp.mkdir(source, { recursive: true });
    await fsp.writeFile(path.join(source, 'model-config.json'), JSON.stringify({ activeSelection: { connectionId: 'production' } }));
    await fsp.writeFile(path.join(source, 'secrets.json'), JSON.stringify({ records: { api: 'kept' } }));
    await prepareIsolatedUserRoot(source, target);
    await fsp.writeFile(path.join(target, 'model-config.json'), JSON.stringify({ activeSelection: { connectionId: 'wire-capture' } }));
    assert.equal(JSON.parse(await fsp.readFile(path.join(source, 'model-config.json'), 'utf8')).activeSelection.connectionId, 'production');
    assert.equal(JSON.parse(await fsp.readFile(path.join(target, 'secrets.json'), 'utf8')).records.api, 'kept');
    await assert.rejects(() => prepareIsolatedUserRoot(source, source), /must not mutate/);
    assert.deepEqual(responseUsage(Buffer.from('event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":120,"output_tokens":30,"total_tokens":150}}}\n\ndata: [DONE]\n')), { input_tokens: 120, output_tokens: 30, total_tokens: 150 });
    const receipt = path.join(root, 'capture.json');
    await writeCaptureReceipt(receipt, [{ status: 200, usage: { total_tokens: 150 } }]);
    assert.equal(JSON.parse(await fsp.readFile(receipt, 'utf8')).captures[0].usage.total_tokens, 150);
    console.log('deepseek-live-latency-isolation-regression: ok');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
