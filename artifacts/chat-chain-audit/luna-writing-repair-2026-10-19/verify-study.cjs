'use strict';
// Deterministic evidence summary, never a semantic fiction quality verdict.
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const root=path.resolve(process.argv[2]);
const {bodyChineseCharacterCount}=require('../../../src/main/mcp/novelResources');
const rows=file=>fs.existsSync(path.join(root,file))?fs.readFileSync(path.join(root,file),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
const events=rows('events.jsonl');
const keys=['factsKnown','privateMisbeliefs','emotionalMemory','relationshipDeltas','unresolvedIntentions'];
const summaries=rows('results.jsonl').filter(row=>row.result?.events).map(row=>{
  const e=events.filter(event=>event.command===row.id);
  const items=e.filter(event=>event.type==='item_completed').map(event=>event.item).filter(Boolean);
  const reads=items.filter(item=>item.tool==='read_novel_resource'&&item.status==='completed'&&item.result?.structuredContent?.mode==='content');
  const saved=JSON.parse(fs.readFileSync(path.join(root,row.id+'-readback.json'),'utf8'));
  const chapters=Object.entries(saved.chapters).map(([file,content])=>{
    assert.equal(fs.readFileSync(path.join(root,'novel/chapters',file),'utf8'),content,'formal chapter must agree with readback');
    return {file,bodyCjk:bodyChineseCharacterCount(content)};
  });
  const memories=[];
  for(const [id,after] of Object.entries(saved.memories)) {
    const first=reads.find(item=>item.result.structuredContent.resourceRef==='character-memory:'+id);
    if(!first)continue;
    const before=JSON.parse(first.result.structuredContent.content);
    for(const key of keys)assert.deepEqual((after[key]||[]).slice(0,(before[key]||[]).length),before[key]||[],'original memory prefix must survive: '+id+'/'+key);
    memories.push({id,originalPrefixPreserved:true,added:Object.fromEntries(keys.map(key=>[key,(after[key]||[]).length-(before[key]||[]).length]))});
  }
  const prepared=items.filter(item=>item.tool==='prepare_novel_patch');
  const reportIssues=items.filter(item=>item.tool==='check_writing_task').flatMap(item=>item.arguments?.report?.issues||[]);
  return {id:row.id,observationSucceeded:row.ok,nativeTurns:e.filter(event=>event.type==='turn_started').length,
    confirmations:row.result.confirmations.map(c=>({decision:c.decision})),chapters,memories,
    preparedCalls:prepared.length,preparedExplicitHashFields:prepared.flatMap(item=>item.arguments?.changes||[]).filter(change=>Object.hasOwn(change,'baseHash')).length,
    preparationDiagnostics:prepared.map(item=>item.result?.structuredContent?.error).filter(Boolean),
    submittedIssueCount:reportIssues.length,submittedExplicitEvidenceHashes:reportIssues.flatMap(issue=>issue.evidence||[]).filter(item=>Object.hasOwn(item,'hash')).length,
    exactUserRangePassed:['traditional-draft','role-draft'].includes(row.id)?chapters.some(chapter=>chapter.file===(row.id==='traditional-draft'?'chapter-002.md':'chapter-003.md')&&chapter.bodyCjk>=1500&&chapter.bodyCjk<=2000):null,
    semanticQuality:'requires independent manual reading; this script does not establish it'};
});
fs.writeFileSync(path.join(root,'deterministic-evidence-summary.json'),JSON.stringify(summaries,null,2)+'\n');
console.log(JSON.stringify(summaries,null,2));
