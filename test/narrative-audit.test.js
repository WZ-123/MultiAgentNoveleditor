'use strict';
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {assessNarrativeReview,locateEvidence}=require('../src/main/codex-runtime/narrativeAudit');
const {makeReviewSchema,resolveReview,citationCatalogue,reviewView}=require('../src/main/codex-runtime/narrativeReviewJobs');
const chapter={resourceRef:'chapter:chapter-001.md',kind:'chapter',content:'20:24，她等了七分半。\n\n20:28，她离开。'};
chapter.sourceHash=crypto.createHash('sha256').update(chapter.content).digest('hex');
const reads=[{name:'read_novel_resource',status:'completed',result:{structuredContent:{...chapter,mode:'content',hash:chapter.sourceHash,offset:0}}}];
const resources=new Map([[chapter.resourceRef,chapter]]);
const bundle={targets:[chapter.resourceRef],sources:[chapter],citations:citationCatalogue([chapter]),priorFindings:[],taskConstraints:{}};
let count=0;function test(name,fn){fn();count++;console.log('TEST_PASS '+name)}
test('no classification slots, knowledge labels or global proof table in the review interface',()=>{
 const schema=makeReviewSchema(bundle);assert.equal(schema.properties.analysis,undefined);assert.ok(schema.properties.reviews);assert.ok(schema.properties.issues);assert.ok(schema.properties.resolutions);
 assert.equal(schema.properties.issues.items.properties.sourceKey,undefined,'new problem identity belongs to the host, not a model-generated key');
});
test('a model assessment is reported, never a deterministic clean certificate',()=>{
 const result=assessNarrativeReview({reviews:[{resourceRef:chapter.resourceRef,aspects:['timeline'],conclusion:'模型判断，仍须按正文核对。',limitations:[]}]},{targets:[chapter],aspects:['timeline']});
 assert.equal(result.status,'reported');assert.equal(result.qualityConclusion,'model_reported');assert.equal(result.issues,undefined);
});
test('missing requested resources or aspects remains incomplete',()=>{
 assert.equal(assessNarrativeReview({reviews:[]},{targets:[chapter]}).status,'incomplete');
 assert.equal(assessNarrativeReview({reviews:[{resourceRef:chapter.resourceRef,aspects:[],conclusion:'只看了格式。',limitations:[]}]},{targets:[chapter],aspects:['timeline']}).status,'incomplete');
 assert.equal(assessNarrativeReview(null,{targets:[chapter]}).status,'missing');
});
test('memory summaries need their own review, not chapter prose style classifications',()=>{
 const memory='character-memory:a';
 const rows=[{resourceRef:chapter.resourceRef,aspects:['timeline','style'],conclusion:'检查正文时间与文风。',limitations:[]},{resourceRef:memory,aspects:['character'],conclusion:'检查本人的见闻与原始记忆。',limitations:[]}];
 assert.equal(assessNarrativeReview({reviews:rows},{targets:[chapter.resourceRef,memory],aspects:['timeline','style']}).status,'reported');
 assert.equal(assessNarrativeReview({reviews:rows.slice(0,1)},{targets:[chapter.resourceRef,memory],aspects:['timeline','style']}).status,'incomplete');
 rows[0].aspects=['style'];assert.equal(assessNarrativeReview({reviews:rows},{targets:[chapter.resourceRef,memory],aspects:['timeline','style']}).status,'incomplete');
});
test('host resolves actual citations without requiring manual hashes or line copying',()=>{
 const raw={reviews:[],issues:[{evidence:[{citationId:bundle.citations[0].citationId}]}],resolutions:[]};
 const resolved=resolveReview(raw,bundle);assert.equal(resolved.issues[0].evidence[0].quote,bundle.citations[0].quote);
 raw.issues[0].evidence[0].citationId='invented';assert.throws(()=>resolveReview(raw,bundle),/review_citation_unknown/);
});
test('free evidence cannot masquerade as a host catalogue citation',()=>{
 assert.throws(()=>resolveReview({reviews:[],issues:[{evidence:[{resourceRef:chapter.resourceRef,quote:'捏造'}]}],resolutions:[]},bundle),/must_reference_catalogue/);
 assert.throws(()=>resolveReview({issues:[]},bundle),/review_report_invalid/);
});
test('real evidence still needs current source bytes and an actual delivery',()=>{
 const raw={resourceRef:chapter.resourceRef,quote:'20:28，她离开。'};
 assert.equal(locateEvidence(raw,resources,reads).location,'L3');assert.equal(locateEvidence(raw,resources,[]),null);
 assert.equal(locateEvidence({...raw,location:'L1'},resources,reads),null);
});
test('uncertainties are delivered as limitations rather than fabricated graph completeness',()=>{
 const result=assessNarrativeReview({reviews:[{resourceRef:chapter.resourceRef,aspects:['viewpoint'],conclusion:'缺角色基线。',limitations:['不能确认此前是否获知。']}]},{targets:[chapter],aspects:['viewpoint']});
 assert.equal(result.status,'reported');assert.deepEqual(result.limitations,['不能确认此前是否获知。']);
});
test('resolution schema selects actual prior identities and requires before/after edit references',()=>{
 const schema=makeReviewSchema({...bundle,priorFindings:[{issueId:'time:chapter:one'}]});
 assert.deepEqual(schema.properties.resolutions.items.properties.issueId.enum,['time:chapter:one','__none__']);
 assert.ok(schema.properties.resolutions.items.required.includes('changes'));
 assert.ok(schema.properties.resolutions.items.properties.kind.enum.includes('unresolved'),'an unresolved assessment must not be forced into a closing state');
});
test('the review sees exactly one reversible source view and explicit private owners',()=>{
 const privateSource={resourceRef:'character-memory:b',kind:'character-memory',content:'  阿白自己的秘密。\n\n不可自动共享。\n'};
 const view=reviewView({...bundle,sources:[chapter,privateSource],citations:citationCatalogue([chapter,privateSource]),taskConstraints:{narrativePerspective:{mode:'limited',focusCharacterRef:'character:a'}}});
 assert.equal(view.citations,undefined);
 for(const source of view.sources){assert.equal(source.content,undefined);assert.equal(source.lines.map(line=>line.text).join('\n'),[chapter,privateSource].find(raw=>raw.resourceRef===source.resourceRef).content);}
 assert.equal(view.sources[1].ownerCharacterRef,'character:b');assert.equal(view.sources[1].role,'other_character_context_not_shared_by_default');
});
console.log('narrative-audit: '+count+' scenarios passed');
