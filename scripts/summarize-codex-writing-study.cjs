'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve('artifacts/codex-luna-medium-100k-2026-09-05');
const rows = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
const outputText = value => typeof value === 'string' ? value : Array.isArray(value) ? value.map(x => x.text || '').join('\n') : JSON.stringify(value || '');
const events = rows(path.join(root, 'ui-events.jsonl'));
const turnMap = new Map(events.filter(x => x.turnId).map(x => [x.turnId, x.commandId]));
const native = [];
const sessions = path.join(root, 'user-data/codex-home/sessions');
for (const file of fs.existsSync(sessions) ? fs.readdirSync(sessions, { recursive: true }).filter(x => x.endsWith('.jsonl')) : []) {
  let turn = '';
  for (const row of rows(path.join(sessions, file))) {
    if (row.type === 'turn_context' || row.payload?.type === 'task_started') turn = row.payload.turn_id || turn;
    native.push({ ...row, commandId: turnMap.get(turn) });
  }
}
const cjk = text => (text.match(/[\u3400-\u9fff]/gu) || []).length;
const chapters = fs.readdirSync(path.join(root, 'novel/chapters')).filter(x => x.endsWith('.md')).sort().map(file => {
  const raw = fs.readFileSync(path.join(root, 'novel/chapters', file), 'utf8');
  const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/u, '').split('\n').filter(line => !/^\s*#{1,6}\s/u.test(line) && !/^时间\s*[/／]\s*雨情\s*[：:]/u.test(line)).join('\n');
  return { file, bodyCjk: cjk(body) };
});
const tasks = rows(path.join(root, 'commands-results.jsonl')).filter(x => x.action === 'turn').map(row => {
  const local = native.filter(x => x.commandId === row.id);
  const usage = local.filter(x => x.payload?.type === 'token_count').reduce((sum, x) => {
    const u = x.payload.info?.last_token_usage || {};
    for (const key of ['input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_output_tokens', 'total_tokens']) sum[key] = (sum[key] || 0) + (u[key] || 0);
    return sum;
  }, {});
  return { id: row.id, status: row.result?.status, durationMs: row.result?.durationMs, error: row.error || row.result?.error || '',
    cjkGrowth: (row.result?.after?.totalCjk || 0) - (row.result?.before?.totalCjk || 0),
    confirmations: row.result?.confirmations?.length || 0, usage,
    toolErrors: local.filter(x => /tool_call_output|function_call_output/.test(x.payload?.type || '') && /failed to|verification failed|not found|unsupported|"isError":true/i.test(outputText(x.payload.output))).map(x => outputText(x.payload.output).slice(0, 500)),
    reply: row.result?.reply || '',
  };
});
const report = { generatedAt: new Date().toISOString(), mode: 'codex-login-real-model', model: 'gpt-5.6-luna', effort: 'medium', initialBodyCjk: 35136,
  bodyCjk: chapters.reduce((sum, x) => sum + x.bodyCjk, 0), chapters, tasks,
  current: JSON.parse(fs.readFileSync(path.join(root, 'status.json'), 'utf8')).current };
fs.writeFileSync(path.join(root, 'progress.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ bodyCjk: report.bodyCjk, chapters: chapters.length, current: report.current, recent: tasks.slice(-2).map(({reply, ...x}) => ({...x, reply: reply.slice(-200)})) }, null, 2));
