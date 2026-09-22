const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'maintenance-scripts.json');
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const [scriptName, ...rawArgs] = process.argv.slice(2);
const args = rawArgs[0] === '--' ? rawArgs.slice(1) : rawArgs;

if (!scriptName || !config.scripts?.[scriptName]) {
  console.error('用法: node scripts/run-maintenance-script.js <脚本名> [-- 参数]');
  console.error('可用脚本:');
  for (const name of Object.keys(config.scripts || {})) console.error(`  ${name}`);
  process.exitCode = 1;
} else {
  const shellQuote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
  const command = [config.scripts[scriptName], ...args.map(shellQuote)].join(' ');
  const result = spawnSync(command, {
    cwd: ROOT,
    env: process.env,
    shell: true,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
