'use strict';
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const OUT = path.resolve(process.argv.slice(2).find(value => !value.startsWith('--')) || path.join(ROOT, 'artifacts', 'deepseek-max-100k-2026-09-05'));
const rows = name => fs.existsSync(path.join(OUT, name)) ? fs.readFileSync(path.join(OUT, name), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
const wire = rows('wire.jsonl');
const requests = wire.filter(row => row.type === 'request');
const results = rows('commands-results.jsonl');
const confirmationRows = rows('ui-confirmations.jsonl');
const usage = { input: 0, cached: 0, output: 0, reasoning: 0, total: 0 };
const endById = new Map(wire.filter(row => row.type === 'end').map(row => [row.id, row]));
const termById = new Map(wire.filter(row => row.type === 'terminal').map(row => [row.id, row]));
for (const request of requests) {
  const value = (endById.get(request.id) || termById.get(request.id))?.usage;
  if (!value) continue;
  usage.input += value.input_tokens || 0;
  usage.cached += value.input_tokens_details?.cached_tokens || 0;
  usage.output += value.output_tokens || 0;
  usage.reasoning += value.output_tokens_details?.reasoning_tokens || 0;
  usage.total += value.total_tokens || 0;
}
const tasks = results.filter(row => row.action === 'turn').map(row => {
  const result = row.result || {};
  const calls = requests.filter(request => request.commandId === row.id);
  const toolEvents = (result.events || []).filter(event => event.type === 'item_completed' && /tool/iu.test(event.item?.type || ''));
  return { id: row.id, phase: row.phase || 'baseline', ok: row.ok, status: result.status, durationMs: result.durationMs, over60: result.durationMs > 60000, physicalRequests: calls.length, tokenUsage: calls.reduce((sum, call) => sum + ((endById.get(call.id) || termById.get(call.id))?.usage?.total_tokens || 0), 0), confirmations: result.confirmations?.length ?? confirmationRows.filter(event => event.commandId === row.id).length, chapterGrowth: (result.after?.totalCjk || 0) - (result.before?.totalCjk || 0), error: row.error || result.error || '', toolEvents: toolEvents.map(event => ({ type: event.item.type, tool: event.item.tool, name: event.item.name, arguments: event.item.arguments, status: event.item.status })), replyTail: result.reply?.slice(-450) };
});
const chapterDir = path.join(OUT, 'novel', 'chapters');
const chapters = {};
for (const file of fs.existsSync(chapterDir) ? fs.readdirSync(chapterDir) : []) if (file.endsWith('.md')) chapters[file] = (fs.readFileSync(path.join(chapterDir, file), 'utf8').match(/[\u3400-\u9fff]/gu) || []).length;
const status = fs.existsSync(path.join(OUT, 'status.json')) ? JSON.parse(fs.readFileSync(path.join(OUT, 'status.json'), 'utf8')) : null;
const summary = { generatedAt: new Date().toISOString(), status, physicalRequests: requests.length, pendingRequests: requests.filter(row => !endById.has(row.id) && !wire.some(event => event.id === row.id && event.type === 'error')).map(row => ({ id: row.id, commandId: row.commandId, elapsedMs: Date.now() - Date.parse(row.timestamp) })), modelEfforts: [...new Set(requests.map(row => `${row.model}:${row.reasoning?.effort}`))], usage, httpErrors: wire.filter(row => row.type === 'error' || row.type === 'http-error'), chapters, totalCjk: Object.values(chapters).reduce((a, b) => a + b, 0), tasks };
fs.writeFileSync(path.join(OUT, 'progress.json'), `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(process.argv.includes('--compact') ? {
  generatedAt: summary.generatedAt, current: status?.current, totalCjk: summary.totalCjk,
  chapters, physicalRequests: requests.length, usage, pendingRequests: summary.pendingRequests,
  errorCount: summary.httpErrors.length,
  recentTasks: tasks.slice(-3).map(({ toolEvents, ...task }) => ({ ...task, toolCount: toolEvents.length })),
  lastWire: wire.slice(-1).map(({ tools, ...event }) => event),
} : { ...summary, tasks: tasks.slice(-5) }, null, 2));
