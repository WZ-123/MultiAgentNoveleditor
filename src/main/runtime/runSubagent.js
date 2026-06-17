'use strict';

/**
 * runSubagent — provider-agnostic agent loop.
 *
 * Phase 1 minimum: no tools / no MCP. Single-turn (or multi-turn but model is
 * never given tools so it cannot call them). This is enough to migrate the old
 * 6 hard-coded agents while we build out Phase 2.
 *
 * runSubagent({
 *   subagentId, input, novelContext?, presetOverride?, tierOverride?,
 *   abortSignal?, runId?, pipelineRunId?, nodeId?, userLang?, mcpTools?
 * }) -> { runId, output, transcript }
 */

const eventBus = require('./eventBus');
const anthropic = require('./providers/anthropic');
const openaiCompat = require('./providers/openaiCompat');
const providerManager = require('../providerManager');
const modelAliases = require('../modelAliases');
const subagentsStore = require('../store/subagents');
const { buildSystemTimePromptBlock } = require('./systemTime');
const {
  assembleProviderContext,
  buildSystemWithSkillBlocks,
  createToolResultCache,
  fitToolResultForModel,
  isCacheableToolName,
  toolCacheKey,
} = require('./contextAssembler');

let builtinSubagentsReadyPromise = null;

async function ensureBuiltinSubagentsReady() {
  if (!builtinSubagentsReadyPromise) {
    builtinSubagentsReadyPromise = subagentsStore.ensureBuiltinSeeds().catch((err) => {
      builtinSubagentsReadyPromise = null;
      throw err;
    });
  }
  return builtinSubagentsReadyPromise;
}

function pickProvider(type) {
  if (type === 'anthropic') return anthropic;
  if (type === 'openai-compat') return openaiCompat;
  throw new Error(`Unknown provider type: ${type}`);
}

async function resolveTier({ subagent, tierOverride }) {
  const tierName = tierOverride || subagent.tier || 'sonnet';
  const alias = await modelAliases.getAlias(tierName);
  const providerId = alias?.providerId || null;
  const provider = providerId
    ? await providerManager.getProvider(providerId)
    : await providerManager.getActiveProvider();
  if (!provider) throw new Error(`没有可用的 AI 服务商，无法执行 subagent「${subagent.displayName || subagent.id}」`);
  if (!provider.apiKey) throw new Error(`AI 服务商 API Key 未设置`);
  const modelId = alias?.modelId || provider.models?.[0]?.id || '';
  if (!modelId) throw new Error(`没有配置 AI 模型`);
  // Validate URL format early — catch protocol/typo errors before the
  // fetch call, avoiding unnecessary retry timeouts.
  const baseUrl = provider.baseUrl || '';
  if (baseUrl) {
    try { new URL(baseUrl); } catch (_) {
      throw new Error(`AI 服务商 API 地址无效：${baseUrl}`);
    }
  }
  const isWriting = (subagent.tags || []).includes('writing') || subagent.id === 'sa-writer';
  const maxTokens = Math.max(
    Number(alias?.maxOutputTokens) || 8192,
    isWriting ? 8192 : 4096
  );
  return {
    tierName,
    type: providerManager.inferProviderType(provider),
    baseUrl: provider.baseUrl || '',
    model: modelId,
    apiKey: provider.apiKey,
    extra: {
      ...(provider.extra || {}),
      maxTokens,
      ...(alias?.temperature != null ? { temperature: alias.temperature } : {}),
    },
    thinking: alias?.thinking
      ? { type: 'enabled', budget_tokens: alias.thinkingBudget || 16000 }
      : undefined,
  };
}

function applySystemTemplate(systemPrompt, { userLang }) {
  return String(systemPrompt || '').replace(/\{\{userLang\}\}/g, userLang || 'zh-CN');
}

function inputToMessages(input) {
  if (typeof input === 'string') {
    return [{ role: 'user', content: [{ type: 'text', text: input }] }];
  }
  if (Array.isArray(input)) return input;
  if (input && typeof input === 'object' && Array.isArray(input.messages)) return input.messages;
  if (input && typeof input === 'object' && typeof input.text === 'string') {
    return [{ role: 'user', content: [{ type: 'text', text: input.text }] }];
  }
  return [{ role: 'user', content: [{ type: 'text', text: '' }] }];
}

function extractText(content) {
  if (!Array.isArray(content)) return '';
  return content.filter((b) => b?.type === 'text').map((b) => b.text || '').join('');
}

function findToolUses(content) {
  if (!Array.isArray(content)) return [];
  return content.filter((b) => b?.type === 'tool_use');
}

