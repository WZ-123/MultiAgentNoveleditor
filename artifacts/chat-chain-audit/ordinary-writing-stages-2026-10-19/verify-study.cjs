'use strict';
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const ROOT=path.resolve(__dirname,'../../..');
const {bodyChineseCharacterCount}=require(path.join(ROOT,'src/main/mcp/novelResources'));
const json=file=>JSON.parse(fs.readFileSync(path.join(__dirname,file),'utf8'));
const lines=file=>fs.readFileSync(path.join(__dirname,file),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const checks=[];
function check(name,fn){fn();checks.push(name);}
const expected={a:1406,b:2056,c:1560,d:1457,e:1546};
const rounds={};
for(const name of Object.keys(expected)){
  const results=lines('real-'+name+'/results.jsonl');
  const traditional=results.find(result=>result.id==='traditional-draft');
  const event=traditional.result.events.findLast(event=>!event.purpose&&event.type==='turn_completed');
  const result=event.taskResult;
  rounds[name]={actual:result.checks.wordCount.actual,goalVerified:result.goalVerified,unmet:result.objective.unmet};
  check('real-'+name+' original target and honest formal count',()=>{
    assert.equal(traditional.ok,true);assert.equal(traditional.result.handoffUsed,false);
    assert.equal(result.checks.wordCount.actual,expected[name]);
    assert.equal(result.checks.wordCount.minimum,1500);assert.equal(result.checks.wordCount.maximum,2000);assert.equal(result.checks.wordCount.toleranceRatio,0);
    const readback=json('real-'+name+'/traditional-draft-readback.json');
    assert.equal(bodyChineseCharacterCount(readback.chapters['chapter-002.md']),expected[name]);
    if(['a','b','d'].includes(name)){assert.equal(result.goalVerified,false);assert.ok(result.objective.unmet.includes('word_count'));}
  });
}
const rows=lines('real-e/results.jsonl');
const row=id=>{const found=rows.find(row=>row.id===id);assert.ok(found,id);assert.equal(found.ok,true,id);return found.result;};
const records=json('real-e/host-task-results.json');
const parent=id=>{
  const result=row(id),event=result.events.findLast(event=>!event.purpose&&['turn_completed','turn_failed','turn_interrupted'].includes(event.type));
  assert.ok(event,id+' terminal');const run=records.find(run=>run.runId===event.runId);assert.ok(run,id+' durable run');return run;
};
const chapter='chapter-002.md';
const traditional=json('real-e/traditional-draft-readback.json');
const formatted=json('real-e/traditional-format-cleanup-readback.json');
check('final original traditional task has a real approval, canonical save, review and goal acceptance',()=>{
  const run=parent('traditional-draft');assert.equal(run.taskResult.goalVerified,true);assert.equal(run.preparationStage.phase,'readback_complete');
  assert.equal(run.reviewSubmission.origin,'host_readonly_analysis');assert.equal(run.savedResources.length,1);assert.ok(row('traditional-draft').confirmations.some(item=>item.decision==='accept'));
});
check('exact four literal escape fragments are removed without rewriting prose',()=>{
  const fixture=json('real-e/format-fixture-fixture.json');assert.equal(fixture.injectedFragments,4);assert.equal(formatted.chapters[chapter],fixture.before);assert.equal(fixture.before,traditional.chapters[chapter]);
  assert.equal(parent('traditional-format-cleanup').taskResult.goalVerified,true);
});
for(const id of ['ordinary-decline','ordinary-dependency-conflict','ordinary-stop'])check(id+' keeps formal prose and has no commit',()=>{
  assert.deepEqual(json('real-e/'+id+'-readback.json').chapters,formatted.chapters);
  const run=parent(id);assert.equal(run.savedResources.length,0);assert.equal(run.taskResult.goalVerified,false);
  if(id==='ordinary-decline')assert.equal(run.preparationStage.phase,'rejected');
  if(id==='ordinary-dependency-conflict')assert.match(run.error,/world:lore/u);
  if(id==='ordinary-stop')assert.equal(run.status,'interrupted');
});
check('concurrent world edit survives the dependency conflict',()=>{
  assert.ok(json('real-e/ordinary-dependency-conflict-concurrent-world.json').lore.includes('并发用户编辑'));
  assert.ok(fs.readFileSync(path.join(__dirname,'real-e/novel/world/lore.md'),'utf8').includes('并发用户编辑'));
});
check('chapter and exactly two selected memories share one native approved transaction',()=>{
  const run=parent('ordinary-memory-atomic'),refs=run.savedResources.map(item=>item.resourceRef).sort();
  assert.deepEqual(refs,['chapter:chapter-003.md','character-memory:he','character-memory:lin']);
  assert.equal(new Set(run.savedResources.map(item=>item.nativeItemId)).size,1);
  for(const item of run.savedResources)assert.deepEqual([...item.nativeBatchResourceRefs].sort(),refs);
  assert.equal(run.taskResult.goalVerified,false);assert.ok(run.taskResult.objective.unmet.includes('hard_issues_unresolved'));
  const readback=json('real-e/ordinary-memory-atomic-readback.json');
  for(const id of ['lin','he'])for(const old of traditional.memories[id].factsKnown)assert.ok(readback.memories[id].factsKnown.some(item=>JSON.stringify(item)===JSON.stringify(old)));
});
check('explicit continuation preserves original memories and independently reassesses known issues',()=>{
  const run=parent('ordinary-continue-repair');assert.equal(run.continuedFromRunId,parent('ordinary-memory-atomic').runId);assert.equal(run.taskResult.goalVerified,true);
  assert.ok(run.reviewFindings.some(issue=>issue.requestedSeverity==='hard'&&issue.status==='closed'&&issue.resolutionVerified));
  const readback=json('real-e/ordinary-continue-repair-readback.json');
  for(const id of ['lin','he'])for(const old of traditional.memories[id].factsKnown)assert.ok(readback.memories[id].factsKnown.some(item=>JSON.stringify(item)===JSON.stringify(old)));
});
check('latest native handoff preserves original user instructions for subsequent conversation',()=>{
  const edited=json('real-e/final-context-edit-readback.json');assert.equal(edited.chapters[chapter],formatted.chapters[chapter].replace('双印','双印·复核'));
  const question=row('final-context-question');assert.ok(question.body.includes('正文、标点和换行必须保持原样'));assert.equal(parent('final-context-question').savedResources.length,0);
  assert.deepEqual(json('real-e/final-context-question-readback.json'),edited);assert.equal(parent('final-context-edit').preparationStage.phase,'readback_complete');
});
check('all live executions retain the actual chosen model and bounded revision count',()=>{
  for(const row of rows)for(const event of row.result?.events||[])if(event.type==='turn_started'&&event.modelId)assert.equal(event.modelId,'gpt-6-luna');
  for(const run of records)if(run.preparationStage){assert.ok((run.preparationStage.executions||[]).filter(execution=>execution.purpose==='writing_revision').length<=1);}
  assert.equal(parent('ordinary-memory-atomic').preparationStage.revisionCount,1);
});
const initial=json('source-manifest.json'),files={};
for(const file of Object.keys(initial.files))files[file]=crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT,file))).digest('hex');
const changed=Object.keys(files).filter(file=>files[file]!==initial.files[file]);
const output={verifiedAt:new Date().toISOString(),checks,rounds,sourceChangesAfterInitialManifest:changed,limitations:['Model review is an opinion, not proof of semantic correctness.','The original role-driven six-character workflow and historical semantic controls were not rerun.','Late preparation checkpoint/context and missing-memory-version fixes have current focused regressions; the final live follow-up exercises current native handoff.']};
fs.writeFileSync(path.join(__dirname,'verification.json'),JSON.stringify(output,null,2)+'\n');
fs.writeFileSync(path.join(__dirname,'source-final-manifest.json'),JSON.stringify({base:initial.base,files},null,2)+'\n');
console.log(JSON.stringify(output,null,2));
