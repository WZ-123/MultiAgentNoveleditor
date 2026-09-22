'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve('artifacts/codex-luna-medium-100k-2026-09-05');
const rows = file => fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const commandIds = ['luna-final-hard-consistency-review', 'luna-review-missing-coverage'];
const events = rows(path.join(root, 'ui-events.jsonl'));
const turns = new Set(events.filter(x => commandIds.includes(x.commandId)).map(x => x.turnId));
let visibleText = '';
function collect(value, depth = 0) {
  if (depth > 8) return;
  if (typeof value === 'string') {
    visibleText += '\n' + value;
    try { collect(JSON.parse(value), depth + 1); } catch {}
  } else if (Array.isArray(value)) value.forEach(x => collect(x, depth + 1));
  else if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) {
    if (['text', 'content', 'structuredContent', 'outline', 'ch01', 'ch02'].includes(key)) collect(child, depth + 1);
  }
}
const sessions = path.join(root, 'user-data/codex-home/sessions');
for (const file of fs.readdirSync(sessions, { recursive: true }).filter(x => x.endsWith('.jsonl'))) {
  let turn = '';
  for (const row of rows(path.join(sessions, file))) {
    if (row.type === 'turn_context' || row.payload?.type === 'task_started') turn = row.payload.turn_id || turn;
    if (turns.has(turn) && /tool_call_output/.test(row.payload?.type || '')) collect(row.payload.output);
  }
}
const chapters = fs.readdirSync(path.join(root, 'novel/chapters')).filter(x => x.endsWith('.md')).sort().map(file => {
  const raw = fs.readFileSync(path.join(root, 'novel/chapters', file), 'utf8');
  const text = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/u, '').trim();
  return { file, fullTextPresent: visibleText.includes(text), sha256: crypto.createHash('sha256').update(raw).digest('hex') };
});
const result = { generatedAt: new Date().toISOString(), commandIds, definition: 'Exact complete chapter text is present in model-visible tool output, including decoded JSON wrappers. Stored-only and heading-only output do not qualify. This verifies evidence availability, not comprehension.', chapters };
fs.writeFileSync(path.join(root, 'review-fulltext-coverage.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ full: chapters.filter(x => x.fullTextPresent).length, total: chapters.length, missing: chapters.filter(x => !x.fullTextPresent).map(x => x.file) }));
