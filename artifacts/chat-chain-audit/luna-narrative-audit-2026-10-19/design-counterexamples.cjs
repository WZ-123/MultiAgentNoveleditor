'use strict';
// Audit only. Calls the unchanged production boundary; never writes novel data.
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');
const base=path.resolve(__dirname,'../../..');
const {assessNarrativeAudit,reviewUnits}=require(path.join(base,'src/main/codex-runtime/narrativeAudit'));
const {citationCatalogue,resolveReview,makeReviewSchema}=require(path.join(base,'src/main/codex-runtime/narrativeReviewJobs'));
const {bindRequirements}=require(path.join(base,'src/main/codex-runtime/taskRequirements'));
const {normalizeTaskConstraints}=require(path.join(base,'src/main/codex-runtime/taskLedger'));
const results=[];
function context(content) {
 const sources=[{resourceRef:'chapter:chapter-001.md',kind:'chapter',content},
  {resourceRef:'character:a',kind:'character',content:'阿青不知道石匣内有信。'},
  {resourceRef:'character:b',kind:'character',content:'只有阿白知道石匣内有信。'}]
  .map(r=>({...r,sourceHash:crypto.createHash('sha256').update(r.content).digest('hex')}));
 const resources=new Map(sources.map(r=>[r.resourceRef,r]));
 const reads=sources.map(r=>({name:'read_novel_resource',status:'completed',result:{structuredContent:{resourceRef:r.resourceRef,mode:'content',content:r.content,hash:r.sourceHash,offset:0}}}));
 const perspective={mode:'limited',focusCharacterRef:'character:a'};
 const bundle={sources,targets:[sources[0].resourceRef],units:reviewUnits([sources[0]]),taskConstraints:{narrativePerspective:perspective}};
 bundle.citations=citationCatalogue(sources);
 const ctx={resources,reads,targets:[sources[0]],narrativePerspective:perspective};
 const raw={analysis:{perspective,units:Object.fromEntries(bundle.citations.filter(c=>c.resourceRef===sources[0].resourceRef).map(c=>[c.citationId,'none'])),timeConclusion:'未提取出冲突。',timePoints:[],timeRelations:[],knowledge:[]},issues:[],resolutions:[]};
 const cite=text=>{const c=bundle.citations.find(c=>c.quote===text);assert.ok(c,'catalogue quote '+text);return {citationId:c.citationId}};
 return {bundle,ctx,raw,cite};
}
function run(name,expected,setup) {
 const {f,raw}=setup();
 const normalized=resolveReview(raw,f.bundle);
 const actual=assessNarrativeAudit(normalized.analysis,f.ctx);
 results.push({name,expected,actual,scope:'production resolveReview + assessNarrativeAudit boundary; constructed extraction, not a real model response'});
 return actual;
}
async function main(){
 let r=run('omitted_time_and_presupposed_secret_are_accepted','Known bad prose must not become evidence of a clean semantic audit merely through complete slots.',()=>{
  const f=context('20:24，阿青等了半刻。\n\n20:28，她起身。\n\n她不知道阿白是否拿走了石匣里的信。');
  return {f,raw:f.raw};
 });assert.equal(r.status,'checked');assert.equal(r.issues.length,0);
 r=run('uncertain_label_hides_asserted_presupposition','Uncertain whether somebody took the letter still presupposes a letter in the box.',()=>{
  const f=context('她不知道阿白是否拿走了石匣里的信。');
  const e=f.cite(f.ctx.targets[0].content);
  f.raw.analysis.units[e.citationId]='knowledge';
  f.raw.analysis.knowledge=[{fact:'石匣内有信',mode:'uncertain',focusAccess:'unsupported',accessBasis:'none',claim:e,grounds:[],explanation:'不知道是否拿走。'}];
  return {f,raw:f.raw};
 });assert.equal(r.status,'checked');assert.equal(r.issues.length,0);
 r=run('supported_label_and_self_quote_hide_actual_leak','Actual quote provenance does not prove that the focal character could know it.',()=>{
  const f=context('阿青知道石匣内有信。');const e=f.cite(f.ctx.targets[0].content);
  f.raw.analysis.units[e.citationId]='knowledge';
  f.raw.analysis.knowledge=[{fact:'石匣内有信',mode:'established',focusAccess:'supported',accessBasis:'observation',claim:e,grounds:[e],explanation:'焦点现场观察得知。'}];
  return {f,raw:f.raw};
 });assert.equal(r.status,'checked');assert.equal(r.issues.length,0);
 r=run('valid_overlap_of_claim_and_ground_is_rejected','A visible stamp action supports the following observation; that ground should not require a duplicate independent claim.',()=>{
  const f=context('阿青看见阿白盖下印章，朱印清晰可辨。');
  const action=f.cite('阿青看见阿白盖下印章，'),outcome=f.cite('朱印清晰可辨。');
  f.raw.analysis.units[action.citationId]='knowledge';f.raw.analysis.units[outcome.citationId]='knowledge';
  f.raw.analysis.knowledge=[{fact:'盖章后朱印可见',mode:'observed',focusAccess:'supported',accessBasis:'observation',claim:outcome,grounds:[action],explanation:'焦点看见盖章并观察印文，两个分句由同一条观察解释。'}];
  return {f,raw:f.raw};
 });assert.equal(r.status,'incomplete');assert.ok(r.errors.some(e=>e.startsWith('knowledge_assertion_unmodeled')));
 r=run('single_quote_mathematical_contradiction_loses_finding','One sentence can contain all three facts required to prove a contradiction; two distinct quotation spans are not logically required.',()=>{
  const f=context('20:24至20:28之间她整整等了七分半。'),e=f.cite(f.ctx.targets[0].content);
  f.raw.analysis.units[e.citationId]='duration';
  f.raw.analysis.timePoints=[{id:'start',seconds:73440,evidence:e},{id:'end',seconds:73680,evidence:e}];
  f.raw.analysis.timeRelations=[{from:'start',to:'end',minSeconds:450,maxSeconds:450,evidence:[e]}];
  f.raw.analysis.timeConclusion='四分钟窗口容不下七分半等待。';
  return {f,raw:f.raw};
 });assert.equal(r.status,'incomplete');assert.equal(r.issues.length,0);assert.ok(r.errors.some(e=>e.startsWith('insufficient_conflict_evidence')));
 r=run('numeric_interpretation_not_verified_by_exact_quote','20:24 to 20:28 cannot contain seven and a half minutes; genuine quotations do not authenticate the extracted numeric values.',()=>{
  const f=context('20:24，她开始等待。\n\n她等了七分半。\n\n20:28，她起身。');
  const first=f.cite('20:24，'),last=f.cite('20:28，'),duration=f.cite('她等了七分半。');
  for(const e of [first,last])f.raw.analysis.units[e.citationId]='clock';f.raw.analysis.units[duration.citationId]='duration';
  f.raw.analysis.timePoints=[{id:'start',seconds:0,evidence:first},{id:'end',seconds:600,evidence:last}];
  f.raw.analysis.timeRelations=[{from:'start',to:'end',minSeconds:450,maxSeconds:null,evidence:[duration]}];
  return {f,raw:f.raw};
 });assert.equal(r.status,'checked');assert.equal(r.issues.length,0);
 r=run('lawful_focal_introspection_has_no_suitable_prior_proof','A focal character can directly experience her own preferences; later clause is not illicit future evidence of a secret.',()=>{
  const f=context('阿青不喜欢把药交给别人，也不喜欢让药箱离开视线。');
  const first=f.cite('阿青不喜欢把药交给别人，'),last=f.cite('也不喜欢让药箱离开视线。');
  f.raw.analysis.units[first.citationId]='knowledge';f.raw.analysis.units[last.citationId]='knowledge';
  f.raw.analysis.knowledge=[{fact:'阿青对药品保管的偏好',mode:'established',focusAccess:'supported',accessBasis:'prior',claim:first,grounds:[last],explanation:'焦点本人直接体验其偏好。'},
   {fact:'阿青不愿药箱离开视线',mode:'established',focusAccess:'supported',accessBasis:'prior',claim:last,grounds:[first],explanation:'同一焦点的相连偏好。'}];
  return {f,raw:f.raw};
 });assert.equal(r.status,'conflicts');assert.ok(r.issues.some(i=>i.category==='knowledge'));
 const persisted=normalizeTaskConstraints({operation:'write',reviewRequired:true,reviewScopeBound:true,writeScopeBound:true,narrativeAuditRequired:false,reviewSourceKinds:['world']});
 // A deliberately nonexistent entry establishes that the early return bypasses
 // source binding altogether; no production store is modified for this probe.
 const rebound=await bindRequirements({dir:'/nonexistent/audit-only-entry'},persisted,'继续写作，写完核对世界观并自查。');
 assert.equal(rebound.narrativeAuditRequired,false);
 results.push({name:'persisted_bound_scope_bypasses_new_audit',expected:'Continued legacy writing/review tasks must evaluate the current review obligation.',actual:{narrativeAuditRequired:rebound.narrativeAuditRequired,reviewRequired:rebound.reviewRequired,reviewScopeBound:rebound.reviewScopeBound,writeScopeBound:rebound.writeScopeBound},scope:'production bindRequirements early-return, constructed persisted constraints; no filesystem access'});
 const f=context('阿青看见阿白盖下印章。');delete f.bundle.taskConstraints.narrativePerspective;
 const focus=makeReviewSchema(f.bundle).properties.analysis.properties.perspective.properties.focusCharacterRef;
 assert.equal(focus.enum,undefined);
 results.push({name:'unbound_review_focus_has_no_resource_id_domain',expected:'Reviewer should select an actual character identity rather than freely inventing a name.',actual:{focusSchema:focus,readCharacterRefs:[...f.ctx.resources.keys()].filter(r=>r.startsWith('character:'))},scope:'production makeReviewSchema; live controls-v2 independently reproduced focus_character_not_read'});
 const productionFiles=['narrativeAudit.js','narrativeReviewJobs.js','taskRequirements.js','taskLedger.js'].map(n=>'src/main/codex-runtime/'+n);
 const sourceDigests=Object.fromEntries(productionFiles.map(p=>[p,crypto.createHash('sha256').update(fs.readFileSync(path.join(base,p))).digest('hex')]));
 fs.writeFileSync(path.join(__dirname,'design-counterexamples.json'),JSON.stringify({auditedAt:new Date().toISOString(),productionCodeModified:false,realModelInvoked:false,sourceDigests,results},null,2)+'\n');
 console.log('Reproduced '+results.length+' design counterexamples. This is failure evidence, not product acceptance.');
}
main().catch(e=>{console.error(e);process.exitCode=1});
