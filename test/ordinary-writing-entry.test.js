'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
async function main(){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'mana-ordinary-writing-'));
  process.env.MANA_USER_DATA_ROOT=path.join(root,'data');
  const {CodexSessionService}=require('../src/main/codex-runtime/codexSessionService');
  const data=require('../src/main/store/novelData'),history=require('../src/main/store/chatHistory');
  const runs=require('../src/main/store/chatRuns');
  const novel=await require('../src/main/store/novels').createNovel({title:'普通入口阶段',dir:path.join(root,'novel')});
  await data.writeCharacter(novel.dir,{id:'lin',name:'林岚'});
  await data.writeCharacterMemory(novel.dir,{characterId:'lin',factsKnown:[{id:'original',summary:'旧事实'}]});
  await data.writeChapterWithMeta(novel.dir,'chapter-001.md','前章原文。',{}, {baseContent:''});
  await data.writeWorld(novel.dir,{lore:'原始世界。'});
  const route={connection:{kind:'api'},model:{id:'selected-model',verification:{tools:'ok'}},reasoningEffort:'medium'};
  require('../src/main/modelConfig').activeRoute=async()=>route;
  const service=new CodexSessionService();
  service.processManager={workspacesDirectory:path.join(root,'workspaces'),request:async()=>({}),stop:async()=>{}};
  service._ensureProcess=async()=>service.processManager;
  service._bindConversation=async(_route,payload)=>'native-'+payload.runId;
  let calls=[],preparedContext,mode='normal';
  const checkpoint=service._checkpointRun.bind(service);
  service._checkpointRun=async runId=>{
    await checkpoint(runId);
    if(mode==='prepared-stop'&&service.activeRuns.get(runId)?.preparationStage?.phase==='prepared')await service.interrupt({runId});
  };
  service.runOneShot=async options=>{
    calls.push(options.purpose);
    assert.equal(options.route,route);
    if(options.purpose==='task_intent')return {...require('./fixtures/fake-responses-server').taskIntentFixture([{text:options.text}]),modelId:route.model.id};
    if(options.purpose==='writing_candidate_review'){
      const bundle=JSON.parse(options.text.slice(options.text.indexOf('\n')+1));
      await options.onStarted({runId:'review-'+options.parentRunId,threadId:'review-thread',turnId:'review-turn',modelId:route.model.id,purpose:options.purpose});
      const first=mode==='hard-empty'&&calls.filter(purpose=>purpose==='writing_candidate_review').length===1;
      const target=bundle.sources.find(source=>source.resourceRef===bundle.targets[0]);
      return {text:JSON.stringify({issues:first?[{affectedResourceRefs:[target.resourceRef],category:'world',severity:'hard',contradiction:'协议夹具：保留同一已知硬问题',evidence:[{citationId:target.lines.find(line=>line.citationId).citationId}]}]:[],resolutions:[],reviews:bundle.targets.map(resourceRef=>({resourceRef,aspects:['timeline','viewpoint','character','world','style','format'],conclusion:'仅验证阶段接口',limitations:[]}))}),modelId:route.model.id,threadId:'review-thread',turnId:'review-turn'};
    }
    if(options.purpose==='writing_revision') {
      await options.onStarted({runId:'revision-'+options.parentRunId,threadId:'revision-thread',turnId:'revision-turn',modelId:route.model.id,purpose:options.purpose});
      const changes=[{resourceRef:'chapter:chapter-002.md',content:'稿'.repeat(mode==='still-short'?8:12)}];
      if(mode==='partial')changes.push({resourceRef:'character-memory:lin',memoryAppend:{factsKnown:[{summary:'本场新增见闻'}],lastUpdatedChapterRef:'chapter:chapter-002.md'}});
      return {text:JSON.stringify({participantCharacterRefs:['character:lin'],narrativePerspective:null,changes})};
    }
    assert.equal(options.purpose,'writing_preparation');assert.equal(options.readOnly,true);
    assert.equal(options.novelId,undefined,'preparation has no project tools');
    preparedContext=JSON.parse(options.text.slice(options.text.lastIndexOf('\n')+1));
    assert.equal(preparedContext.mode,'writing_context');
    await options.onStarted({runId:'child-'+options.parentRunId,threadId:'child-thread',turnId:'child-turn',modelId:route.model.id,purpose:options.purpose});
    if(mode==='stopped')await service.interrupt({runId:options.parentRunId});
    if(mode==='invalid')return {text:'作者提前结束，没有结构化候选。'};
    const target=mode==='edit'?'chapter:chapter-001.md':'chapter:chapter-002.md';
    return {text:JSON.stringify({participantCharacterRefs:mode==='edit'?[]:['character:lin'],narrativePerspective:null,changes:[mode==='edit'?{resourceRef:target,replacements:[{oldText:'前章原文。',newText:'前章修改。',all:false}]}:{resourceRef:target,content:mode==='excess'?'稿'.repeat(22):['length','still-short'].includes(mode)?'稿'.repeat(8):'新章正文。'}]})};
  };
  service._startNativeTurn=async params=>{calls.push('native_commit');assert.match(params.input[0].text,/已冻结的候选/u);assert.equal(params.model,route.model.id);assert.equal(params.effort,'medium');return {turn:{id:'commit-turn'}};};
  let count=0;
  async function start(id,text,extra={}){
    const thread=await history.createThread({title:id,novelId:novel.id});
    return service.startTurn({runId:id,conversationId:thread.id,persistence:'chat',userMessageId:'user-'+id,novelId:novel.id,text,...extra});
  }
  async function test(name,fn){calls=[];await fn();count++;console.log('PASS ordinary-entry '+name);}
  const finish=async id=>service._finalizeRun(service.activeRuns.get(id),{type:'turn_interrupted',runId:id});
  try{
    await test('ordinary new writing dispatches one read-only preparation and one frozen native commit on selected route',async()=>{
      await start('normal','传统写作模式写下一章，只让林岚参与，先读取前章与角色资料。');
      assert.deepEqual(calls,['task_intent','writing_preparation','native_commit']);
      const run=service.activeRuns.get('normal');assert.equal(run.preparationStage.phase,'native_commit');
      assert.equal(service.projectRuns.get(novel.id),run.runId);
      assert.ok(preparedContext.sharedSources.some(source=>source.resourceRef==='chapter:chapter-001.md'));
      const record=await runs.get(run.runId);assert.ok(record.writingPreparations[run.preparationStage.candidate.preparationId]);
      assert.equal(record.preparationStage.execution.modelId,route.model.id);
      await assert.rejects(fs.stat(path.join(novel.dir,'chapters/chapter-002.md')),e=>e.code==='ENOENT');
      assert.deepEqual(run.taskConstraints.participantCharacterRefs,['character:lin']);
      await finish(run.runId);
    });
    await test('ordinary exact editing receives real original target and preserves the same preparation identity',async()=>{
      mode='edit';await start('edit','修改 chapter:chapter-001.md，只把“前章原文。”改成“前章修改。”');
      const run=service.activeRuns.get('edit');
      const material=(await runs.get(run.runId)).writingPreparations[run.preparationStage.candidate.preparationId];
      assert.equal(material.contents['chapter:chapter-001.md'],'前章修改。\n');
      assert.equal(await data.readChapter(novel.dir,'chapter-001.md'),'前章原文。');
      await finish(run.runId);mode='normal';
    });
    await test('changing a nonwritten world dependency invalidates the candidate before native approval',async()=>{
      await start('dependency','写下一章。');const run=service.activeRuns.get('dependency');
      const material=(await runs.get(run.runId)).writingPreparations[run.preparationStage.candidate.preparationId];
      await data.writeWorld(novel.dir,{lore:'并发新世界。'});
      const evidence=material.expectedResources.map(r=>({resourceRef:r.resourceRef,afterHash:r.mirrorHash,beforeHash:require('../src/main/codex-runtime/contracts').hash(null)}));
      await assert.rejects(require('../src/main/codex-runtime/writingPreparationStage').assertCommitCandidate(run,evidence),e=>e.code==='preparation_dependency_changed');
      assert.equal(await data.readChapter(novel.dir,'chapter-001.md'),'前章原文。');
      await finish(run.runId);
    });
    await test('stopping preparation prevents commit, keeps interrupted task and releases project ownership',async()=>{
      mode='stopped';await assert.rejects(start('stopped','写下一章。'),e=>e.code==='turn_interrupted');
      assert.deepEqual(calls,['task_intent','writing_preparation']);
      assert.equal((await service.getRunState({runId:'stopped'})).status,'interrupted');
      assert.equal(service.projectRuns.has(novel.id),false);assert.equal(service.intentControllers.size,0);
    });
    await test('unstructured early output fails honestly without a second author or native commit',async()=>{
      mode='invalid';await assert.rejects(start('invalid','写下一章。'),SyntaxError);
      assert.deepEqual(calls,['task_intent','writing_preparation']);
      assert.equal((await service.getRunState({runId:'invalid'})).status,'failed');
      assert.equal(service.projectRuns.has(novel.id),false);
    });
    await test('stopping during the prepared checkpoint cannot publish preparation completion or dispatch commit',async()=>{
      mode='prepared-stop';const events=[];const listener=event=>events.push(event.type);service.on('event',listener);
      try{await assert.rejects(start('prepared-stop','写下一章。'),e=>e.code==='turn_interrupted');}finally{service.off('event',listener);}
      assert.deepEqual(calls,['task_intent','writing_preparation']);assert.equal(events.includes('writing_preparation_completed'),false);
      assert.equal((await service.getRunState({runId:'prepared-stop'})).status,'interrupted');
    });
    await test('one directed revision follows exact count feedback, keeps candidate ID, and reviews each canonical version once',async()=>{
      mode='length';await start('length','写下一章，正文10—20字，写后自查。');
      assert.deepEqual(calls,['task_intent','writing_preparation','writing_candidate_review','writing_revision','writing_candidate_review','native_commit']);
      const run=service.activeRuns.get('length'),record=await runs.get('length');
      assert.equal(Object.keys(record.writingPreparations).length,1);assert.equal(run.preparationStage.candidate.revision,2);
      const material=record.writingPreparations[run.preparationStage.candidate.preparationId];
      assert.equal(material.contents['chapter:chapter-002.md'],'稿'.repeat(12)+'\n');
      assert.equal(run.preparationStage.revisionCount,1);assert.equal(run.narrativeReview.source,'candidate');
      assert.equal(run.items.filter(item=>item.type==='writingCandidateReview').length,2);
      assert.ok(run.reviewSubmission.coverageHashes.some(source=>source.resourceRef==='chapter:chapter-002.md'&&source.hash===material.expectedResources[0].hash));
      await finish(run.runId);
    });
    await test('still-short revision reaches normal approval without another generation or relaxed target',async()=>{
      mode='still-short';await start('still-short','写下一章，正文10—20字。');const run=service.activeRuns.get('still-short');
      assert.deepEqual(calls,['task_intent','writing_preparation','writing_revision','native_commit']);
      assert.equal(run.taskConstraints.minBodyCjk,10);assert.equal(run.taskConstraints.wordCountToleranceRatio,0);
      assert.equal(run.preparationStage.phase,'native_commit');await finish(run.runId);
    });
    await test('over_target feedback also triggers the one revision instead of silently saving the excessive initial candidate',async()=>{
      mode='excess';await start('excess','写下一章，正文10—20字。');const run=service.activeRuns.get('excess');
      assert.deepEqual(calls,['task_intent','writing_preparation','writing_revision','native_commit']);
      assert.equal(run.preparationStage.candidate.revision,2);assert.equal(run.preparationStage.revisionCount,1);await finish(run.runId);
    });
    await test('an empty second candidate review cannot erase the initial hard finding',async()=>{
      mode='hard-empty';await start('hard-empty','写下一章，写后自查，修好后交付。');const run=service.activeRuns.get('hard-empty');
      assert.equal(calls.filter(purpose=>purpose==='writing_revision').length,1);
      assert.equal(calls.filter(purpose=>purpose==='writing_candidate_review').length,2);
      assert.equal(run.reviewFindings.length,1);assert.equal(run.reviewFindings[0].requestedSeverity,'hard');assert.equal(run.reviewFindings[0].status,'open');
      await finish(run.runId);
    });
    await test('one revision can fill an omitted required memory using the delivered original version',async()=>{
      mode='partial';await start('partial','写下一章，只让林岚参与，将新增见闻写入记忆，与正文同批保存，保留原始记忆。');const run=service.activeRuns.get('partial');
      assert.deepEqual(calls,['task_intent','writing_preparation','writing_revision','native_commit']);
      const record=await runs.get(run.runId),material=record.writingPreparations[run.preparationStage.candidate.preparationId];
      assert.equal(Object.keys(record.writingPreparations).length,1);assert.equal(material.expectedResources.length,2);
      assert.ok(material.changes.find(change=>change.resourceRef==='character-memory:lin').baseHash);
      assert.equal((await data.readCharacterMemory(novel.dir,'lin')).factsKnown.length,1);await finish(run.runId);
    });
    await test('a dependency changed after preparation is checked again inside the common formal transaction',async()=>{
      const mutation=require('../src/main/mcp/mutationService'),ref='world:lore';
      const source=await require('../src/main/mcp/novelResources').readResource(novel,ref);
      const prepared=await mutation.prepareChanges(novel,{reason:'验证提交前依赖冲突',changes:[{resourceRef:'chapter:chapter-race.md',mode:'create',content:'不能写入。'}]});
      prepared.dependencies=[{resourceRef:ref,hash:source.sourceHash}];
      await data.writeWorld(novel.dir,{lore:'最后一刻的用户修改。'});
      await assert.rejects(mutation.applyPrepared(novel,prepared),e=>e.code==='preparation_dependency_changed');
      await assert.rejects(fs.stat(path.join(novel.dir,'chapters/chapter-race.md')),e=>e.code==='ENOENT');
      assert.equal((await data.readWorld(novel.dir)).lore,'最后一刻的用户修改。');
    });
    await test('discussion, reading, role simulation and structured inline calls retain their contracts',async()=>{
      const ordinary=require('../src/main/codex-runtime/ordinaryWriting');
      for(const operation of ['read','review','unspecified','roleplay'])assert.equal(ordinary.shouldPrepare({persistence:'chat'},{operation}),false);
      assert.equal(ordinary.shouldPrepare({persistence:'one-shot'},{operation:'write'}),false);
      assert.equal(ordinary.shouldPrepare({persistence:'chat',outputSchema:{}},{operation:'write'}),false);
      assert.equal(ordinary.shouldPrepare({persistence:'chat',skillName:'mana-character-roleplay'},{operation:'write'}),false);
      assert.equal(ordinary.shouldPrepare({persistence:'chat',continuation:{savedResources:[{resourceRef:'chapter:a.md'}],unmet:['review_evidence_missing']}},{operation:'write'}),false);
      assert.equal(ordinary.shouldPrepare({persistence:'chat',text:'继续未完成任务',continuation:{savedResources:[{resourceRef:'chapter:a.md'}],unmet:['hard_issues_unresolved']}},{operation:'write',wordCountScope:'new_writing'}),false);
      assert.equal(ordinary.shouldPrepare({persistence:'chat',text:'只写一段虚构场景，不读取项目资料。'},{operation:'write'}),false);
      assert.equal(ordinary.shouldPrepare({persistence:'chat',text:'使用写作 Skill 检查当前项目。',skillName:'mana-fiction-writing'},{operation:'write'}),false);
      assert.equal(ordinary.shouldPrepare({persistence:'chat',text:'写下一章，不保存。'},{operation:'write',wordCountScope:'new_writing'}),false);
    });
  }finally{await service.dispose();await fs.rm(root,{recursive:true,force:true});}
  console.log(`ordinary-writing-entry: ok (${count} scenarios)`);
}
main().catch(error=>{console.error(error);process.exitCode=1;});
