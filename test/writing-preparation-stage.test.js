'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'mana-preparation-stage-'));
  process.env.MANA_USER_DATA_ROOT = path.join(root,'data');
  const runs = require('../src/main/store/chatRuns');
  const data = require('../src/main/store/novelData');
  const {readResource} = require('../src/main/mcp/novelResources');
  const {prepareNovelPatch} = require('../src/main/mcp/writingTools');
  const {syncNativeNovelWorkspace} = require('../src/main/codex-runtime/nativeNovelWorkspace');
  const {CodexSessionService} = require('../src/main/codex-runtime/codexSessionService');
  const {normalizeTaskConstraints} = require('../src/main/codex-runtime/taskLedger');
  const stage = require('../src/main/codex-runtime/writingPreparationStage');
  const service = new CodexSessionService();
  let checks=0;
  const test=async(name,fn)=>{await fn();checks++;console.log('PASS preparation-stage '+name)};
  try {
    const novel=await require('../src/main/store/novels').createNovel({title:'阶段交接',dir:path.join(root,'novel')});
    await data.writeCharacter(novel.dir,{id:'lin',name:'林岚'});
    await data.writeCharacterMemory(novel.dir,{characterId:'lin',factsKnown:[{id:'old',summary:'旧事实'}]});
    const workspace=await syncNativeNovelWorkspace(novel,path.join(root,'workspaces'));
    const constraints=normalizeTaskConstraints({operation:'write',wordCountScope:'new_writing',participantCharacterRefs:['character:lin'],participantScopeFixed:true,memoryUpdateRequired:true,memoryScopeBound:true,atomicMemoryWithChapter:true,requiredWriteResourceRefs:['character-memory:lin']});
    const record={runId:'stage-parent',novelId:novel.id,status:'running',version:1,persistence:'one-shot',startedAt:new Date().toISOString(),workspaceRoot:workspace.root,taskConstraints:constraints,savedResources:[]};
    service.runRecords.set(record.runId,record);
    const run={runId:record.runId,conversationId:'',entry:novel,workspace,taskConstraints:constraints,route:{model:{id:'fixture',verification:{tools:'ok'}},connection:{}},threadId:'commit-thread',turnId:'',items:[],text:'',committedResources:[],nativeFileItems:new Map(),approvedFileItems:new Map(),completedFileItems:new Set(),userRejectedFileItems:new Set()};
    service.activeRuns.set(run.runId,run);service.projectRuns.set(novel.id,run.runId);
    await service._checkpointRun(run.runId);
    const ctx={novel,novelDir:novel.dir,expectedRunId:run.runId};
    const chapterRef='chapter:chapter-002.md';
    const memory=await readResource(novel,'character-memory:lin');
    const changes=[{resourceRef:chapterRef,content:'# 第二章\n\n她收好了潮表。\n'},{resourceRef:memory.resourceRef,memoryAppend:{factsKnown:[{summary:'亲眼收好潮表'}],lastUpdatedChapterRef:chapterRef}}];
    let frozen;
    await test('one native child completes while parent and project ownership stay active; same preparation implementation produces atomic candidate',async()=>{
      service._startThread=async()=> 'preparation-child';
      service.archiveThread=async()=>{};
      service.processManager={request:async()=>({})};
      service._startNativeTurn=async params=>{
        setImmediate(async()=>{
          await service._onNotification({method:'item/agentMessage/delta',params:{threadId:params.threadId,turnId:'child-turn',delta:JSON.stringify({changes})}});
          await service._onNotification({method:'turn/completed',params:{threadId:params.threadId,turn:{id:'child-turn',status:'completed'}}});
        });
        return {turn:{id:'child-turn'}};
      };
      frozen=await stage.prepareStage(service,run,{text:'fixture authored data',outputSchema:{type:'object'}});
      assert.equal(run.preparationStage.phase,'prepared');assert.equal(run.preparationStage.execution.purpose,'writing_preparation');
      assert.equal(run.preparationStage.execution.modelId,'fixture');
      assert.equal(run.preparationStage.execution.turnId,'child-turn');
      assert.equal(service.activeRuns.get(run.runId),run);assert.equal(service.projectRuns.get(novel.id),run.runId);
      assert.equal(frozen.resources.length,2);assert.equal((await runs.get(run.runId)).status,'running');
      await assert.rejects(readResource(novel,chapterRef));
      assert.equal(JSON.parse((await readResource(novel,memory.resourceRef)).content).factsKnown.length,1);
    });
    await test('durable candidate survives module reload, old timestamp and more than eight other candidates; retrieval never increments revision',async()=>{
      const stored=(await runs.get(run.runId)).writingPreparations[frozen.preparationId];
      for(let i=0;i<10;i++)await prepareNovelPatch({changes:[{resourceRef:'chapter:chapter-spare-'+i+'.md',content:'独立暂存。'}]},ctx);
      stored.createdAt=0;
      const updated=await runs.saveWritingPreparation(run.runId,stored,stored.revision);
      run.preparationStage.candidate.revision=updated.revision;
      delete require.cache[require.resolve('../src/main/mcp/writingTools')];
      const restored=await require('../src/main/mcp/writingTools').prepareNovelPatch({preparationId:frozen.preparationId,expectedRevision:updated.revision},ctx);
      assert.equal(restored.patch,frozen.patch);assert.equal(restored.preparationRevision,updated.revision);
      assert.equal((await prepareNovelPatch({preparationId:frozen.preparationId},{novel,novelDir:novel.dir,runId:'original-reused-thread-run'})).preparationRevision,updated.revision,'static MCP process identity must not override the current unique project turn');
      await assert.rejects(prepareNovelPatch({preparationId:frozen.preparationId},{...ctx,expectedRunId:'another-task'}),e=>e.code==='preparation_task_inactive');
      await assert.rejects(prepareNovelPatch({preparationId:frozen.preparationId,expectedRevision:updated.revision-1},ctx),e=>e.code==='preparation_revision_changed');
    });
    await test('host and MCP processes cannot overwrite each other or drop candidates during concurrent checkpoints',async()=>{
      const script=`const runs=require('./src/main/store/chatRuns');(async()=>{for(let i=0;i<12;i++)await runs.saveWritingPreparation('stage-parent',{id:'from-child-'+i,novelId:${JSON.stringify(novel.id)},contents:{}},0)})().catch(e=>{console.error(e);process.exitCode=1});`;
      const child=spawn(process.execPath,['-e',script],{cwd:path.resolve(__dirname,'..'),env:process.env,stdio:['ignore','pipe','pipe']});
      let stderr='';child.stderr.on('data',d=>stderr+=d);
      const done=new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(new Error(stderr)))});
      for(let i=0;i<12;i++)await service._checkpointRun(run.runId);
      await done;
      const actual=await runs.get(run.runId);
      assert.equal(Object.keys(actual.writingPreparations).filter(k=>k.startsWith('from-child')).length,12);
      assert.ok(actual.writingPreparations[frozen.preparationId]);assert.equal(actual.preparationStage.phase,'prepared');
    });
    let nativeChanges;
    await test('handoff binds exact revision; changed candidate or invented native bytes cannot enter approval',async()=>{
      const input=await stage.commitInput(service,run);assert.match(input[0].text,/expectedRevision/u);
      const nativeRetrieval=await require('../src/main/mcp/tools').getToolByName('prepare_novel_patch').handler({preparationId:frozen.preparationId,expectedRevision:run.preparationStage.candidate.revision},{novel,novelDir:novel.dir,runId:'reused-native-thread'});
      assert.equal(nativeRetrieval.structuredContent.patch,frozen.patch,'the commit-stage MCP must actually retrieve the same patch, not only pass evidence validation');
      const material=(await runs.get(run.runId)).writingPreparations[frozen.preparationId];
      const evidence=material.expectedResources.map(expected=>({resourceRef:expected.resourceRef,afterHash:expected.mirrorHash,beforeHash:material.changes.find(c=>c.resourceRef===expected.resourceRef).baseHash==='absent'?require('../src/main/codex-runtime/contracts').hash(null):material.changes.find(c=>c.resourceRef===expected.resourceRef).baseHash}));
      await stage.assertCommitCandidate(run,evidence);
      await assert.rejects(stage.assertCommitCandidate(run,[{...evidence[0],afterHash:'invented'},evidence[1]]),e=>e.code==='preparation_content_mismatch');
      const oldRevision=run.preparationStage.candidate.revision;run.preparationStage.candidate.revision--;
      await assert.rejects(stage.assertCommitCandidate(run,evidence),e=>e.code==='preparation_revision_changed');run.preparationStage.candidate.revision=oldRevision;
      nativeChanges=material.expectedResources.map(expected=>({resourceRef:expected.resourceRef,path:require('../src/main/codex-runtime/nativeNovelWorkspace').resourceRelativePath(expected.resourceRef),kind:{type:material.changes.find(c=>c.resourceRef===expected.resourceRef).baseHash==='absent'?'add':'update'},diff:expected.resourceRef===chapterRef?material.contents[chapterRef]:frozen.patch.split('*** Update File: character-memories/lin.json\n')[1].split('\n*** End Patch')[0]}));
    });
    await test('ordinary native approval and mutation service commit chapter and canonical memory together, then real readback settles stage',async()=>{
      const itemId='native-item-1';
      const approval=service._handleServerRequest('item/fileChange/requestApproval',{threadId:run.threadId,itemId,fileChanges:nativeChanges});
      while(!service.pendingConfirmations.size)await new Promise(r=>setTimeout(r,10));
      await service.resolveConfirmation({confirmationId:[...service.pendingConfirmations.keys()][0],accept:true});assert.equal((await approval).decision,'accept');
      const material=(await runs.get(run.runId)).writingPreparations[frozen.preparationId];
      for(const expected of material.expectedResources){const file=path.join(workspace.root,require('../src/main/codex-runtime/nativeNovelWorkspace').resourceRelativePath(expected.resourceRef));await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,material.contents[expected.resourceRef]);}
      await service._commitNativeWorkspace(run,itemId,nativeChanges);
      assert.equal(run.preparationStage.phase,'readback_complete','formal readback must settle the stage before the native writer asks check_writing_task');
      assert.equal(run.committedResources.length,2);assert.ok(run.committedResources.every(c=>c.nativeItemId===itemId));
      for(const expected of material.expectedResources)assert.equal((await readResource(novel,expected.resourceRef)).sourceHash,expected.hash);
      const repeated=await prepareNovelPatch({preparationId:frozen.preparationId},ctx);assert.equal(repeated.status,'already_committed');
      const result=await service._evaluateTaskResult(run,true);
      const delivery={...run,preparationStage:{...run.preparationStage},text:'执行器仅收到原生工具 {}，没有宿主提交证明。',activityText:'原生过程'};
      stage.presentReceipt(delivery,result);assert.match(delivery.text,/已保存并读回 2 项资源/u);assert.match(delivery.activityText,/没有宿主提交证明/u);
      assert.equal(delivery.preparationStage.resultOrigin,'host_commit_receipt');const activity=delivery.activityText;stage.presentReceipt(delivery,result);assert.equal(delivery.activityText,activity);
      const stale={...run,preparationStage:{...run.preparationStage},text:'执行器原始输出'};stage.presentReceipt(stale,{evidence:{currentSavedResourceRefs:[]}});assert.equal(stale.text,'执行器原始输出','no current formal receipt means no host success message');
    });
    await test('cancel propagates to a running native preparation child; late output cannot prepare or commit',async()=>{
      const cancelled={...run,runId:'cancel-parent',preparationStage:undefined,items:[],committedResources:[],turnId:''};
      service.runRecords.set(cancelled.runId,{...record,runId:cancelled.runId,version:1,status:'running'});service.activeRuns.set(cancelled.runId,cancelled);
      await service._checkpointRun(cancelled.runId);
      service._startThread=async()=> 'cancel-child';
      service._startNativeTurn=async()=>({turn:{id:'cancel-turn'}});
      let interrupted=0;
      service.processManager.request=async(method,params)=>{
        if(method==='turn/interrupt'){
          interrupted++;
          setImmediate(()=>service._onNotification({method:'turn/completed',params:{threadId:params.threadId,turn:{id:'cancel-turn',status:'interrupted'}}}));
        }
        return {};
      };
      const preparing=stage.prepareStage(service,cancelled,{text:'controlled cancellation',outputSchema:{type:'object'}});
      const rejected=assert.rejects(preparing,e=>e.code==='turn_interrupted');
      while(!cancelled.preparationStage?.execution)await new Promise(r=>setTimeout(r,10));
      await service.interrupt({runId:cancelled.runId});await rejected;
      assert.equal(interrupted,1);assert.equal(cancelled.preparationStage.phase,'interrupted');
      assert.equal((await runs.get(cancelled.runId)).writingPreparations,undefined);
      await service._onNotification({method:'turn/completed',params:{threadId:'cancel-child',turn:{id:'cancel-turn',status:'completed'}}});
      assert.equal((await runs.get(cancelled.runId)).writingPreparations,undefined);
      service.activeRuns.delete(cancelled.runId);
    });
    await test('a source edited while the model prepares cannot be silently rebound to its newer version',async()=>{
      const conflict={...run,runId:'conflict-parent',preparationStage:undefined,items:[],committedResources:[],turnId:''};
      service.runRecords.set(conflict.runId,{...record,runId:conflict.runId,version:1,status:'running'});service.activeRuns.set(conflict.runId,conflict);
      await service._checkpointRun(conflict.runId);
      const original=JSON.parse((await readResource(novel,memory.resourceRef)).content);
      service.runOneShot=async options=>{
        await options.onStarted({runId:'controlled-source-change',threadId:'source-child',turnId:'source-turn',modelId:'fixture',purpose:'writing_preparation'});
        await data.writeCharacterMemory(novel.dir,{...original,factsKnown:[...original.factsKnown,{id:'external-user',summary:'模型运行期间的用户修改'}]});
        return {text:JSON.stringify({changes:[{resourceRef:'chapter:chapter-003.md',content:'本应暂存的候选。'},changes[1]]})};
      };
      await assert.rejects(stage.prepareStage(service,conflict,{text:'controlled source change',outputSchema:{type:'object'}}),e=>e.code==='resource_version_changed');
      assert.equal(conflict.preparationStage.phase,'failed');assert.equal((await runs.get(conflict.runId)).writingPreparations,undefined);
      await assert.rejects(readResource(novel,'chapter:chapter-003.md'));
      assert.equal(JSON.parse((await readResource(novel,memory.resourceRef)).content).factsKnown.at(-1).id,'external-user');
      service.activeRuns.delete(conflict.runId);
    });
    await test('below and above target drafts can be approved and saved while original zero-tolerance acceptance stays incomplete',async()=>{
      for(const [index,count] of [1324,2001].entries()) {
        const draft={...run,runId:'draft-parent-'+count,threadId:'draft-thread-'+count,preparationStage:undefined,items:[],committedResources:[],turnId:'',
          nativeFileItems:new Map(),approvedFileItems:new Map(),completedFileItems:new Set(),userRejectedFileItems:new Set(),
          taskConstraints:normalizeTaskConstraints({operation:'write',wordCountScope:'new_writing',minBodyCjk:1500,maxBodyCjk:2000,wordCountToleranceRatio:0})};
        service.runRecords.set(draft.runId,{...record,runId:draft.runId,version:1,status:'running',preparationStage:undefined});service.activeRuns.set(draft.runId,draft);
        await service._checkpointRun(draft.runId);
        const resourceRef='chapter:chapter-00'+(6+index)+'.md',content='稿'.repeat(count)+'\n';
        const candidate=await prepareNovelPatch({changes:[{resourceRef,content}]},{novel,novelDir:novel.dir,expectedRunId:draft.runId});
        draft.preparationStage={version:1,revision:2,phase:'prepared',candidate:{preparationId:candidate.preparationId,revision:candidate.preparationRevision}};
        await stage.commitInput(service,draft);assert.equal(draft.preparationStage.phase,'native_commit');
        const file=require('../src/main/codex-runtime/nativeNovelWorkspace').resourceRelativePath(resourceRef);
        const changes=[{resourceRef,path:file,kind:{type:'add'},diff:content}];
        const itemId='native-draft-'+count;
        const approving=service._handleServerRequest('item/fileChange/requestApproval',{threadId:draft.threadId,itemId,fileChanges:changes});
        while(![...service.pendingConfirmations.values()].some(p=>p.run.runId===draft.runId))await new Promise(r=>setTimeout(r,10));
        const confirmationId=[...service.pendingConfirmations].find(([,p])=>p.run.runId===draft.runId)[0];
        await service.resolveConfirmation({confirmationId,accept:true});assert.equal((await approving).decision,'accept');
        await fs.writeFile(path.join(workspace.root,file),content);await service._commitNativeWorkspace(draft,itemId,changes);
        assert.equal((await readResource(novel,resourceRef)).content,content);
        const result=await service._evaluateTaskResult(draft,true);
        assert.equal(result.persistence.status,'saved');assert.equal(result.goalVerified,false);assert.deepEqual(result.objective.unmet,['word_count']);
        assert.equal(result.checks.wordCount.actual,count);assert.equal(result.checks.wordCount.acceptedMinimum,1500);assert.equal(result.checks.wordCount.acceptedMaximum,2000);assert.equal(result.checks.wordCount.blocking,false);
        assert.equal(result.checks.wordCount.status,index===0?'below_target':'over_target');
        assert.equal(draft.preparationStage.phase,'readback_complete');
        service.activeRuns.delete(draft.runId);
      }
    });
    await test('new process recovery retains candidate material but invalidates running stage and approvals',async()=>{
      await service._checkpointRun(run.runId);
      const recovery=new CodexSessionService();
      await recovery._recoverRuns();
      const recovered=await runs.get(run.runId);
      assert.equal(recovered.status,'interrupted');assert.equal(recovered.preparationStage.phase,'interrupted');
      assert.ok(recovered.writingPreparations[frozen.preparationId]);assert.equal(recovered.confirmation,null);
      recovery.stopNarrativeReviewJobs();
    });
    console.log('writing-preparation-stage: ok ('+checks+' scenarios)');
  } finally { service.stopNarrativeReviewJobs(); await fs.rm(root,{recursive:true,force:true}); }
}
main().catch(e=>{console.error(e);process.exitCode=1});
