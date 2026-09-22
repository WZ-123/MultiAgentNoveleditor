'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const output = path.join(ROOT, '.wrangler', 'generated-release.toml');
const placeholder = process.argv.includes('--placeholder');
const databaseId = String(process.env.CLOUDFLARE_D1_DATABASE_ID || (placeholder ? '00000000-0000-4000-8000-000000000000' : '')).trim();
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(databaseId)) {
  throw new Error('CLOUDFLARE_D1_DATABASE_ID must be a valid D1 database UUID');
}
const base = fs.readFileSync(path.join(ROOT, 'wrangler.toml'), 'utf8').trimEnd()
  .replace(/^main\s*=\s*"[^"]+"$/mu, 'main = "../src/index.js"');
const generated = `${base}\n\n[[d1_databases]]\nbinding = "RELAY_DB"\ndatabase_name = "mana-relay-state"\ndatabase_id = "${databaseId}"\nmigrations_dir = "../migrations"\n`;
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, generated, { encoding: 'utf8', mode: 0o600 });
process.stdout.write(`${output}\n`);
