'use strict';
const chatRuns = require('../store/chatRuns');

// Native apply_patch can return to the model before its fileChange notification
// has finished the host transaction. Readers must observe the formal commit,
// never the intermediate mirror or a cached pre-commit resource.
async function awaitFormalCommits(ctx, { timeoutMs = 15000 } = {}) {
  if (!ctx?.novel?.id) return;
  const started = Date.now();
  let pendingRuns = [];
  while (true) {
    const records = (await chatRuns.list()).filter(run => run.novelId === ctx.novel.id);
    if (pendingRuns.some(id => records.some(run => run.runId === id && (['failed','interrupted'].includes(run.status) || run.status==='completed' && run.pendingNativeCommits?.length)))) {
      const error = new Error('原生补丁未完成正式提交，请查看任务失败或中断原因');error.code='native_commit_incomplete';throw error;
    }
    const pending = records.filter(run => ['starting','running','waiting-approval'].includes(run.status) && run.pendingNativeCommits?.length);
    if (!pending.length) return;
    pendingRuns = pending.map(run => run.runId);
    if (ctx.abortSignal?.aborted || Date.now()-started >= timeoutMs) {
      const error = new Error('正在等待已批准补丁的正式提交，本次读取未返回旧版本；请稍后重试');error.code='native_commit_pending';throw error;
    }
    await new Promise(resolve=>setTimeout(resolve,25));
  }
}
module.exports = { awaitFormalCommits };
