'use strict';

const mcpClient = require('../mcp/mcpClientStdio');
const appConfig = require('../store/appConfig');
const postWriteJobs = require('../store/chapterPostWriteJobs');
const chapterRoleplayService = require('./chapterRoleplayService');
const { persistChapterArtifacts } = require('./chapterPostWriteService');
const chapterHarnessState = require('../store/chapterHarnessState');
const { getActiveNovelContext } = require('./activeNovelContext');
const { parseJsonText } = require('./jsonText');

function parseToolText(result) {
  return Array.isArray(result?.content)
    ? result.content.map((item) => item?.type === 'text' ? item.text : JSON.stringify(item)).join('\n')
    : (typeof result === 'string' ? result : JSON.stringify(result || {}));
}

function parseToolJson(result) {
  const text = parseToolText(result).trim();
  if (!text) return null;
  try { return parseJsonText(text); } catch { return null; }
}

function needsRun(job, stepName) {
  const status = job?.steps?.[stepName]?.status;
  return !['done', 'skipped'].includes(status);
}

async function setRunning(draftId, stepName) {
  await postWriteJobs.updateStep(draftId, stepName, 'running');
}

async function runPostWriteJob({ draftId, abortSignal, onProgress }) {
  let job = await postWriteJobs.getJob(draftId);
  if (!job) throw new Error(`post-write job not found: ${draftId}`);
  if (job.steps.chapterWrite?.status !== 'done') throw new Error('chapter write is not complete');
  const toolCalls = [];
  const warnings = [];
  if (needsRun(job, 'harnessState')) {
    await setRunning(draftId, 'harnessState');
    try {
      const novelDir = getActiveNovelContext(mcpClient)?.novelDir;
      if (!novelDir) throw new Error('没有可用的小说目录');
      const state = await chapterHarnessState.saveConfirmedChapterState(
        novelDir,
        job.draft,
        job.draft?.stateVerifications || job.draft?.harnessTrace?.stateVerifications || []
      );
      const stale = await chapterHarnessState.markDownstreamStale(novelDir, job.chapterName);
      await postWriteJobs.updateStep(draftId, 'harnessState', 'done', {
        result: { chapterRef: state.chapterRef, status: state.status, downstreamMarkedStale: stale.marked },
      });
    } catch (err) {
      await postWriteJobs.updateStep(draftId, 'harnessState', 'failed', { error: err?.message || String(err) });
      warnings.push(`章节状态快照更新失败：${err?.message || String(err)}`);
    }
  }

  job = await postWriteJobs.getJob(draftId);
  const artifactSteps = ['summary', 'timeline', 'outline'].filter((step) => needsRun(job, step));
  if (artifactSteps.length) {
    for (const step of artifactSteps) await setRunning(draftId, step);
    try {
      const result = await persistChapterArtifacts({
        draft: job.draft,
        abortSignal,
        onProgress,
        steps: artifactSteps,
      });
      toolCalls.push(...(Array.isArray(result.toolCalls) ? result.toolCalls : []));
      warnings.push(...(Array.isArray(result.warnings) ? result.warnings : []));
      for (const step of artifactSteps) {
        const status = result.stepStatus?.[step] || 'failed';
        await postWriteJobs.updateStep(draftId, step, status, {
          error: status === 'failed' ? warnings.join('；') : '',
          result: {
            summarySaved: result.summarySaved,
            timelineCount: result.timelineCount,
            outlineUpdated: result.outlineUpdated,
          },
        });
      }
    } catch (err) {
      for (const step of artifactSteps) {
        await postWriteJobs.updateStep(draftId, step, 'failed', { error: err?.message || String(err) });
      }
      warnings.push(`写后资料同步失败：${err?.message || String(err)}`);
    }
  }

  job = await postWriteJobs.getJob(draftId);
  if (needsRun(job, 'characterMemory')) {
    const config = await appConfig.load();
    if (config?.writing?.characterMemoryUpdate !== 'after_confirmed_write' || !job.roleplayContext) {
      await postWriteJobs.updateStep(draftId, 'characterMemory', 'skipped');
    } else {
      await setRunning(draftId, 'characterMemory');
      try {
        const result = await chapterRoleplayService.updateCharacterMemoriesForChapter({
          draft: job.draft,
          outlineContext: job.roleplayContext,
          abortSignal,
        });
        await postWriteJobs.updateStep(draftId, 'characterMemory', 'done', { result });
      } catch (err) {
        await postWriteJobs.updateStep(draftId, 'characterMemory', 'failed', { error: err?.message || String(err) });
        warnings.push(`角色记忆更新失败：${err?.message || String(err)}`);
      }
    }
  }

  job = await postWriteJobs.getJob(draftId);
  let deAiPayload = null;
  if (needsRun(job, 'deAiReview')) {
    await setRunning(draftId, 'deAiReview');
    try {
      const toolResult = await mcpClient.callTool({
        name: 'review_de_ai_style',
        arguments: {
          chapterName: job.chapterName,
          focus: '写入后自动审查 AI 味、套话、机械行文和章末模板感',
        },
        autoConfirm: true,
      });
      const toolText = parseToolText(toolResult);
      toolCalls.push({
        id: `auto-de-ai-review-${Date.now().toString(36)}`,
        name: 'review_de_ai_style',
        input: { chapterName: job.chapterName },
        status: 'done',
        result: toolText,
        isError: !!toolResult?.isError,
      });
      if (toolResult?.isError) {
        await postWriteJobs.updateStep(draftId, 'deAiReview', 'failed', { error: toolText });
        warnings.push(`去 AI 味审查失败：${toolText}`);
      } else {
        deAiPayload = parseToolJson(toolResult) || {};
        await postWriteJobs.updateStep(draftId, 'deAiReview', 'done', {
          result: { totalAnnotations: Number(deAiPayload?.totalAnnotations) || 0 },
        });
      }
    } catch (err) {
      await postWriteJobs.updateStep(draftId, 'deAiReview', 'failed', { error: err?.message || String(err) });
      warnings.push(`去 AI 味审查失败：${err?.message || String(err)}`);
    }
  }

  job = await postWriteJobs.getJob(draftId);
  return { job, toolCalls, warnings, deAiPayload };
}

module.exports = {
  runPostWriteJob,
};
