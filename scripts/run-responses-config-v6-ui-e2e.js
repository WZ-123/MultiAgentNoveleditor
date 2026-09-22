'use strict';

const { spawn } = require('node:child_process');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { createFakeResponsesServer, requestInputText } = require('../test/fixtures/fake-responses-server');

const root = path.resolve(__dirname, '..');
const userDataRoot = path.join(root, 'tmp-test-responses-config-v6-ui');
function electronBinary() { return process.platform === 'darwin' ? path.join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron') : path.join(root, 'node_modules/electron/dist', process.platform === 'win32' ? 'electron.exe' : 'electron'); }
async function run() {
  await fsp.rm(userDataRoot, { recursive: true, force: true });
  let rejectedTextProbe = false;
  let rejectedToolProbe = false;
  const fake = await createFakeResponsesServer({
    models: [{ id: 'a-fixture-model', display_name: '写作模型 · '+ 'LongModelName'.repeat(10), context_window: 256000, reasoning_efforts: ['low', 'high'] }, ...Array.from({length:499}, (_,index)=>({ id: `model-${String(index).padStart(3,'0')}`, display_name: `写作模型 ${index}` }))],
    respond(body) {
      if (!rejectedTextProbe && requestInputText(body.input).includes('MANA_RESPONSES_OK')) {
        rejectedTextProbe = true;
        throw new Error('Fixture text verification rejected');
      }
      if (!rejectedToolProbe && requestInputText(body.input).includes('Call the connection_probe tool exactly once')) { rejectedToolProbe = true; throw new Error('Fixture novel tool verification rejected'); }
      if (Array.isArray(body.input) && body.input.some((item) => item?.type === 'function_call_output')) return { text: 'MANA_TOOLS_OK' };
      return requestInputText(body.input).includes('connection_probe') ? { namespace: 'mcp__novel_tools', toolName: 'connection_probe', arguments: {} } : { text: 'MANA_RESPONSES_OK' };
    },
  });
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(electronBinary(), ['.', '--test-responses-config-v6'], { cwd: root, env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, NODE_ENV: 'production', MANA_AUTOMATED_TEST: '1', MANA_USER_DATA_ROOT: userDataRoot, MANA_RESPONSES_UI_ORIGIN: fake.origin }, stdio: 'inherit' });
      child.once('error', reject); child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`responses config UI exited ${code}`)));
    });
    if (fake.modelRequests.length !== 1) throw new Error(`expected one confirmed model discovery request, got ${fake.modelRequests.length}`);
    if (fake.modelRequests[0].headers.authorization !== 'Bearer ui-secret') throw new Error('discovery did not use the shared credential as Bearer');
    if (fake.requests.length < 3) throw new Error(`expected Responses text and tool loop requests, got ${fake.requests.length}`);
    if (!fake.requests.some((request) => request.body?.model === 'a-fixture-model')) throw new Error('Selected model was not used for verification');
    console.log('responses-config-v6-runner: ok');
  } finally { await fake.close(); }
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
