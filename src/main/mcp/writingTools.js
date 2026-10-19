'use strict';

// Read-only preparation and preflight. Neither helper changes a mirror, formal
// novel resource, approval, or task outcome. Native apply_patch remains the writer.
const fs = require('node:fs/promises');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const { randomUUID,createHash } = require('node:crypto');
const { readResource, parseResourceRef,bodyChineseCharacterCount } = require('./novelResources');
const { resourceRelativePath } = require('../codex-runtime/nativeNovelWorkspace');
const { assessReview } = require('../codex-runtime/reviewLedger');
const { evaluateTaskResult,wordCountCheck } = require('../codex-runtime/taskCompletion');
const chatRuns = require('../store/chatRuns');
const {assertMemoryBaseline}=require('../codex-runtime/memoryBaseline');

function fail(code, message, details) { const error = new Error(message); error.code = code; error.details=details; throw error; }
async function activeTask(ctx) {
  if (!ctx?.novel?.id || !ctx.novelDir) fail('novel_required', '请先打开小说项目');
  // MCP process runId is fixed when a reusable native thread starts. It is not
  // the current turn identity. Only a host call can supply expectedRunId;
  // ordinary MCP calls retain the existing unique active-project resolution.
  if(ctx.expectedRunId) {
    const run=await chatRuns.get(ctx.expectedRunId);
    if(!run || run.novelId!==ctx.novel.id || !['starting','running','waiting-approval'].includes(run.status) || !run.workspaceRoot || run.cancelRequested) fail('preparation_task_inactive','当前工具调用不属于活动小说任务');
    return run;
  }
  const matches = (await chatRuns.list()).filter(run => run.novelId === ctx.novel.id
    && ['starting', 'running', 'waiting-approval'].includes(run.status) && run.workspaceRoot);
  if (matches.length !== 1) fail('active_task_not_unique', '未找到当前小说唯一的活动写作任务，请在活动项目任务内使用此工具');
  return matches[0];
}
function patchLines(text) {
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return text === '' ? [] : lines;
}
function nativePatch(relative, before, after) {
  const lines = before == null ? [`*** Add File: ${relative}`] : [`*** Update File: ${relative}`, '@@'];
  if (before != null) lines.push(...patchLines(before).map(line => '-' + line));
  lines.push(...patchLines(after).map(line => '+' + line));
  return lines.join('\n');
}
function exactReplace(content, replacements) {
  let next = content;
  for (const replacement of replacements) {
    const { oldText, newText, all = false } = replacement;
    if (typeof oldText !== 'string' || !oldText || typeof newText !== 'string') fail('invalid_replacement', '精确替换必须提供非空 oldText 与字符串 newText');
    const count = next.split(oldText).length - 1;
    if (!count) fail('replacement_not_found', '原文中没有完全相同的 oldText；请重新读取，不会模糊匹配或猜测转义');
    if (!all && count !== 1) fail('ambiguous_replacement', `oldText 在原文中出现 ${count} 次；请提供唯一片段，或明确 all:true`);
    next = all ? next.split(oldText).join(newText) : next.replace(oldText, () => newText);
  }
  return next;
}
function appendMemory(content, id, delta, baseline) {
  const memory = JSON.parse(content);
  if (memory.characterId !== id) fail('memory_identity_mismatch', '角色记忆身份与目标不一致');
  const keys = ['factsKnown', 'emotionalMemory', 'relationshipDeltas', 'unresolvedIntentions', 'privateMisbeliefs'];
  for (const key of keys) {
    if (!Object.hasOwn(delta, key)) continue;
    if (!Array.isArray(delta[key])) fail('invalid_memory_delta', `${key} 必须为数组`);
    const entries = [...(memory[key] || [])];
    for (const item of delta[key]) {
      if (!item || typeof item !== 'object' || Array.isArray(item) || typeof item.id !== 'string' || !item.id.trim()) fail('memory_entry_id_required', '新增记忆条目必须有稳定的非空 id');
      const old = entries.find(entry => entry.id === item.id);
      if (old && !isDeepStrictEqual(old, item)) {
        if(!baseline || (baseline[key] || []).some(entry=>entry.id===item.id)) fail('memory_entry_conflict', `记忆条目 ${item.id} 已存在且内容不同，不会覆盖原始记忆`);
        entries[entries.indexOf(old)]=item;
      }
      if (!old) entries.push(item);
    }
    memory[key] = entries;
  }
  if (delta.lastUpdatedChapterRef) {
    if (parseResourceRef(delta.lastUpdatedChapterRef).kind !== 'chapter') fail('invalid_chapter_ref', 'lastUpdatedChapterRef 必须指向章节');
    memory.lastUpdatedChapterRef = delta.lastUpdatedChapterRef;
  }
  return JSON.stringify(memory, null, 2) + '\n';
}
async function prepareNovelPatch(args, ctx) {
  const run = await activeTask(ctx);
  if(run.preparationStage?.phase==='native_commit' && (args.changes || args.preparationId!==run.preparationStage.candidate?.preparationId))fail('preparation_frozen','原生提交阶段只能取回本阶段冻结的候选，不能重新起稿或修改');
  return buildNovelPatch(args,ctx);
}
async function buildNovelPatch(args, ctx, cachedIdentity = null) {
  const run = await activeTask(ctx);
  if(cachedIdentity && run.writingPreparations?.[cachedIdentity.id]?.revision!==cachedIdentity.revision)fail('preparation_revision_changed','候选在取回或修改期间已经变化');
  if (args.preparationId) {
    const prior = run.writingPreparations?.[args.preparationId];
    if (!prior || prior.runId !== run.runId || prior.novelId !== ctx.novel.id) fail('preparation_expired', '准备记录不存在或不属于本任务，请使用当前资料重新准备');
    if(args.expectedRevision!=null && args.expectedRevision!==prior.revision)fail('preparation_revision_changed','候选已更新，不能使用旧阶段的版本');
    const commits=[...(run.savedResources||[]),...(run.reusedSavedResources||[])];
    const committed=await Promise.all((prior.expectedResources||[]).map(async expected=>{
      const actual=await readResource({id:ctx.novel.id,dir:ctx.novelDir},expected.resourceRef).catch(()=>null);
      return actual?.sourceHash===expected.hash && commits.some(commit=>commit.resourceRef===expected.resourceRef&&commit.newHash===actual.sourceHash);
    }));
    if(committed.length&&committed.every(Boolean)) {
      if(args.changes)fail('preparation_already_committed','此候选已提交；请读取当前资源并以新的 changes 准备修订，不在已提交候选上叠加草稿。');
      return {ok:true,preparationId:args.preparationId,preparationRevision:prior.revision,preparedOnly:false,saved:true,status:'already_committed',runId:run.runId,
      resources:prior.expectedResources,instruction:'此候选已在本任务正式提交，不再生成或应用同一补丁。修订需先读取保存结果，再用新的 changes 准备；取回旧候选不是修改操作。'};
    }
    if(args.changes && (!Array.isArray(args.changes)||!args.changes.length))fail('invalid_change_count','追加候选需要非空 changes');
    const merged=new Map(prior.changes.map(change=>[change.resourceRef,change]));
    for(const change of args.changes||[]) {
      // Replacing a staged resource keeps its original read version. A later
      // unrelated read cannot silently rebase an already assembled draft.
      const frozen=merged.get(change.resourceRef)?.baseHash;
      const staged=prior.contents?.[change.resourceRef];
      const next=change.replacements&&typeof staged==='string'
        ? {resourceRef:change.resourceRef,content:exactReplace(staged,change.replacements)} : change;
      merged.set(change.resourceRef,{...next,...(frozen?{baseHash:frozen}:{})});
    }
    // Recompute from the unchanged authored inputs, so every hash, mirror,
    // scope and memory-preservation check runs again before returning a patch.
    return buildNovelPatch({changes:[...merged.values()],participantCharacterRefs:args.participantCharacterRefs||prior.participantCharacterRefs,narrativePerspective:args.narrativePerspective||prior.narrativePerspective},ctx,{id:args.preparationId,createdAt:prior.createdAt,revision:prior.revision,retrieving:!args.changes});
  }
  if (!Array.isArray(args.changes) || !args.changes.length || args.changes.length > 16) fail('invalid_change_count', '单个补丁需要 1—16 项资源修改');
  run.taskConstraints=await require('../codex-runtime/writingScope').bindCandidateScope(ctx.novel,run.taskConstraints,{participantCharacterRefs:args.participantCharacterRefs,resourceRefs:args.changes.map(change=>change.resourceRef)});
  const entry = { id: ctx.novel.id, dir: ctx.novelDir };
  const perspective=args.narrativePerspective || run.taskConstraints.narrativePerspective;
  if(perspective && args.changes.some(change=>change.resourceRef.startsWith('chapter:'))) {
    if(!['limited','omniscient'].includes(perspective.mode))fail('narrative_perspective_invalid','无效的叙述视角声明');
    if(run.taskConstraints.narrativePerspective && !isDeepStrictEqual(perspective,run.taskConstraints.narrativePerspective))fail('narrative_perspective_changed','不能在后续候选中改变本任务已绑定的叙述视角');
    if(perspective.mode==='limited') {
      const focus=await readResource(entry,perspective.focusCharacterRef).catch(()=>null);
      if(focus?.kind!=='character')fail('narrative_focus_invalid','有限视角焦点必须是本小说实际存在的角色');
    }
    run.taskConstraints.narrativePerspective=perspective;
  }
  const refs = new Set(); const previews = []; const patches = []; const resolvedChanges=[];const expectedResources=[];const contents={};
  for (const change of args.changes) {
    const ref = change.resourceRef;
    const relative = resourceRelativePath(ref);
    if (refs.has(ref)) fail('duplicate_resource', `补丁重复修改资源：${ref}`);
    refs.add(ref);
    if (run.taskConstraints?.allowedWriteResourceRefs?.length && !run.taskConstraints.allowedWriteResourceRefs.includes(ref)) fail('task_scope_violation', `资源不在本次写入范围：${ref}`);
    let resource = null;
    try { resource = await readResource(entry, ref); }
    catch (error) { if (error.code !== 'ENOENT' && error.details?.reason !== 'resource_not_found') throw error; }
    const baseHash=change.baseHash ?? require('./readVersionReceipts').readVersion(run.runId,ref) ?? (resource ? undefined : 'absent');
    if(baseHash==null) fail('resource_version_read_required',`本任务没有 ${ref} 的实际读取版本凭证；请先读取该资源。无需手抄 hash。`);
    if ((resource ? resource.sourceHash : 'absent') !== baseHash) fail('resource_version_changed', `版本不匹配：${ref}；请重新读取。可省略 baseHash，使用本任务最新实际读取凭证；不会使用过期版本生成补丁`);
    resolvedChanges.push({...change,baseHash});
    const absolute = path.resolve(run.workspaceRoot, relative);
    if (!absolute.startsWith(path.resolve(run.workspaceRoot) + path.sep)) fail('invalid_patch_path', '补丁必须位于当前受控镜像');
    // Reject links in every component, not merely the final file.
    for (let target = absolute; target !== path.resolve(run.workspaceRoot); target = path.dirname(target)) {
      const stat = await fs.lstat(target).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
      if (stat?.isSymbolicLink()) fail('unsafe_workspace_path', '受控镜像不允许符号链接');
    }
    const before = await fs.readFile(absolute, 'utf8').catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (!!resource !== (before != null)) fail('workspace_out_of_sync', '正式资源与镜像是否存在不一致，请等待提交完成或重新启动任务');
    if ([change.content != null, change.replacements != null, change.memoryAppend != null].filter(Boolean).length !== 1) fail('invalid_change_mode', '每项修改只选择 content、replacements 或 memoryAppend 一种方式');
    let after;
    if (change.memoryAppend != null) {
      const parsed = parseResourceRef(ref);
      if (parsed.kind !== 'character-memory' || before == null) fail('invalid_memory_target', 'memoryAppend 仅更新已经存在的角色记忆');
      const delta={...change.memoryAppend};
      for(const key of ['factsKnown','emotionalMemory','relationshipDeltas','unresolvedIntentions','privateMisbeliefs']) {
        if(Array.isArray(delta[key]))delta[key]=delta[key].map(item=>item&&typeof item==='object'&&!Array.isArray(item)&&!Object.hasOwn(item,'id')?{...item,id:randomUUID()}:item);
      }
      after = appendMemory(before, parsed.key, delta, run.memoryBaselines?.[ref]);
      resolvedChanges.at(-1).memoryAppend=delta;
    } else if (change.replacements != null) {
      if (before == null || !Array.isArray(change.replacements) || !change.replacements.length) fail('invalid_replacements', '精确替换需要已有资源和非空 replacements');
      after = exactReplace(before, change.replacements);
    } else {
      if (typeof change.content !== 'string') fail('invalid_content', 'content 必须是模型直接创作的字符串');
      after = change.content;
    }
    if(run.memoryBaselines?.[ref]) assertMemoryBaseline(run.memoryBaselines[ref],JSON.parse(after));
    if (after && !after.endsWith('\n')) after += '\n';
    if (after === before || (before == null && !after)) fail('no_changes', `资源没有实际修改：${ref}，不生成空补丁`);
    patches.push(nativePatch(relative, before, after));
    contents[ref]=after;
    const canonical=require('./mutationService').canonicalCandidate(ref,after);
    expectedResources.push({resourceRef:ref,hash:createHash('sha256').update(canonical).digest('hex'),mirrorHash:createHash('sha256').update(after).digest('hex')});
    previews.push({ resourceRef: ref, mode: before == null ? 'create' : 'replace', baseHash: resource?.sourceHash || null,
      ...(ref.startsWith('chapter:')?{bodyChineseCharacterCount:bodyChineseCharacterCount(after)}:{}) });
  }
  const preparationId = cachedIdentity?.id || randomUUID();
  const c=run.taskConstraints;
  let countRefs;
  if(c.wordCountScope==='target_resources')countRefs=c.targetResourceRefs;
  else if(c.wordCountScope==='new_writing'&&c.wordCountResourceRefs.length)countRefs=c.wordCountResourceRefs;
  else {
    const previous=[...(run.reusedSavedResources||[]),...(run.savedResources||[])];
    countRefs=[...new Set([...previous.filter(item=>item.resourceRef.startsWith('chapter:')&&(c.wordCountScope!=='new_writing'||item.mode==='create')).map(item=>item.resourceRef),...previews.filter(item=>item.resourceRef.startsWith('chapter:')&&(c.wordCountScope!=='new_writing'||item.mode==='create')).map(item=>item.resourceRef)])];
    if(c.wordCountScope==='whole_novel')countRefs=[...new Set([...countRefs,...(await require('./novelResources').listResourceDescriptors(entry)).filter(item=>item.kind==='chapter').map(item=>item.resourceRef)])];
  }
  const candidateCount=(await Promise.all(countRefs.filter(ref=>ref.startsWith('chapter:')).map(async ref=>{
    const preview=previews.find(item=>item.resourceRef===ref);
    return preview?preview.bodyChineseCharacterCount:bodyChineseCharacterCount((await readResource(entry,ref)).content);
  }))).reduce((sum,count)=>sum+count,0);
  const candidateChecks={wordCount:wordCountCheck(candidateCount,c)};
  const missingResourceRefs=c.atomicMemoryWithChapter&&!['savedResources','reusedSavedResources'].some(key=>(run[key]||[]).some(item=>item.resourceRef.startsWith('chapter:')))
    ? [...c.requiredWriteResourceRefs.filter(ref=>!refs.has(ref)),...([...refs].some(ref=>ref.startsWith('chapter:'))?[]:['chapter:new'])] : [];
  // Freeze resolved versions even when the caller omitted the hash. Retrieving
  // this candidate must not rebase it onto a later read or changed resource.
  const material={id:preparationId,runId:run.runId,novelId:ctx.novel.id,createdAt:cachedIdentity?.createdAt||Date.now(),changes:JSON.parse(JSON.stringify(resolvedChanges)),contents,expectedResources,participantCharacterRefs:run.taskConstraints.participantCharacterRefs.length?run.taskConstraints.participantCharacterRefs:undefined,narrativePerspective:run.taskConstraints.narrativePerspective};
  const persisted=cachedIdentity?.retrieving ? run.writingPreparations[preparationId] : await chatRuns.saveWritingPreparation(run.runId,material,cachedIdentity?.revision||0);
  const preparationRevision=persisted.revision;
  if(missingResourceRefs.length)return {ok:true,status:'draft_incomplete',preparationId,preparationRevision,draftOnly:true,preparedOnly:false,saved:false,runId:run.runId,resources:previews,missingResourceRefs,candidateChecks,
    instruction:'草稿已暂存，未生成可应用补丁。使用本 preparationId 加 changes 补齐缺项；同一资源的新 changes 替换该资源草稿。集齐章节和必需记忆后才返回 patch；正式写入仍需同批原生批准。'};
  return { ok: true, preparationId, preparationRevision, preparedOnly: true, saved: false, runId: run.runId, resources: previews,
    candidateChecks,
    taskScope:{participantCharacterRefs:run.taskConstraints.participantCharacterRefs,memoryScopeBound:run.taskConstraints.memoryScopeBound,requiredWriteResourceRefs:run.taskConstraints.requiredWriteResourceRefs,narrativePerspective:run.taskConstraints.narrativePerspective},
    wordCountTarget:{minimum:run.taskConstraints.minBodyCjk,maximum:run.taskConstraints.maxBodyCjk,toleranceRatio:run.taskConstraints.wordCountToleranceRatio},
    patch: ['*** Begin Patch', ...patches, '*** End Patch'].join('\n'),
    instruction: '在同一次 functions.exec 中准备后立即 await tools.apply_patch(result.structuredContent.patch)，不要 text/打印完整准备结果以免长补丁被截断。若已在上一 exec 准备，使用本 preparationId 再取回并在同一次 exec 立即 apply_patch；不会沿用过期 hash。不要转抄、重新转义、空 changes 或删除文件。仍需原生批准和正式提交。' };
}
async function readWritingContext(args,ctx) {
  const run=await activeTask(ctx);
  const result=await require('../codex-runtime/writingContext').buildWritingContext(ctx.novel,run);
  for(const source of require('../codex-runtime/writingContext').contextResources(result))await require('./readVersionReceipts').rememberReadVersion(ctx,source);
  return result;
}
async function inspectWritingTask(args, ctx) {
  const snapshot = await activeTask(ctx);
  const entry = { id: ctx.novel.id, dir: ctx.novelDir };
  const run = { ...snapshot, entry, committedResources: snapshot.savedResources || [], taskConstraints: snapshot.taskConstraints || {}, text: snapshot.text || '' };
  let hostedReview;
  if(run.taskConstraints.narrativeAuditRequired) {
    hostedReview=await require('../codex-runtime/narrativeReviewJobs').requestReview(snapshot,entry,{signal:ctx.abortSignal});
    if(hostedReview?.ok) {
      run.items=[...(run.items||[]),...hostedReview.sourceDeliveryItems];
      run.text=JSON.stringify(hostedReview.report);
      run.reviewRecord=await assessReview(entry,{...run,text:'```json\n'+run.text+'\n```',expectedCoverageHashes:hostedReview.coverageHashes,resolutionAuthority:'independent_review'});
      run.reviewSubmission={origin:'host_readonly_analysis',report:hostedReview.report};
      run.narrativeReview={status:'completed',modelId:hostedReview.modelId,key:hostedReview.key};
      run.reviewFindings=require('../codex-runtime/reviewLedger').mergeReviewFindings(run.reviewFindings,run.reviewRecord);
    }
    if(hostedReview&&!hostedReview.ok)run.narrativeReview={status:'failed',error:hostedReview.error};
  }
  if (args.report && !hostedReview) {
    run.reviewRecord = await assessReview(entry, { ...run, text: '```json\n' + JSON.stringify(args.report) + '\n```' });
    run.reviewFindings=require('../codex-runtime/reviewLedger').mergeReviewFindings(run.reviewFindings,run.reviewRecord);
    run.text = JSON.stringify(args.report);
  }
  const result = await evaluateTaskResult(run, true);
  let reviewPlan;
  if(snapshot.taskConstraints.narrativeAuditRequired&&!hostedReview) {
    const refs=[...new Set([...(snapshot.taskConstraints.reviewTargetResourceRefs||[]),...(snapshot.savedResources||[]).map(item=>item.resourceRef),...(snapshot.reusedSavedResources||[]).map(item=>item.resourceRef)])];
    if(!refs.length && snapshot.taskConstraints.reviewScope==='observed_resources')refs.push(...require('../codex-runtime/reviewLedger').observedReadRefs(snapshot.items));
    const resources=await Promise.all(refs.map(ref=>readResource(entry,ref).catch(()=>null)));
    reviewPlan={perspective:snapshot.taskConstraints.narrativePerspective,targets:resources.filter(Boolean).map(r=>r.resourceRef),
      instruction:'尚无绑定的正式审查目标。写作任务先准备、批准并保存正文，再调用本工具；只读审查先绑定实际章节目标。不填写逐句分类或语义证明表。'};
  }
  return { ok: result.objective.status !== 'incomplete', previewOnly: true, runId: snapshot.runId,
    ...(hostedReview?{hostedReview:{ok:hostedReview.ok,key:hostedReview.key,error:hostedReview.error,issues:hostedReview.report?.issues,threadId:hostedReview.threadId,turnId:hostedReview.turnId,modelId:hostedReview.modelId,readOnly:true}}:{}),
    ...(reviewPlan?{reviewPlan}:{}),
    unmet: result.objective.unmet, checks: result.checks,
    savedResources: result.evidence?.currentSavedResourceRefs || [],
    instruction: '这是同一次任务内的真实缺项预检，不是终态。按缺项补齐后再交付；不重写已达标内容、不跳过批准。report 若提供则按与最终审校相同的 hash、原文位置、实际读取和覆盖规则核验。' };
}
const memoryDeltaSchema = { type: 'object', properties: Object.fromEntries([
  ...['factsKnown','emotionalMemory','relationshipDeltas','unresolvedIntentions','privateMisbeliefs'].map(key => [key,{type:'array',items:{type:'object',properties:{id:{type:'string',description:'Omit for new entries: host assigns identity. Supply only to update a previously read entry created in this task; original entries are immutable.'},summary:{type:'string'}},required:['summary'],additionalProperties:true}}]),
  ['lastUpdatedChapterRef',{type:'string'}],
]), additionalProperties:false };
const evidenceSchema = { type:'object', properties:{ resourceRef:{type:'string'},location:{type:'string',description:'Optional when quote is unique in the actually read resource; host resolves exact lines. Explicit locations are checked strictly.'},quote:{type:'string'} }, required:['resourceRef','quote'], additionalProperties:false };
const reportSchema = { type:'object',properties:{coveredResourceRefs:{type:'array',items:{type:'string'}},issues:{type:'array',items:{type:'object',properties:{issueId:{type:'string'},category:{type:'string'},severity:{type:'string',enum:['hard','suspicion','preference']},status:{type:'string',enum:['open','closed']},contradiction:{type:'string'},evidence:{type:'array',items:evidenceSchema},resolution:{type:'object',properties:{kind:{type:'string',enum:['fixed','not_an_issue']},explanation:{type:'string'}},required:['kind','explanation'],additionalProperties:false}},required:['issueId','category','severity','status','contradiction','evidence'],additionalProperties:false}}},required:['coveredResourceRefs','issues'],additionalProperties:false };
const WRITING_TOOLS = [
  {name:'read_writing_context',description:'Read the task-bound writing sources in one call: shared canonical sources and each character own card/subjective memory, with frozen task-start memory kept separate. Returns actual current versions and preserves knowledge ownership.',inputSchema:{type:'object',properties:{},additionalProperties:false},handler:readWritingContext},
  { name:'prepare_novel_patch', description:'Stage authored changes without writing or approving. Existing resources require an actual read; host owns versions and new memory IDs. Use content for prose, replacements for exact edits, memoryAppend for subjective entries. For atomic chapter/memory tasks, partial changes return draft_incomplete and preparationId; add remaining changes with that ID. With preparationId, replacements edit the staged content (including new unsaved chapters), content replaces it. Only a complete candidate returns patch: in the SAME exec pass structuredContent.patch directly to tools.apply_patch without printing/retyping. preparationId alone retrieves a frozen candidate.',
    inputSchema:{type:'object',properties:{narrativePerspective:require('../codex-runtime/narrativeAudit').perspectiveSchema,participantCharacterRefs:{type:'array',items:{type:'string'},description:'Actual participants; user-bound participants cannot be replaced.'},preparationId:{type:'string'},expectedRevision:{type:'integer',minimum:1,description:'Optional exact candidate revision for a host-controlled handoff; an older revision is rejected.'},changes:{type:'array',minItems:1,maxItems:16,items:{type:'object',properties:{resourceRef:{type:'string'},content:{type:'string'},replacements:{type:'array',minItems:1,items:{type:'object',properties:{oldText:{type:'string'},newText:{type:'string'},all:{type:'boolean'}},required:['oldText','newText'],additionalProperties:false}},memoryAppend:memoryDeltaSchema},required:['resourceRef'],additionalProperties:false}}},additionalProperties:false},handler:prepareNovelPatch },
  { name:'check_writing_task', description:'Call after formal saves and before final reply. This read-only tool performs the required narrative review on frozen source versions using one isolated read-only analysis, cached per version including failures; the writer does not fill its own analysis. Returns actual time/knowledge conflicts, coverage and task deficits. Fix issues in the current authorized writing turn; changed versions require a new check. Non-narrative reviews may supply report for citation validation. This tool cannot write or approve changes.',inputSchema:{type:'object',properties:{report:reportSchema},additionalProperties:false},handler:inspectWritingTask },
];
for (const tool of WRITING_TOOLS) {
  const handler = tool.handler;
  tool.handler = async (...args) => {
    const value = await handler(...args);
    const summary = value.patch ? {...value,patch:undefined} : value;
    return { content: [{ type: 'text', text: JSON.stringify(summary) }], structuredContent: value };
  };
}
module.exports = { WRITING_TOOLS, activeTask, prepareNovelPatch, inspectWritingTask, readWritingContext, exactReplace, appendMemory, nativePatch };
