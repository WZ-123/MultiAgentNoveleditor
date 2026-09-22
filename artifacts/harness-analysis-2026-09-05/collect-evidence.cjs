'use strict';

// Read-only analysis of existing acceptance traces; no API calls or manuscript reads.
const fs = require('node:fs');
const path = require('node:path');
const fg = require('fast-glob');
const ROOT = path.resolve(__dirname, '..', '..');
const acceptanceRoot = path.join(ROOT, 'artifacts', 'deepseek-live-acceptance');
const sessionsRoot = path.join(acceptanceRoot, 'provider-user-data', 'codex-home', 'sessions');
const referenceThreadId = '01a05926-1dd9-7de2-ade9-1346d530047c';
const windowStart = 1788202581000;
const windowEnd = 1788242502000;
const novelId = 'novel-mthng6zg-ppmxre';
const files = fg.sync('**/*.jsonl', { cwd: sessionsRoot, absolute: true });
const turns = [];
const seen = new Set();
let duplicateTurnIds = 0;

for (const file of files) {
  let active = null;
  let lineNumber = 0;
  const save = () => {
    if (!active) return;
    if (seen.has(active.id)) duplicateTurnIds += 1;
    else { seen.add(active.id); turns.push(active); }
    active = null;
  };
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    lineNumber += 1;
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    const timestamp = Date.parse(row.timestamp);
    if (timestamp < windowStart || timestamp > windowEnd) continue;
    const item = row.payload || {};
    if (row.type === 'event_msg' && item.type === 'task_started') {
      save();
      active = { id: item.turn_id, file, line: lineNumber, startedAt: timestamp, explicitNovelBinding: false, completed: false, usage: {}, tokenEvents: 0, usageEventsWithoutUsage: 0, mcpCalls: 0, unsupportedCalls: 0, reviewBatch: '', synthesis: false };
    }
    if (!active) continue;
    if (row.type === 'response_item' && item.type === 'message') {
      const text = (Array.isArray(item.content) ? item.content : []).map(part => part.text || '').join('\n');
      if (text.includes(`<novelId>${novelId}</novelId>`)) active.explicitNovelBinding = true;
    }
    if (row.type === 'event_msg' && item.type === 'user_message') {
      const text = String(item.message || '');
      const batch = text.match(/审查《雾港回声》第(\d+)至(\d+)章/u);
      if (batch) active.reviewBatch = `${batch[1]}-${batch[2]}`;
      if (text.includes('仅依据以下九份分批审查')) active.synthesis = true;
    }
    if (row.type === 'event_msg' && item.type === 'token_count') {
      active.tokenEvents += 1;
      const usage = item.info?.last_token_usage;
      if (!usage) active.usageEventsWithoutUsage += 1;
      for (const [key, value] of Object.entries(usage || {})) active.usage[key] = (active.usage[key] || 0) + (Number(value) || 0);
    }
    if (row.type === 'event_msg' && item.type === 'mcp_tool_call_end') active.mcpCalls += 1;
    if (row.type === 'response_item' && item.type === 'function_call_output' && /^unsupported call:/u.test(String(item.output))) active.unsupportedCalls += 1;
    if (row.type === 'event_msg' && item.type === 'task_complete') {
      active.completed = true;
      active.durationMs = Number(item.duration_ms) || timestamp - active.startedAt;
      save();
    }
  }
  save();
}

function summary(items) {
  const reviewBatches = {};
  for (const turn of items) if (turn.reviewBatch) reviewBatches[turn.reviewBatch] = (reviewBatches[turn.reviewBatch] || 0) + 1;
  return {
    starts: items.length,
    completed: items.filter(turn => turn.completed).length,
    startsWithoutCompletion: items.filter(turn => !turn.completed).length,
    completedOver60Seconds: items.filter(turn => turn.durationMs > 60000).length,
    maxCompletedDurationMs: Math.max(0, ...items.map(turn => turn.durationMs || 0)),
    reviewStarts: items.filter(turn => turn.reviewBatch).length,
    synthesisStarts: items.filter(turn => turn.synthesis).length,
    reviewBatches,
    unsupportedCalls: items.reduce((sum, turn) => sum + turn.unsupportedCalls, 0),
    tokenEvents: items.reduce((sum, turn) => sum + turn.tokenEvents, 0),
    usageEventsWithoutUsage: items.reduce((sum, turn) => sum + turn.usageEventsWithoutUsage, 0),
    totalTokensFromUsageEvents: items.reduce((sum, turn) => sum + (turn.usage.total_tokens || 0), 0),
  };
}

