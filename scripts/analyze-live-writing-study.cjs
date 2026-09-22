'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(process.argv[2] || 'artifacts/deepseek-max-100k-2026-09-05');
const rows = file => fs.existsSync(path.join(root, file)) ? fs.readFileSync(path.join(root, file), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
const wire = rows('wire.jsonl'), events = rows('ui-events.jsonl'), results = rows('commands-results.jsonl');
const ends = new Map(wire.filter(x => ['terminal', 'end'].includes(x.type)).map(x => [x.id, x]));
const requests = wire.filter(x => x.type === 'request');
const turnCommands = new Map(events.filter(event => event.turnId && event.commandId).map(event => [event.turnId, event.commandId]));
const patchFailures = [];
const sessionsRoot = path.join(root, 'user-data/codex-home/sessions');
for (const file of (fs.existsSync(sessionsRoot) ? fs.readdirSync(sessionsRoot, { recursive: true }) : []).filter(file => file.endsWith('.jsonl'))) {
  let turnId = '';
  for (const line of fs.readFileSync(path.join(sessionsRoot, file), 'utf8').trim().split('\n').filter(Boolean)) {
    const row = JSON.parse(line);
    if (row.type === 'turn_context' || row.payload?.type === 'task_started') turnId = row.payload.turn_id || turnId;
    if (row.payload?.type === 'custom_tool_call_output' && /apply_patch verification failed|Failed to find expected lines/u.test(row.payload.output || '')) {
      patchFailures.push({ at: row.timestamp, commandId: turnCommands.get(turnId), error: row.payload.output.slice(0, 800) });
    }
  }
}
const sumUsage = list => list.reduce((out, request) => {
  const value = ends.get(request.id)?.usage;
  if (!value) { out.requestsWithoutUsage++; return out; }
  out.input += value.input_tokens || 0;
  out.cached += value.input_tokens_details?.cached_tokens || 0;
  out.output += value.output_tokens || 0;
  out.reasoning += value.output_tokens_details?.reasoning_tokens || 0;
  out.total += value.total_tokens || 0;
  return out;
}, { input: 0, cached: 0, output: 0, reasoning: 0, total: 0, requestsWithoutUsage: 0 });
const cjk = value => (value.match(/[\u3400-\u9fff]/gu) || []).length;
const chapterDir = path.join(root, 'novel/chapters');
const duplicates = new Map();
const chapters = (fs.existsSync(chapterDir) ? fs.readdirSync(chapterDir) : []).filter(x => x.endsWith('.md')).sort().map(file => {
  const raw = fs.readFileSync(path.join(chapterDir, file), 'utf8');
  const content = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/u, '');
  const body = content.split('\n').filter(line => !/^\s*#{1,6}\s/u.test(line) && !/^时间\s*[/／]\s*雨情\s*[：:]/u.test(line)).join('\n');
  for (const paragraph of body.split(/\n\s*\n/u).map(x => x.replace(/\s/gu, '')).filter(x => cjk(x) >= 60)) {
    const hash = crypto.createHash('sha256').update(paragraph).digest('hex');
    duplicates.set(hash, [...(duplicates.get(hash) || []), { file, cjk: cjk(paragraph) }]);
  }
  return { file, title: content.match(/^#\s+(.+)/mu)?.[1] || file, fullCjk: cjk(raw), bodyCjk: cjk(body), sha256: crypto.createHash('sha256').update(raw).digest('hex') };
});
const tasks = results.filter(row => row.action === 'turn').map(row => {
  const localEvents = events.filter(event => event.commandId === row.id);
  const items = localEvents.filter(event => event.type === 'item_completed');
  const tools = items.filter(event => event.item?.type === 'mcpToolCall');
  const patches = items.filter(event => event.item?.type === 'fileChange');
  const reads = tools.filter(event => event.item.tool === 'read_novel_resource').map(event => event.item.arguments?.resourceRef);
  const uniqueReads = [...new Set(reads)];
  return { id: row.id, phase: row.phase || 'baseline', status: row.result?.status, durationMs: row.result?.durationMs,
    error: row.error || row.result?.error || '', cjkGrowth: (row.result?.after?.totalCjk || 0) - (row.result?.before?.totalCjk || 0),
    usage: sumUsage(requests.filter(request => request.commandId === row.id)),
    toolCount: tools.length, toolFailures: tools.filter(event => event.item.status === 'failed').length,
    patchVerificationFailures: patchFailures.filter(failure => failure.commandId === row.id).length,
    readCount: reads.length, uniqueReads, repeatedReadCount: reads.length - uniqueReads.length,
    nativeCompletedPatches: patches.filter(event => event.item.status === 'completed').length,
    emptyDiffConfirmations: patches.filter(event => event.item.status === 'completed' && event.item.changes?.length && event.item.changes.every(change => change.kind?.type === 'update' && !change.diff)).length,
    afterFirstPatchMs: patches.length ? Math.max(0, Date.parse(row.timestamp) - Date.parse(patches[0].timestamp)) : null,
  };
});
const report = { generatedAt: new Date().toISOString(),
  modelEfforts: [...new Set(requests.map(x => `${x.model}:${x.reasoning?.effort}`))],
  phases: [...new Set(requests.map(x => x.phase || 'baseline'))].map(phase => ({ phase, requests: requests.filter(x => (x.phase || 'baseline') === phase).length, usage: sumUsage(requests.filter(x => (x.phase || 'baseline') === phase)), tasks: tasks.filter(x => x.phase === phase).length })),
  chapters, fullCjk: chapters.reduce((sum, x) => sum + x.fullCjk, 0), bodyCjk: chapters.reduce((sum, x) => sum + x.bodyCjk, 0),
  repeatedLongParagraphs: [...duplicates.values()].filter(list => list.length > 1), patchFailures, tasks,
};
fs.writeFileSync(path.join(root, 'analysis-metrics.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ bodyCjk: report.bodyCjk, chapters: chapters.length, repeatedLongParagraphGroups: report.repeatedLongParagraphs.length, recentTasks: tasks.slice(-3).map(({ usage, uniqueReads, ...task }) => ({ ...task, tokens: usage.total })) }, null, 2));