async function runSubagent(opts = {}) {
  const {
    subagentId,
    input,
    tierOverride,
    systemPromptOverride,
    abortSignal,
    runId: providedRunId,
    pipelineRunId,
    nodeId,
    userLang,
    mcpClient,
  } = opts;

  const runId = eventBus.ensureRunId(providedRunId);

  await ensureBuiltinSubagentsReady();

  const subagent = await subagentsStore.getSubagent(subagentId);
  if (!subagent) {
    const e = new Error(`subagent not found: ${subagentId}`);
    await eventBus.emit({ runId, pipelineRunId, nodeId, subagentId, kind: 'error', data: { message: e.message } });
    throw e;
  }

  await eventBus.emit({ runId, pipelineRunId, nodeId, subagentId, kind: 'queued', data: { tier: tierOverride || subagent.tier } });

  const tier = await resolveTier({ subagent, tierOverride });
  const provider = pickProvider(tier.type);
  let systemPrompt = systemPromptOverride
    ? applySystemTemplate(systemPromptOverride, { userLang })
    : applySystemTemplate(subagent.systemPrompt, { userLang });

  const skillBlocks = [];
  // Inject assigned skills into system prompt
  try {
    const skillsStore = require('../store/skills');
    const allSkills = await skillsStore.listSkills();
    const assigned = allSkills.filter(s => (s.assignedSubagentIds || []).includes(subagent.id));
    if (assigned.length > 0) {
      for (const s of assigned) {
        const full = await skillsStore.getSkill(s.id);
        if (full?.content) {
          skillBlocks.push({ name: full.name || s.name || s.id, content: full.content });
        }
      }
    }
  } catch (err) {
    console.error('[runSubagent] skill injection failed:', err.message);
  }
  const skillAssembly = buildSystemWithSkillBlocks(systemPrompt, skillBlocks);
  systemPrompt = skillAssembly.system;
  systemPrompt += '\n\n---\n' + buildSystemTimePromptBlock();
  const messages = inputToMessages(input);

  let tools;
  if (mcpClient && Array.isArray(subagent.allowedTools) && subagent.allowedTools.length) {
    try {
      const all = await mcpClient.listTools();
      tools = all.filter((t) => subagent.allowedTools.includes(t.name));
    } catch (err) {
      console.error('[runSubagent] mcp.listTools failed', err);
    }
  }

  const transcript = [...messages];
  let lastTextOutput = '';
  let lastStopReason = 'end_turn';
  const maxTurns = subagent.runtimeHints?.maxTurns || 8;
  const isWriting = (subagent.tags || []).includes('writing') || subagent.id === 'sa-writer';
  let continuationCount = 0;
  const maxContinuations = isWriting ? 3 : 1;
  let turnIdx = 0;
  const toolResultCache = createToolResultCache();
  const manifestState = {
    included: [],
    trimmed: [],
    omitted: [],
    cached: [],
  };

  await eventBus.emit({ runId, pipelineRunId, nodeId, subagentId, kind: 'running', data: { tier: tier.tierName, model: tier.model } });

  while (turnIdx < maxTurns) {
    if (abortSignal?.aborted) {
      await eventBus.emit({ runId, pipelineRunId, nodeId, subagentId, kind: 'error', data: { message: 'aborted' } });
      throw new DOMException('aborted', 'AbortError');
    }

    let result;
    try {
      const assembledContext = assembleProviderContext({
        system: systemPrompt,
        messages: transcript,
        tools,
        runtime: { kind: 'runSubagent', subagentId, turnIdx },
        manifest: manifestState,
      });
      assembledContext.stats.trimmedCount += skillAssembly.stats.skillBlocksTrimmed || 0;
      assembledContext.stats.skill = skillAssembly.stats;
      assembledContext.manifest.stats = { ...assembledContext.stats };
      await eventBus.emit({
        runId,
        pipelineRunId,
        nodeId,
        subagentId,
        kind: 'context_stats',
        data: { turnIdx, ...assembledContext.stats },
      });
      await eventBus.emit({
        runId,
        pipelineRunId,
        nodeId,
        subagentId,
        kind: 'context_manifest',
        data: assembledContext.manifest,
      });
      result = await provider.sendMessage({
        system: assembledContext.system,
        messages: assembledContext.messages,
        tools: assembledContext.tools,
        tier,
        abortSignal,
        runId,
        nodeId,
        subagentId,
        onEvent: (ev) => eventBus.emit({ runId, pipelineRunId, ...ev }),
      });
    } catch (err) {
      await eventBus.emit({
        runId, pipelineRunId, nodeId, subagentId, kind: 'error',
        data: { message: err.message || String(err) },
      });
      throw err;
    }

    lastStopReason = result.stopReason || 'end_turn';
    const assistantMsg = { role: 'assistant', content: result.content || [] };
    transcript.push(assistantMsg);
    const tx = extractText(result.content);
    if (tx) {
      lastTextOutput = continuationCount > 0 && lastTextOutput
        ? `${lastTextOutput}\n${tx}`
        : tx;
    }

    const toolUses = findToolUses(result.content);
    if (!toolUses.length) {
      if (lastStopReason === 'max_tokens' && continuationCount < maxContinuations) {
        continuationCount += 1;
        transcript.push({
          role: 'user',
          content: [{
            type: 'text',
            text: '上一段输出因模型长度上限被截断。请从末尾无缝续写，不要重复已写内容，不要加说明或前言。',
          }],
        });
        turnIdx += 1;
        continue;
      }
      break;
    }
    if (!mcpClient) {
      await eventBus.emit({
        runId, pipelineRunId, nodeId, subagentId, kind: 'error',
        data: { message: 'tool_use produced but no MCP client available' },
      });
      break;
    }

    const toolResults = [];
    for (const use of toolUses) {
      let toolResult;
      const args = use.input || {};
      const cacheable = isCacheableToolName(use.name);
      const cacheKey = toolCacheKey(use.name, args);
      let fittedToolResult;
      let cached = false;
      const cachedResult = cacheable ? toolResultCache.get(use.name, args) : null;
      if (cachedResult) {
        cached = true;
        toolResult = { isError: !!cachedResult.isError };
        fittedToolResult = fitToolResultForModel({
          toolName: use.name,
          toolUseId: use.id,
          content: cachedResult.displayContent,
          isError: !!cachedResult.isError,
        });
      } else {
        try {
          toolResult = await mcpClient.callTool({
            name: use.name,
            arguments: args,
            subagentId,
            runId,
            nodeId,
            toolUseId: use.id,
            autoConfirm: true,
          });
        } catch (err) {
          toolResult = { isError: true, content: [{ type: 'text', text: err.message || String(err) }] };
        }
        const content = Array.isArray(toolResult?.content)
          ? toolResult.content.map((c) => (c.type === 'text' ? c.text : JSON.stringify(c))).join('\n')
          : (typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult ?? ''));
        fittedToolResult = fitToolResultForModel({
          toolName: use.name,
          toolUseId: use.id,
          content,
          isError: !!toolResult?.isError,
        });
        if (cacheable && !toolResult?.isError) {
          toolResultCache.set(use.name, args, {
            modelContent: fittedToolResult.modelContent,
            displayContent: fittedToolResult.displayContent,
            wasTrimmed: fittedToolResult.wasTrimmed,
            stats: fittedToolResult.stats,
            manifestItem: fittedToolResult.manifestItem,
            isError: !!toolResult?.isError,
          });
        }
      }
      const displayContent = fittedToolResult.displayContent;
      const sourceRef = `tool:${use.name}#${use.id}`;
      const manifestItem = {
        ...(fittedToolResult.manifestItem || {}),
        sourceRef,
        toolName: use.name,
        toolUseId: use.id,
        cacheKey,
      };
      manifestState.included.push({
        kind: 'tool_result',
        sourceRef,
        toolName: use.name,
        toolUseId: use.id,
        cacheKey,
        cached,
      });
      if (fittedToolResult.wasTrimmed) manifestState.trimmed.push(manifestItem);
      if (cached) {
        manifestState.cached.push({
          kind: 'tool_result',
          sourceRef,
          toolName: use.name,
          toolUseId: use.id,
          cacheKey,
        });
      }
      toolResults.push({
        type: 'tool_result',
        tool_use_id: use.id,
        content: fittedToolResult.modelContent,
        is_error: !!toolResult?.isError,
      });
      await eventBus.emit({
        runId, pipelineRunId, nodeId, subagentId, kind: 'tool_result',
        data: {
          tool_use_id: use.id,
          name: use.name,
          content: displayContent,
          isError: !!toolResult?.isError,
          modelContentTrimmed: fittedToolResult.wasTrimmed,
          originalLength: fittedToolResult.stats.originalLength,
          modelLength: fittedToolResult.stats.modelLength,
          cached,
          cacheKey,
          sourceRef,
        },
      });
    }
    transcript.push({ role: 'user', content: toolResults });
    turnIdx += 1;
  }

  await eventBus.emit({
    runId, pipelineRunId, nodeId, subagentId, kind: 'output',
    data: { text: lastTextOutput },
  });
  await eventBus.emit({
    runId, pipelineRunId, nodeId, subagentId, kind: 'done',
    data: { turns: turnIdx + 1 },
  });

  const truncated = lastStopReason === 'max_tokens';
  let output = lastTextOutput;
  if (truncated && output) {
    output += '\n\n[系统提示] 生成因输出 token 上限仍未写完。请再次调用本子代理续写，或拆成更小的写作任务。';
  }
  return { runId, output, transcript, stopReason: lastStopReason, truncated };
}

const activeRuns = new Map();

function registerActiveRun(runId, controller) {
  activeRuns.set(runId, controller);
}
function unregisterActiveRun(runId) {
  activeRuns.delete(runId);
}
function cancel(runId) {
  const c = activeRuns.get(runId);
  if (c) c.abort();
}

async function runSubagentManaged(opts = {}) {
  const ac = new AbortController();
  const runId = eventBus.ensureRunId(opts.runId);
  registerActiveRun(runId, ac);
  try {
    return await runSubagent({ ...opts, runId, abortSignal: opts.abortSignal || ac.signal });
  } finally {
    unregisterActiveRun(runId);
  }
}

module.exports = { runSubagent: runSubagentManaged, cancel };
