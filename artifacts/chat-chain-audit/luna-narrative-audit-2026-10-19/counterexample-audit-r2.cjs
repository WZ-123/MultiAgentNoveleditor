'use strict';
// Second audit: unchanged production functions + isolated formal storage.
// The semantic responder and commit receipts are explicit fixtures, never live
// GPT results or evidence of native UI approval. No production source is edited.
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const fss=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const root=path.resolve(__dirname,'../../..');
const req=p=>require(path.join(root,p));
const results=[];
const report=(refs,issues=[])=>'```json\n'+JSON.stringify({coveredResourceRefs:refs,issues})+'\n```';
const evidence=(r,quote)=>({resourceRef:r.resourceRef,quote});
async function main(){
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'mana-counterexample-audit-r2-'));
 process.env.MANA_USER_DATA_ROOT=path.join(temp,'data');
 const data=req('src/main/store/novelData');
 const novels=req('src/main/store/novels');
 const runs=req('src/main/store/chatRuns');
 const {readResource}=req('src/main/mcp/novelResources');
 const {deriveRequirements,bindRequirements}=req('src/main/codex-runtime/taskRequirements');
 const {bindCandidateScope}=req('src/main/codex-runtime/writingScope');
 const {assessReview,mergeReviewFindings}=req('src/main/codex-runtime/reviewLedger');
 const {evaluateTaskResult}=req('src/main/codex-runtime/taskCompletion');
 const {syncNativeNovelWorkspace}=req('src/main/codex-runtime/nativeNovelWorkspace');
 const {prepareNovelPatch}=req('src/main/mcp/writingTools');
 const {buildBundle,requestReview,attachJobHost}=req('src/main/codex-runtime/narrativeReviewJobs');
 let sequence=0;
 const ref='chapter:chapter-001.md';
 async function fixture(content='阿青推开院门。\n'){
  const entry=await novels.createNovel({title:'反例复核'+(++sequence),dir:path.join(temp,'novel-'+sequence)});
  await data.writeChapterWithMeta(entry.dir,'chapter-001.md',content,{}, {baseContent:''});
  for(const [id,name] of [['a','阿青'],['b','阿白'],['c','阿赤']]){
   await data.writeCharacter(entry.dir,{id,name});
   await data.writeCharacterMemory(entry.dir,{characterId:id,factsKnown:[{id:id+'-old',summary:'只有'+name+'知道自己的口令。'}]});
  }
  await data.writeWorld(entry.dir,{lore:'东门朝东。\n\n西门朝西。'});
  return entry;
 }
 async function read(entry,ref){const r=await readResource(entry,ref);return {name:'read_novel_resource',status:'completed',result:{structuredContent:{resourceRef:ref,mode:'content',hash:r.sourceHash,content:r.content,offset:0}}};}
 async function constraints(entry,text,skillName){const p=await deriveRequirements({text,skillName,editorContext:{resourceRef:ref}});return bindRequirements(entry,p.taskConstraints,text);}
 async function editRun(entry,c){
  const r=await readResource(entry,ref);
  // Synthetic receipt is a test input. No claim of native approval is made.
  return {entry,runId:'edit-fixture-'+sequence,taskConstraints:c,items:[await read(entry,ref)],committedResources:[{resourceRef:ref,mode:'replace',newHash:r.sourceHash,nativeItemId:'synthetic-receipt'}],text:'完成检查。'};
 }
 async function assess(run,issues,previous=[]){return assessReview(run.entry,{...run,reviewFindings:previous,text:report([ref],issues)});}
 async function evaluate(run,row,previous=[]){return evaluateTaskResult({...run,reviewRecord:row,reviewFindings:previous},true);}
 async function test(id,description,fn){const detail=await fn();results.push({id,description,...detail});console.log('REPRODUCED '+id);}
 let stop;
 try {
  await test('R2-1','Named participant identities can be replaced by another same-sized set',async()=>{
   const entry=await fixture();const text='写下一章，只让阿青和阿白参与，更新两人的主观记忆，与正文同批保存。';
   const c=await constraints(entry,text,'mana-character-roleplay');
   const wrong=await bindCandidateScope(entry,c,{participantCharacterRefs:['character:a','character:c'],resourceRefs:['chapter:chapter-002.md','character-memory:a','character-memory:c']});
   assert.equal(wrong.memoryParticipantCount,2);assert.deepEqual(wrong.requiredWriteResourceRefs,['character-memory:a','character-memory:c']);
   const bound=await bindCandidateScope(entry,c,{participantCharacterRefs:['character:a','character:b'],resourceRefs:['chapter:chapter-002.md','character-memory:a','character-memory:b']});
   await assert.rejects(bindCandidateScope(entry,bound,{participantCharacterRefs:['character:a','character:c'],resourceRefs:[]}),e=>e.code==='task_scope_changed');
   return {scope:'natural request -> requirements -> production candidate binder; no prose/model',request:text,actual:{participants:wrong.participantCharacterRefs,requiredMemories:wrong.requiredWriteResourceRefs},positiveControl:'Changing an already bound a/b set to a/c is rejected. Initial user-specified identities remain unbound.'};
  });
  await test('R2-2','First prepared candidate can change requested limited POV to omniscient',async()=>{
   const entry=await fixture();const text='续写下一章，以阿青为第三人称有限视角，写完自查人物与世界观。';
   const c=await constraints(entry,text);assert.equal(c.narrativePerspective,null);
   const workspace=await syncNativeNovelWorkspace(entry,path.join(temp,'workspaces'));
   const snapshot={runId:'perspective-fixture',novelId:entry.id,status:'running',workspaceRoot:workspace.root,version:1,items:[],savedResources:[],taskConstraints:c};await runs.save(snapshot);
   const ctx={novel:entry,novelDir:entry.dir};
   const prepared=await prepareNovelPatch({changes:[{resourceRef:'chapter:chapter-002.md',content:'阿白想着自己的秘密。'}],narrativePerspective:{mode:'omniscient',focusCharacterRef:null}},ctx);
   assert.equal(prepared.ok,true);assert.equal(prepared.taskScope.narrativePerspective.mode,'omniscient');
   snapshot.taskConstraints={...c,narrativePerspective:{mode:'limited',focusCharacterRef:'character:a'}};snapshot.version++;await runs.save(snapshot);
   await assert.rejects(prepareNovelPatch({changes:[{resourceRef:'chapter:chapter-002.md',content:'新文。'}],narrativePerspective:{mode:'omniscient',focusCharacterRef:null}},ctx),e=>e.code==='narrative_perspective_changed');
   snapshot.status='completed';snapshot.version++;await runs.save(snapshot);
   return {scope:'natural request -> real isolated store + native workspace -> production prepare tool; no apply/approval',request:text,actual:{initialPerspective:c.narrativePerspective,accepted:prepared.taskScope.narrativePerspective},positiveControl:'A host-prebound limited perspective rejects the same change.'};
  });
  await test('R2-3','Reading one character and zero memories satisfies an all-character-and-memory review request',async()=>{
   const entry=await fixture();const text='审校当前章节的人物和世界观一致性，请读取全部角色卡及各自主观记忆，核对后只报告问题。';
   const c=await constraints(entry,text);
   const run={runId:'review-source-fixture',entry,taskConstraints:c,requestText:text,taskRequestText:text,items:await Promise.all([ref,'character:a','world:lore'].map(r=>read(entry,r))),committedResources:[],savedResources:[],reviewFindings:[],memoryBaselines:{},text:'审校结果。'};
   let delivered=[];let calls=0;
   const service={activeRuns:new Map([[run.runId,run]]),_emitEvent(){},async _checkpointRun(){},emit(type,error){throw error||new Error(type)},async runOneShot(options){
    calls++;const input=JSON.parse(options.text.slice(options.text.indexOf('\n')+1));delivered=input.sources.map(s=>s.resourceRef);
    const slots=options.outputSchema.properties.analysis.properties.units.required;
    return {text:JSON.stringify({analysis:{perspective:{mode:'limited',focusCharacterRef:'character:a'},units:Object.fromEntries(slots.map(id=>[id,'none'])),timeConclusion:'本例正文无显式时间约束。',timePoints:[],timeRelations:[],knowledge:[]},issues:[],resolutions:[]}),threadId:'fixture-readonly-thread',turnId:'fixture-readonly-turn',modelId:'deterministic-audit-fixture'};
   }};
   stop=attachJobHost(service);
   const hosted=await requestReview(run,entry,{timeoutMs:3000});assert.equal(hosted.ok,true);assert.equal(calls,1);
   run.reviewRecord=await assessReview(entry,{...run,text:'```json\n'+JSON.stringify(hosted.report)+'\n```',expectedCoverageHashes:hosted.coverageHashes});
   const outcome=await evaluateTaskResult(run,true);
   assert.equal(outcome.goalVerified,true);assert.ok(!delivered.includes('character:b'));assert.ok(!delivered.some(r=>r.startsWith('character-memory:')));
   const withoutWorld={...run,items:run.items.filter(i=>i.result?.structuredContent?.resourceRef!=='world:lore')};
   const badRow=await assessReview(entry,{...withoutWorld,text:report([ref])});
   const missing=await evaluateTaskResult({...withoutWorld,reviewRecord:badRow},true);
   assert.ok(missing.checks.review.missingSourceKinds.includes('world'));
   service.activeRuns.clear();stop();stop=null;
   return {scope:'production readonly queue/host + actual stored sources + deterministic semantic responder + final evaluator; no live GPT/UI',request:text,actual:{delivered,goalVerified:outcome.goalVerified,missingSourceKinds:outcome.checks.review.missingSourceKinds,narrativeAudit:outcome.checks.narrativeAudit.status},positiveControl:'Omitting the world resource entirely is rejected. Cardinality/identity/memory obligations are absent.'};
  });
  await test('R2-4','Editing with mandatory time review skips hosted narrative analysis',async()=>{
   const entry=await fixture('20:24，她开始等待七分半。\n\n20:28，她起身。\n');
   const text='修改当前章节的时间错误，写后自查，修好再交付。';const c=await constraints(entry,text);assert.equal(c.operation,'edit');assert.equal(c.reviewRequired,true);assert.equal(c.narrativeAuditRequired,false);
   const run=await editRun(entry,c);const row=await assess(run,[]);const outcome=await evaluate(run,row);assert.equal(outcome.goalVerified,true);
   const writing=await constraints(entry,'续写下一章，写后自查，修好再交付。');assert.equal(writing.narrativeAuditRequired,true);
   return {scope:'natural requirements + actual store/report assessment + final evaluator; empty review and commit receipt are explicit fixtures',request:text,actual:{operation:c.operation,repairRequired:c.repairRequired,narrativeAuditRequired:c.narrativeAuditRequired,goalVerified:outcome.goalVerified,knownContradictoryText:(await readResource(entry,ref)).content},positiveControl:'A write request with the same review/repair obligation requires hosted analysis.'};
  });
  await test('R2-5','A second genuine quote upgrades unresolved suspicion into a mandatory blocker',async()=>{
   const entry=await fixture('阿白说门开着。\n\n阿青说门锁着。\n');const c=await constraints(entry,'修改当前章节的错字，写后自查并报告有疑问的地方。');const run=await editRun(entry,c);const r=await readResource(entry,ref);
   const issue={issueId:'dialogue:door:disagreement',category:'人物说法差异',severity:'suspicion',status:'open',contradiction:'两个人物说法不同，可能是说谎或观察时刻不同，不能据此认定叙述矛盾。',evidence:[evidence(r,'阿白说门开着。')]};
   const one=await evaluate(run,await assess(run,[issue]));issue.evidence.push(evidence(r,'阿青说门锁着。'));const two=await evaluate(run,await assess(run,[issue]));
   assert.equal(one.goalVerified,true);assert.equal(two.goalVerified,false);assert.ok(two.objective.unmet.includes('review_findings_unresolved'));
   return {scope:'production report validation/merge/final evaluator with actual quotes; semantic judgement and commit receipt are fixtures',actual:{oneQuote:{goalVerified:one.goalVerified},twoQuotes:{goalVerified:two.goalVerified,unmet:two.objective.unmet}},positiveControl:'Both reports keep severity=suspicion and both quotation sets verify; only the quote count changes.'};
  });
  await test('R2-6','Changing only the title authenticates a false fixed closure of an unchanged time contradiction',async()=>{
   const body='20:24，她开始等待七分半。\n\n20:28，她起身。\n';const entry=await fixture(body);const c=await constraints(entry,'修改当前章节的时间错误，写后自查，修好再交付。');const beforeRun=await editRun(entry,c);const before=await readResource(entry,ref);
   const issue={issueId:'timeline:wait:window',category:'timeline',severity:'hard',status:'open',contradiction:'四分钟窗口容不下七分半等待。',evidence:[evidence(before,'20:24，她开始等待七分半。'),evidence(before,'20:28，她起身。')]};
   const open=await assess(beforeRun,[issue]);assert.equal(open.issues[0].verified,true);const previous=mergeReviewFindings([],open);
   const closed={...issue,status:'closed',resolution:{kind:'fixed',explanation:'已经修好时间冲突。'}};
   const unchanged=await assess(beforeRun,[closed],previous);assert.equal(unchanged.evidenceVerified,false);
   await data.writeChapterWithMeta(entry.dir,'chapter-001.md','# 新标题\n\n'+body,{}, {baseContent:before.content});
   const run=await editRun(entry,c);const row=await assess(run,[closed],previous);const outcome=await evaluate(run,row,previous);
   assert.equal(row.evidenceVerified,true);assert.equal(row.issues[0].resolutionVerified,true);assert.equal(outcome.goalVerified,true);
   assert.ok((await readResource(entry,ref)).content.includes(body));
   return {scope:'real isolated resource mutation/readback + production closure/merge/final evaluator; false closure statement and commit receipt are fixtures',actual:{unchangedClosureVerified:unchanged.evidenceVerified,titleOnlyClosureVerified:row.issues[0].resolutionVerified,goalVerified:outcome.goalVerified,contradictionStillPresent:true},positiveControl:'The same fixed closure with no resource hash change is rejected. Any unrelated hash change supplies the missing condition.'};
  });
  await test('R2-7','Replacing an open issue evidence with unrelated world quotes loses its target relevance',async()=>{
   const entry=await fixture('20:24，她开始等待七分半。\n\n20:28，她起身。\n');const c=await constraints(entry,'修改当前章节的时间错误，写后自查，修好再交付。');const run=await editRun(entry,c);const chapter=await readResource(entry,ref);
   const issue={issueId:'timeline:wait:window',category:'timeline',severity:'hard',status:'open',contradiction:'四分钟窗口容不下七分半等待。',evidence:[evidence(chapter,'20:24，她开始等待七分半。'),evidence(chapter,'20:28，她起身。')]};
   const previous=mergeReviewFindings([],await assess(run,[issue]));const empty=await evaluate(run,await assess(run,[],previous),previous);assert.equal(empty.goalVerified,false);
   const world=await readResource(entry,'world:lore');run.items.push(await read(entry,'world:lore'));
   const relocated={...issue,evidence:[evidence(world,'东门朝东。'),evidence(world,'西门朝西。')]};
   const row=await assess(run,[relocated],previous);const outcome=await evaluate(run,row,previous);const merged=mergeReviewFindings(previous,row);
   assert.equal(row.evidenceVerified,true);assert.equal(merged[0].status,'open');assert.equal(outcome.goalVerified,true);
   return {scope:'production finding merge/relevance/final evaluator with actual quotes; malformed semantic association and commit receipt are fixtures',actual:{emptyReportGoalVerified:empty.goalVerified,reassociatedEvidenceVerified:row.evidenceVerified,issueStillOpen:merged[0].status==='open',goalVerified:outcome.goalVerified,remainingEvidenceRefs:merged[0].evidence.map(e=>e.resourceRef)},positiveControl:'An empty report cannot erase the existing open hard issue. Reusing its identity with unrelated valid citations removes its task relevance.'};
  });
 } finally {
  stop?.();await fs.rm(temp,{recursive:true,force:true});
  const files=['src/main/codex-runtime/taskRequirements.js','src/main/codex-runtime/writingScope.js','src/main/mcp/writingTools.js','src/main/codex-runtime/narrativeReviewJobs.js','src/main/codex-runtime/reviewLedger.js','src/main/codex-runtime/taskCompletion.js'];
  const sourceDigests=Object.fromEntries(files.map(p=>[p,crypto.createHash('sha256').update(fss.readFileSync(path.join(root,p))).digest('hex')]));
  await fs.writeFile(path.join(__dirname,'counterexample-audit-r2.json'),JSON.stringify({auditedAt:new Date().toISOString(),productionModified:false,liveModelInvoked:false,uiInvoked:false,temporaryStorageRemoved:true,sourceDigests,results},null,2)+'\n');
 }
 assert.equal(results.length,7);console.log('Reproduced 7 new counterexamples with paired controls; these are failure reproductions, not acceptance.');
}
main().catch(e=>{console.error(e);process.exitCode=1});
