'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
async function main(){
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'mana-intent-context-'));process.env.MANA_USER_DATA_ROOT=path.join(temp,'data');
 const data=require('../src/main/store/novelData');
 const {readResource}=require('../src/main/mcp/novelResources');
 const {deriveRequirements,bindRequirements}=require('../src/main/codex-runtime/taskRequirements');
 const {intentInput,bindTaskIntent}=require('../src/main/codex-runtime/taskIntent');
 const {bindCandidateScope}=require('../src/main/codex-runtime/writingScope');
 const {getToolByName}=require('../src/main/mcp/tools');
 const {syncNativeNovelWorkspace}=require('../src/main/codex-runtime/nativeNovelWorkspace');
 const runs=require('../src/main/store/chatRuns');
 const {assessReview,mergeReviewFindings}=require('../src/main/codex-runtime/reviewLedger');
 const {evaluateTaskResult}=require('../src/main/codex-runtime/taskCompletion');
 const ref='chapter:chapter-001.md';let count=0;
 const test=async(name,fn)=>{await fn();count++;console.log('PASS intent-context '+name)};
 try {
  const entry=await require('../src/main/store/novels').createNovel({title:'意图绑定反例',dir:path.join(temp,'novel')});
  await data.writeChapterWithMeta(entry.dir,'chapter-001.md','20:24，她开始等七分半。\n\n20:28，她起身。',{}, {baseContent:''});
  for(const [id,name] of [['a','阿青'],['b','阿白'],['c','阿赤']]){await data.writeCharacter(entry.dir,{id,name});await data.writeCharacterMemory(entry.dir,{characterId:id,factsKnown:[{id:id+'-secret',summary:name+'自己的秘密'}]});}
  await data.writeWorld(entry.dir,{lore:'东门朝东。\n\n西门朝西。'});
  const text='写下一章，只让阿青和阿白参与，以阿青为第三人称有限视角，读取全部角色卡及各自主观记忆和世界观，更新两人的记忆，正文与记忆同批保存，写后自查。';
  const payload=await deriveRequirements({text});await bindRequirements(entry,payload.taskConstraints,text);
  const input=await intentInput(entry,text,payload.taskConstraints);
  await test('addressable missing outline resources cannot become mandatory reads',async()=>{
   assert.ok(!input.descriptors.some(r=>r.resourceRef==='outline:nodes'));
   assert.ok(!input.schema.properties.requiredReadResourceRefs.items.enum.includes('outline:nodes'));
   assert.throws(()=>bindTaskIntent(payload.taskConstraints,{missingRequestedSources:['outline:nodes']},{text:text+'，读取 outline:nodes',descriptors:input.descriptors}),e=>e.code==='task_sources_unavailable');
  });
  const manifest=input.descriptors.filter(r=>['character','character-memory','world'].includes(r.kind)).map(r=>r.resourceRef);
  const interpreted={participants:{selection:'specified',characterRefs:['character:a','character:b'],requestQuote:'只让阿青和阿白参与'},perspective:{mode:'limited',focusCharacterRef:'character:a',requestQuote:'以阿青为第三人称有限视角'},requiredReadResourceRefs:manifest,memoryUpdateRequired:true,atomicMemoryWithChapter:true,preserveOriginalMemories:false,reviewAspects:['timeline','viewpoint']};
  const c=bindTaskIntent(payload.taskConstraints,interpreted,{text,descriptors:input.descriptors,modelId:'fixture'});
  await test('R2-1 user participants bind before the author and reject a same-sized substitute',async()=>{
   assert.deepEqual(c.requiredWriteResourceRefs,['character-memory:a','character-memory:b']);
   await assert.rejects(bindCandidateScope(entry,c,{participantCharacterRefs:['character:a','character:c'],resourceRefs:[]}),e=>e.code==='task_scope_changed');
   assert.deepEqual((await bindCandidateScope(entry,c,{participantCharacterRefs:['character:a','character:b'],resourceRefs:[]})).participantCharacterRefs,['character:a','character:b']);
  });
  await test('intent identities and quoted user instructions are validated against the project',async()=>{
   const bad=structuredClone(interpreted);bad.perspective.requestQuote='用户没说过';assert.throws(()=>bindTaskIntent(c,bad,{text,descriptors:input.descriptors}),e=>e.code==='task_intent_invalid');
   bad.perspective.requestQuote=interpreted.perspective.requestQuote;bad.requiredReadResourceRefs=['character:other-project'];assert.throws(()=>bindTaskIntent(c,bad,{text,descriptors:input.descriptors}),e=>e.code==='task_intent_invalid');
  });
  await test('separate character reactions have no single narrative focal character',async()=>{
   const request='读取各自记忆，分别写三人的即时反应，不保存。';
   const raw={...interpreted,participants:{selection:'all',characterRefs:['character:a','character:b','character:c'],requestQuote:'分别写三人的即时反应'},perspective:{mode:'per_character',focusCharacterRef:null,requestQuote:'分别写三人的即时反应'},memoryUpdateRequired:false,atomicMemoryWithChapter:false};
   const bound=bindTaskIntent({operation:'read'},raw,{text:request,descriptors:input.descriptors});
   assert.equal(bound.narrativePerspective,null);assert.equal(bound.intentBinding.perspectiveSelection,'per_character');assert.equal(bound.memoryUpdateRequired,false);
   assert.throws(()=>bindTaskIntent({operation:'read'},{...raw,perspective:{...raw.perspective,focusCharacterRef:'character:a'}},{text:request,descriptors:input.descriptors}),e=>e.code==='task_intent_invalid');
  });
  await test('unrecognized operation is semantically bound with a user quote rather than skipped',async()=>{
   const request='只让阿青和阿白参与，读取两人记忆，分别作答，不保存。';
   const payload=await deriveRequirements({text:request});assert.equal(payload.taskConstraints.operation,'unspecified');
   const raw={...interpreted,operation:'read',operationRequestQuote:'读取两人记忆',perspective:{mode:'per_character',focusCharacterRef:null,requestQuote:'分别作答'},memoryUpdateRequired:false,atomicMemoryWithChapter:false};
   const bound=bindTaskIntent(payload.taskConstraints,raw,{text:request,descriptors:input.descriptors});assert.equal(bound.operation,'read');assert.equal(bound.intentBinding.operation,'read');
   assert.throws(()=>bindTaskIntent(payload.taskConstraints,{...raw,operationRequestQuote:'用户没有说过'},{text:request,descriptors:input.descriptors}),e=>e.code==='task_intent_invalid');
  });
  await test('version-one derived read manifests are rebuilt from the original request',async()=>{
   const migrated=bindTaskIntent({...c,intentBinding:{...c.intentBinding,version:1},requiredReadResourceRefs:['outline:nodes']},interpreted,{text,descriptors:input.descriptors});
   assert.equal(migrated.intentBinding.version,2);assert.ok(!migrated.requiredReadResourceRefs.includes('outline:nodes'));assert.deepEqual(migrated.participantCharacterRefs,['character:a','character:b']);
  });
  const workspace=await syncNativeNovelWorkspace(entry,path.join(temp,'workspaces'));
  const snapshot={runId:'intent-running',novelId:entry.id,status:'running',version:1,workspaceRoot:workspace.root,taskConstraints:{...c,atomicMemoryWithChapter:false},memoryBaselines:{},items:[],savedResources:[]};await runs.save(snapshot);
  const ctx={novel:entry,novelDir:entry.dir};
  await test('R2-2 the first candidate cannot change user limited POV to omniscient',async()=>{
   await assert.rejects(getToolByName('prepare_novel_patch').handler({narrativePerspective:{mode:'omniscient',focusCharacterRef:null},changes:[{resourceRef:'chapter:chapter-002.md',content:'全知叙述。'}]},ctx),e=>e.code==='narrative_perspective_changed');
  });
  await test('candidate length feedback counts the new draft rather than existing book text',async()=>{
   snapshot.taskConstraints.minBodyCjk=10;snapshot.taskConstraints.maxBodyCjk=20;snapshot.taskConstraints.wordCountToleranceRatio=0;snapshot.version++;await runs.save(snapshot);
   const result=await getToolByName('prepare_novel_patch').handler({changes:[{resourceRef:'chapter:chapter-002.md',content:'新'.repeat(8)}]},ctx);
   assert.equal(result.structuredContent.candidateChecks.wordCount.actual,8);assert.equal(result.structuredContent.candidateChecks.wordCount.status,'below_target');assert.equal(result.structuredContent.candidateChecks.wordCount.belowBy,2);
   await assert.rejects(fs.stat(path.join(workspace.root,'chapters/chapter-002.md')),e=>e.code==='ENOENT');
   snapshot.taskConstraints.minBodyCjk=null;snapshot.taskConstraints.maxBodyCjk=null;snapshot.version++;await runs.save(snapshot);
  });
  let contextItem;
  await test('R2-3 one real context read delivers every bound source with separate actor memories',async()=>{
   const result=await getToolByName('read_writing_context').handler({},ctx);contextItem={tool:'read_writing_context',status:'completed',result};
   const value=result.structuredContent;assert.equal(value.actors.length,3);assert.equal(value.actors[0].subjectiveMemory.resourceRef,'character-memory:a');
   assert.ok(!value.actors[0].subjectiveMemory.content.includes('阿白自己的秘密'));
   const resources=await Promise.all(manifest.map(r=>readResource(entry,r)));
   const read=require('../src/main/codex-runtime/readEvidence').completeReadRefs([contextItem],resources);assert.equal(read.size,manifest.length);
   assert.equal(require('../src/main/mcp/readVersionReceipts').readVersion(snapshot.runId,'character-memory:a'),resources.find(r=>r.resourceRef==='character-memory:a').sourceHash);
  });
  await test('review delivery cannot substitute for author reading in a writing task',async()=>{
   const delivery={type:'reviewSourceDelivery',origin:'host',status:'completed',result:{structuredContent:{resourceRef:'character:a',mode:'content',hash:(await readResource(entry,'character:a')).sourceHash,content:(await readResource(entry,'character:a')).content}}};
   const result=await evaluateTaskResult({entry,taskConstraints:{operation:'write',requiredReadResourceRefs:['character:a']},items:[delivery]},true);
   assert.ok(result.objective.unmet.includes('required_reads_missing'));
   const readResult=await evaluateTaskResult({entry,taskConstraints:{operation:'write',requiredReadResourceRefs:manifest},items:[contextItem]},true);assert.deepEqual(readResult.checks.requiredReads.missingResourceRefs,[]);
  });
  await test('R2-4 time-only edits and persisted legacy scopes retain the review obligation',async()=>{
   const p=await deriveRequirements({text:'修改当前章节的时间错误，写后自查，修好再交付。',editorContext:{resourceRef:ref}});await bindRequirements(entry,p.taskConstraints,p.text);assert.equal(p.taskConstraints.narrativeAuditRequired,true);
   p.taskConstraints.narrativeAuditRequired=false;await bindRequirements(entry,p.taskConstraints,'继续');assert.equal(p.taskConstraints.narrativeAuditRequired,true);
  });
  await test('writing input reads survive own memory updates without substituting for current-version review',async()=>{
   const ref='character-memory:b',before=await readResource(entry,ref),memory=JSON.parse(before.content);
   memory.factsKnown.push({id:'scene-new',summary:'本场听见敲门'});await data.writeCharacterMemory(entry.dir,memory);
   const current=await readResource(entry,ref),commit={resourceRef:ref,oldHash:before.sourceHash,newHash:current.sourceHash,mode:'replace'};
   const run={entry,taskConstraints:{operation:'write',requiredReadResourceRefs:[ref]},items:[contextItem],committedResources:[commit]};
   assert.deepEqual((await evaluateTaskResult(run,true)).checks.requiredReads.missingResourceRefs,[]);
   assert.deepEqual((await evaluateTaskResult({...run,committedResources:[{...commit,oldHash:'unrelated'}]},true)).checks.requiredReads.missingResourceRefs,[ref]);
   assert.deepEqual((await evaluateTaskResult({...run,taskConstraints:{...run.taskConstraints,operation:'review'}},true)).checks.requiredReads.missingResourceRefs,[ref]);
   const reads=require('../src/main/codex-runtime/readEvidence');
   const fragment={tool:'read_novel_resource',status:'completed',result:{structuredContent:{resourceRef:ref,mode:'content',hash:before.sourceHash,offset:0,content:before.content.slice(0,8)}}};
   assert.equal(reads.readBeforeOwnWrites([fragment],[commit]).size,0);
   const cut=Buffer.byteLength(before.content.slice(0,8)),rest={...fragment,result:{structuredContent:{...fragment.result.structuredContent,offset:cut,content:before.content.slice(8)}}};
   assert.ok(reads.readBeforeOwnWrites([fragment,rest],[commit]).has(ref));
  });
  const contentItem=async r=>{const source=await readResource(entry,r);return {tool:'read_novel_resource',status:'completed',result:{structuredContent:{resourceRef:r,mode:'content',hash:source.sourceHash,content:source.content,offset:0}}};};
  const report=issues=>'```json\n'+JSON.stringify({coveredResourceRefs:[ref],issues})+'\n```';
  const initial=await readResource(entry,ref);
  const issue={issueId:'timeline:wait:window',category:'timeline',severity:'hard',status:'open',contradiction:'四分钟窗口容不下七分半等待。',evidence:[{resourceRef:ref,quote:'20:24，她开始等七分半。'},{resourceRef:ref,quote:'20:28，她起身。'}]};
  const before=await assessReview(entry,{items:[await contentItem(ref)],text:report([issue])});const previous=mergeReviewFindings([],before);
  await test('a single actual quotation can support a self-contained hard conflict',async()=>{
   const one=await assessReview(entry,{items:[await contentItem(ref)],text:report([{...issue,evidence:[issue.evidence[0]]}])});assert.equal(one.evidenceVerified,true);
  });
  await test('R2-5 extra true evidence cannot promote suspicion to a repair blocker',async()=>{
   const row=await assessReview(entry,{items:[await contentItem(ref)],text:report([{...issue,severity:'suspicion'}])});
   const result=await evaluateTaskResult({entry,taskConstraints:{operation:'edit',targetResourceRefs:[ref],reviewRequired:true,repairRequired:true},items:[await contentItem(ref)],text:'检查意见',committedResources:[{resourceRef:ref,newHash:initial.sourceHash,mode:'replace'}],reviewRecord:row},true);assert.equal(result.goalVerified,true);
  });
  const closure={...issue,status:'closed',resolution:{kind:'fixed',explanation:'已修复。',changes:[{beforeEvidenceIndex:0,after:{resourceRef:ref,quote:'20:24，她开始等七分半。'}}]}};
  await data.writeChapterWithMeta(entry.dir,'chapter-001.md','# 新标题\n\n'+initial.content,{}, {baseContent:initial.content});
  await test('R2-6 title-only changes cannot close the original time conflict even in an independent review',async()=>{
   const current=await readResource(entry,ref);
   for(const resolutionAuthority of [undefined,'independent_review']){
    const row=await assessReview(entry,{items:[await contentItem(ref)],text:report([closure]),reviewFindings:previous,committedResources:[{resourceRef:ref,newHash:current.sourceHash}],resolutionAuthority});assert.equal(row.evidenceVerified,false);
   }
  });
  await test('a real anchor correction can close after independent reassessment, while self-certification cannot',async()=>{
   const old=await readResource(entry,ref);await data.writeChapterWithMeta(entry.dir,'chapter-001.md',old.content.replace('七分半','三分钟'),{}, {baseContent:old.content});
   const current=await readResource(entry,ref),fixed={...closure,evidence:issue.evidence.map(e=>({...e,quote:e.quote.replace('七分半','三分钟')})),resolution:{kind:'fixed',explanation:'耗时改为三分钟，四分钟窗口可容纳。',changes:[{beforeEvidenceIndex:0,after:{resourceRef:ref,quote:'20:24，她开始等三分钟。'}}]}};
   const context={items:[await contentItem(ref)],text:report([fixed]),reviewFindings:previous,committedResources:[{resourceRef:ref,newHash:current.sourceHash}]};
   assert.equal((await assessReview(entry,context)).evidenceVerified,false);
   const row=await assessReview(entry,{...context,resolutionAuthority:'independent_review'});assert.equal(row.evidenceVerified,true);assert.equal(mergeReviewFindings(previous,row)[0].status,'closed');
  });
  await test('R2-7 unrelated citations cannot move a known open issue out of the affected chapter',async()=>{
   const world=await readResource(entry,'world:lore');const moved={...issue,evidence:[{resourceRef:'world:lore',quote:'东门朝东。'},{resourceRef:'world:lore',quote:'西门朝西。'}],affectedResourceRefs:['world:lore']};
   const row=await assessReview(entry,{items:[await contentItem(ref),await contentItem(world.resourceRef)],text:report([moved]),reviewFindings:previous});assert.equal(row.evidenceVerified,false);assert.ok(mergeReviewFindings(previous,row)[0].affectedResourceRefs.includes(ref));
  });
  await test('unresolved assessments retain one open issue; contradictory close/open dispositions fail explicitly',async()=>{
   const jobs=require('../src/main/codex-runtime/narrativeReviewJobs');const {normalizeTaskConstraints}=require('../src/main/codex-runtime/taskLedger');
   let calls=0,kind='unresolved',newIssues=false;
   const constraints=normalizeTaskConstraints({operation:'review',reviewRequired:true,narrativeAuditRequired:true,reviewTargetResourceRefs:[ref],reviewScope:'target_resources',targetResourceRefs:[ref]});
   const make=id=>({runId:id,entry,taskConstraints:constraints,items:[],reviewFindings:previous,memoryBaselines:{},text:'审查'});
   const first=make('unresolved-fixture');const service={activeRuns:new Map([[first.runId,first]]),_emitEvent(){},async _checkpointRun(){},emit(_type,error){throw error},async runOneShot(options){
    calls++;const view=JSON.parse(options.text.slice(options.text.indexOf('\n')+1));const citationId=view.sources.find(r=>r.resourceRef===ref).lines.find(line=>line.citationId).citationId;
    const assessment={issueId:previous[0].issueId,kind:'unresolved',explanation:'状态协议测试',evidence:[{citationId}],changes:[]};
    if(newIssues)return {modelId:'fixture',text:JSON.stringify({issues:['timeline','viewpoint'].map(category=>({affectedResourceRefs:[ref],category,severity:'suspicion',contradiction:category+'待核实',evidence:[{citationId}]})),resolutions:[],reviews:[{resourceRef:ref,aspects:['timeline','viewpoint'],conclusion:'只测试问题身份。',limitations:[]}]})};
    return {modelId:'fixture',text:JSON.stringify({issues:[],resolutions:kind==='unresolved'?[assessment]:[assessment,{...assessment,kind}],reviews:[{resourceRef:ref,aspects:['timeline'],conclusion:'本例只测试已知问题状态传输。',limitations:[]}]})};
   }};
   const stop=jobs.attachJobHost(service);
   try {
    const result=await jobs.requestReview(first,entry,{timeoutMs:3000});assert.equal(result.ok,true);assert.equal(result.report.issues.length,1);assert.equal(first.reviewFindings[0].status,'open');
    assert.equal((await jobs.requestReview(first,entry,{timeoutMs:3000})).key,result.key);assert.equal(calls,1);
    const identities={...make('new-identities-fixture'),reviewFindings:[]};service.activeRuns.set(identities.runId,identities);newIssues=true;
    const allocated=await jobs.requestReview(identities,entry,{timeoutMs:3000});assert.equal(allocated.ok,true);assert.equal(new Set(allocated.report.issues.map(i=>i.issueId)).size,2);assert.ok(allocated.report.issues.every(i=>i.issueId.startsWith('content:review:')));newIssues=false;
    const second=make('conflicting-disposition-fixture');kind='not_an_issue';service.activeRuns.set(second.runId,second);
    const rejected=await jobs.requestReview(second,entry,{timeoutMs:3000});assert.equal(rejected.ok,false);assert.equal(rejected.error,'review_issue_disposition_conflict');
   } finally {service.activeRuns.clear();stop();}
  });
 } finally {await fs.rm(temp,{recursive:true,force:true});}
 console.log('writing-intent-context: '+count+' scenarios passed');
}
main().catch(e=>{console.error(e);process.exitCode=1});