async function run() {
  const result = JSON.parse(fs.readFileSync(path.join(acceptanceRoot, 'novella-27-result.json'), 'utf8'));
  const ledger = JSON.parse(fs.readFileSync(path.join(acceptanceRoot, 'novella-27-turn-ledger.json'), 'utf8'));
  const byChapter = {};
  for (const turn of ledger.turns) {
    const match = turn.label.match(/^chapter-(\d+)/u);
    if (match) byChapter[match[1]] = (byChapter[match[1]] || 0) + turn.durationMs;
  }
  const bridge = require(path.join(ROOT, 'src', 'main', 'codex-runtime', 'deepseekNoReasoningBridge'));
  const repaired = bridge.normalizeChatToolCalls([{ function: { name: 'read_novel_resource', arguments: '{}' } }], {
    input: [
      { type: 'message', role: 'user', content: '历史任务读取 chapter:chapter-001.md' },
      { type: 'message', role: 'user', content: '当前任务只审查 chapter:chapter-027.md' },
    ],
  });
  let capturedRequest;
  const originalFetch = global.fetch;
  try {
    global.fetch = async (url, options) => {
      capturedRequest = { url, body: JSON.parse(options.body) };
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'offline response' } }], usage: {} }) };
    };
    await bridge.chatCompletionAsResponses({
      body: { model: 'deepseek-v4-flash', reasoning: { effort: 'none' }, input: [{ type: 'message', role: 'user', content: '<name>mana-consistency-review</name>' }], tools: [] },
      headers: {}, target: 'https://example.invalid',
    });
  } finally { global.fetch = originalFetch; }
  const novellaTurns = turns.filter(turn => turn.explicitNovelBinding);
  const evidence = {
    referenceThreadId, windowStart: new Date(windowStart).toISOString(), windowEnd: new Date(windowEnd).toISOString(), novelId,
    method: 'Existing session event metadata only. Deduplicated by native turn ID. Narrow scope requires explicit novelId context. Token events are not physical HTTP request counts or provider billing; missing usage and uncompleted turns are retained separately. No novel prose was audited and no live API was called.',
    sessionFiles: files.length, duplicateTurnIds,
    acceptanceDirectoryWindow: summary(turns), explicitlyBoundNovel: summary(novellaTurns),
    finalReport: { status: result.status, ledgerLabels: ledger.turns.length, auditTurns: result.runtimeAudit.turns.length, reportedPhysicalCalls: result.runtimeAudit.physicalProviderCalls, reportedTotalTokens: result.runtimeAudit.usage.total_tokens, reportedMcpErrors: result.runtimeAudit.mcpErrors.length, reportedPatchFailures: result.runtimeAudit.patchFailures.length, auditStartedAt: new Date(Math.min(...result.runtimeAudit.turns.map(turn => turn.startedAt))).toISOString(), auditCompletedAt: result.completedAt },
    latestRunFailure: turns.find(turn => turn.id === '01a05b8b-3a55-7330-8a00-ed1c2f383747'),
    longestCompletedNovelTurn: [...novellaTurns].sort((a, b) => (b.durationMs || 0) - (a.durationMs || 0))[0],
    chapterLedgerDurationMs: byChapter,
    offlineReproductions: {
      emptyReadRepair: { intendedCurrentResource: 'chapter:chapter-027.md', actualResource: JSON.parse(repaired[0].normalized.arguments).resourceRef },
      reviewRequest: { endpoint: capturedRequest.url, stream: capturedRequest.body.stream, actualMaxTokens: capturedRequest.body.max_tokens, declaredReviewCap: bridge.CONSISTENCY_REVIEW_OUTPUT_CAP },
      developerRoleTranslation: bridge.responsesInputToChatMessages({ input: [{ type: 'message', role: 'developer', content: 'instruction' }] })[0].role,
    },
  };
  const output = path.join(__dirname, 'evidence.json');
  fs.writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify({ output, explicitlyBoundNovel: evidence.explicitlyBoundNovel, finalReport: evidence.finalReport, offlineReproductions: evidence.offlineReproductions }, null, 2));
}

run().catch(error => { console.error(error); process.exitCode = 1; });
