'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=__dirname;
const load=name=>JSON.parse(fs.readFileSync(path.join(root,name),'utf8'));
const rows=name=>fs.readFileSync(path.join(root,name),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const result=(dir,id)=>rows(dir+'/results.jsonl').find(row=>row.id===id).result;
const record=(dir,id)=>{const events=result(dir,id).events;const terminal=events.findLast(e=>!e.parentRunId&&['turn_completed','turn_failed','turn_interrupted'].includes(e.type));return load(dir+'/host-task-results.json').find(r=>r.runId===terminal.runId)};
const counts=(dir,id)=>{const events=result(dir,id).events.filter(e=>e.type==='turn_started');return {intent:events.filter(e=>e.purpose==='task_intent').length,preparation:events.filter(e=>e.purpose==='writing_preparation').length,commit:events.filter(e=>!e.parentRunId).length};};
const checks=[];
function check(name,fn){fn();checks.push({name,status:'passed'});}
const accepted=record('real-f','format-accept');
const acceptedData=load('real-f/format-accept-readback.json');
check('F native approval, one batch, canonical chapter/memory readback and exact four-fragment cleanup',()=>{
 assert.equal(accepted.status,'completed');assert.equal(accepted.taskResult.goalVerified,true);
 assert.equal(accepted.preparationStage.phase,'readback_complete');assert.equal(accepted.preparationStage.resultOrigin,'host_commit_receipt');
 const material=accepted.writingPreparations[accepted.preparationStage.candidate.preparationId];
 assert.equal(material.revision,accepted.preparationStage.candidate.revision);
 assert.equal(accepted.savedResources.length,2);assert.equal(new Set(accepted.savedResources.map(r=>r.nativeItemId)).size,1);
 assert.ok(accepted.savedResources.every(r=>r.nativeBatchResourceRefs.length===2));
 assert.ok(material.expectedResources.every(e=>accepted.savedResources.some(r=>r.resourceRef===e.resourceRef&&r.newHash===e.hash)));
 assert.notEqual(material.expectedResources.find(e=>e.resourceRef==='character-memory:lin').hash,material.expectedResources.find(e=>e.resourceRef==='character-memory:lin').mirrorHash);
 assert.equal(acceptedData.chapters['chapter-002.md'],load('real-f/seed-accept-fixture.json').before);
 assert.equal(accepted.taskResult.checks.wordCount.actual,1570);assert.equal(accepted.taskResult.checks.wordCount.toleranceRatio,0);
 const before=accepted.memoryBaselines['character-memory:lin'];
 for(const key of ['factsKnown','emotionalMemory','relationshipDeltas','unresolvedIntentions','privateMisbeliefs'])for(const item of before[key]||[])assert.deepEqual(acceptedData.memories.lin[key].find(i=>i.id===item.id),item);
 assert.equal(result('real-f','format-accept').confirmations.length,1);
 const prepared=load('real-f/format-accept-prepared.json');assert.equal(prepared.parentActive,true);assert.equal(prepared.projectOwner,accepted.runId);
 assert.deepEqual(counts('real-f','format-accept'),{intent:1,preparation:1,commit:1});
 assert.match(result('real-f','inspect-receipt').body,/保存回执/u);assert.match(accepted.text,/已保存并读回 2 项资源。正文 1570 字。/u);
});
const eAccept=load('real-e/format-accept-readback.json');
const eDecline=load('real-e/format-decline-readback.json');
const eConflict=load('real-e/format-conflict-readback.json');
const eStop=load('real-e/format-stop-readback.json');
check('E decline has one visible declined approval, zero commits and unchanged formal memory/body from the injected baseline',()=>{
 const r=record('real-e','format-decline');assert.equal(r.savedResources.length,0);assert.equal(r.taskResult.goalVerified,false);
 assert.equal(result('real-e','format-decline').confirmations.length,1);assert.equal(result('real-e','format-decline').confirmations[0].decision,'decline');
 assert.equal(eDecline.chapters['chapter-002.md'],load('real-e/seed-decline-fixture.json').content);assert.deepEqual(eDecline.memories,eAccept.memories);
 assert.deepEqual(counts('real-e','format-decline'),{intent:1,preparation:1,commit:1});
});
check('E concurrent formal memory edit prevents native dispatch and preserves the user edit',()=>{
 const r=record('real-e','format-conflict');assert.equal(r.savedResources.length,0);assert.equal(r.failure.code,'resource_version_changed');
 assert.equal(result('real-e','format-conflict').confirmations.length,0);assert.deepEqual(counts('real-e','format-conflict'),{intent:1,preparation:1,commit:0});
 assert.deepEqual(eConflict.chapters,eDecline.chapters);
 const expected=structuredClone(eDecline.memories);expected.lin.unresolvedIntentions.push({id:'concurrent-edit',summary:'并发用户编辑，必须保留'});assert.deepEqual(eConflict.memories,expected);
});
check('E stop aborts the preparation stage without a native commit or any formal write',()=>{
 const r=record('real-e','format-stop');assert.equal(r.status,'interrupted');assert.equal(r.savedResources.length,0);assert.equal(r.preparationStage.phase,'interrupted');
 assert.equal(result('real-e','format-stop').confirmations.length,0);assert.equal(counts('real-e','format-stop').commit,0);assert.deepEqual(eStop,eConflict);
});
check('B 1324-character draft remains a failed original-count sample; no retry or relaxed threshold',()=>{
 const r=record('real-b','accept');assert.equal(r.status,'failed');assert.equal(r.failure.code,'preparation_word_count');assert.equal(r.savedResources.length,0);
 assert.equal(r.preparationStage.error.wordCount.actual,1324);assert.equal(r.preparationStage.error.wordCount.acceptedMinimum,1500);assert.equal(r.preparationStage.error.wordCount.toleranceRatio,0);
 assert.ok(r.writingPreparations[r.preparationStage.candidate.preparationId]);assert.deepEqual(counts('real-b','accept'),{intent:1,preparation:1,commit:0});
});
check('all real samples use gpt-6-luna and all exported private runtimes were removed; failures stay retained',()=>{
 for(const dir of ['real-a','real-b','real-c','real-d','real-e','real-f']) {
  assert.deepEqual(load(dir+'/source-delta.json'),[]);assert.equal(load(dir+'/cleanup.json').privateRuntimeRemoved,true);
  for(const row of rows(dir+'/events.jsonl'))if(row.modelId)assert.equal(row.modelId,'gpt-6-luna');
 }
 assert.equal(record('real-a','accept').failure.code,'resource_version_read_required');
 assert.equal(record('real-c','format-accept').taskResult.goalVerified,false);
 assert.equal(record('real-d','format-conflict').failure?.message||record('real-d','format-conflict').error,'Selected model is at capacity. Please try a different model.');
});
fs.writeFileSync(path.join(root,'verification.json'),JSON.stringify({checks,scope:'protocol handoff only; no two-mode narrative acceptance',originalNewWritingAccepted:false},null,2)+'\n');
console.log('study evidence: '+checks.length+' checks passed; original new-writing sample remains failed');
