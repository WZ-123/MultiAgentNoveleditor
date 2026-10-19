'use strict';
// Isolated fault injector used by positive recovery tests. Never imports user data.
const fs = require('node:fs/promises');
const path = require('node:path');
const [runId, importId, target, boundary] = process.argv.slice(2);
const original = fs.rename;
fs.rename = async (a, b, ...args) => {
  await original(a, b, ...args);
  if (boundary === 'sigkill-rename' && b === target) process.kill(process.pid, 'SIGKILL');
  if (boundary === 'rename' && b === target) process.exit(73);
  let json; try { json = JSON.parse(await fs.readFile(b, 'utf8')); } catch { return; }
  if (boundary === 'authority-decision' && json.state === 'committed' && json.entries?.some((e) => {
    try { const run = JSON.parse(Buffer.from(e.after, 'base64').toString('utf8')); return run.runId === runId && run.commitDecision?.kind === 'promotion'; } catch { return false; }
  })) process.exit(73);
  if (boundary === 'owner-intent' && json.entries?.some((e) => e.relative === path.join('.mana', 'promotion-owner.json') && e.state === 'intent')) process.exit(73);
  if (boundary === 'decision' && json.state === 'committed' && json.entries?.some((e) => {
    try { return JSON.parse(Buffer.from(e.after, 'base64').toString('utf8')).state === 'committing'; } catch { return false; }
  })) process.exit(73);
  if (boundary === 'registered' && json.state === 'committed' && json.entries?.some((e) => {
    try { return JSON.parse(Buffer.from(e.after, 'base64').toString('utf8')).novels?.some((n) => n.dir === target); } catch { return false; }
  })) process.exit(73);
  if (boundary === 'registry' && path.basename(b) === 'novels.json' && json.novels?.some((n) => n.dir === target)) process.exit(73);
  if (boundary === 'staging' && json.id === importId && json.importMeta?.status === 'promoted') process.exit(73);
  if (boundary === 'ledger' && json.importId === importId && json.state === 'committed' && json.operationId) process.exit(73);
  if (boundary === 'run' && json.runId === runId && json.state === 'completed') process.exit(73);
};
new (require('../src/main/import/importSaga').ImportSagaService)().finalize(runId).catch((error) => { console.error(error); process.exitCode = 2; });
