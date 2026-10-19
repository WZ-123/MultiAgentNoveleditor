'use strict';

const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

async function run() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'mana-review-ledger-'));
  process.env.MANA_USER_DATA_ROOT = path.join(root, 'user-data');
  const novels = require('../src/main/store/novels');
  const novelData = require('../src/main/store/novelData');
  const { readResource } = require('../src/main/mcp/novelResources');
  const { assessReview, fileFor, invalidateForResources, recordReview, stableIssue,mergeReviewFindings,parseLedgerBlock } = require('../src/main/codex-runtime/reviewLedger');
  try {
    const novel = await novels.createNovel({ title: '审校账本', dir: path.join(root, 'novel') });
    await novelData.writeChapterWithMeta(novel.dir, 'chapter-001.md', '甲说门开着。', {}, { baseContent: '' });
    await novelData.writeChapterWithMeta(novel.dir, 'chapter-002.md', '乙说门锁着。', {}, { baseContent: '' });
    const one = await readResource(novel, 'chapter:chapter-001.md');
    const two = await readResource(novel, 'chapter:chapter-002.md');
    const report = `发现一项冲突。\n\n\`\`\`json\n${JSON.stringify({
      coveredResourceRefs: [one.resourceRef, two.resourceRef],
      issues: [{ issueId: 'continuity:door:state', category: 'continuity', severity: 'hard', status: 'open', contradiction: '同一时刻门的开关状态冲突', evidence: [
        { resourceRef: one.resourceRef, hash: one.sourceHash, location: '第1行', quote: '门开着' },
        { resourceRef: two.resourceRef, hash: two.sourceHash, location: '第1行', quote: '门锁着' },
      ] }],
    })}\n\`\`\``;
    const row = await recordReview(novel, {
      taskId: 'review-1', attemptId: 'attempt-1', runId: 'run-1', text: report,
      items: [
        ...[one, two].map(resource => ({ name: 'read_novel_resource', status: 'completed', arguments: { resourceRef: resource.resourceRef },
          result: { structuredContent: { resourceRef: resource.resourceRef, hash: resource.sourceHash, mode: 'content', offset: 0, content: resource.content } } })),
      ],
    });
    assert.equal(row.coverageVerified, true);
    assert.equal(row.issues[0].severity, 'hard');
    assert.equal(row.issues[0].verified, true);
    const reads = [one, two].map(resource => ({ name:'read_novel_resource',status:'completed',result:{structuredContent:{resourceRef:resource.resourceRef,hash:resource.sourceHash,mode:'content',offset:0,content:resource.content}} }));
    const hashless = report.replaceAll(`"hash":"${one.sourceHash}",`,'').replaceAll(`"hash":"${two.sourceHash}",`,'');
    const bound = await assessReview(novel,{text:hashless,items:reads});
    assert.equal(bound.evidenceVerified,true,'host binds versions from actual reads without hash transcription');
    assert.equal(bound.issues[0].evidence[0].hash,one.sourceHash);
    assert.equal(bound.issues[0].evidence[0].versionSource,'actual_content_read');
    const {evaluateTaskResult}=require('../src/main/codex-runtime/taskCompletion');
    const writing={entry:novel,taskConstraints:{operation:'edit',targetResourceRefs:[one.resourceRef],reviewRequired:true,reviewScope:'saved_resources',repairRequired:true},
      committedResources:[{resourceRef:one.resourceRef,mode:'replace',newHash:one.sourceHash}],items:reads,text:hashless,reviewRecord:bound,reviewFindings:bound.issues};
    assert.ok((await evaluateTaskResult(writing,true)).objective.unmet.includes('hard_issues_unresolved'),'valid report is not evidence that required repairs are finished');
    assert.equal((await evaluateTaskResult({...writing,taskConstraints:{...writing.taskConstraints,repairRequired:false}},true)).goalVerified,true,'report-only tasks can finish while reporting conflicts');
    const invalidSeverity=parseLedgerBlock(hashless);invalidSeverity.issues[0].severity='closed';
    assert.equal((await assessReview(novel,{text:'```json\n'+JSON.stringify(invalidSeverity)+'\n```',items:reads})).evidenceVerified,false,'invalid severity cannot silently become an acceptable suspicion');
    const cleanText='```json\n'+JSON.stringify({coveredResourceRefs:[one.resourceRef,two.resourceRef],issues:[]})+'\n```';
    const clean=await assessReview(novel,{text:cleanText,items:reads});
    assert.equal(mergeReviewFindings(bound.issues,clean)[0].status,'open','an empty report cannot erase a known issue');
    assert.equal((await evaluateTaskResult({...writing,reviewRecord:clean},true)).goalVerified,false);
    const close=parseLedgerBlock(hashless);close.issues[0].status='closed';close.issues[0].resolution={kind:'fixed',explanation:'声称已修复'};
    const closedText='```json\n'+JSON.stringify(close)+'\n```';
    assert.equal((await assessReview(novel,{...writing,text:closedText})).evidenceVerified,false,'closing a fixed issue needs an actual changed version, not just closed status');
    assert.equal((await assessReview(novel,{text:hashless,items:[]})).evidenceVerified,false,'current store is not a substitute for reading');
    assert.equal((await assessReview(novel,{text:hashless,items:reads,reviewItemOffset:reads.length})).evidenceVerified,false,'earlier review phases cannot supply version receipts');
    const metadata=reads.map(item=>({...item,result:{structuredContent:{...item.result.structuredContent,mode:'metadata'}}}));
    assert.equal((await assessReview(novel,{text:hashless,items:metadata})).evidenceVerified,false);
    assert.equal((await assessReview(novel,{text:report.replace(one.sourceHash,'wrong'),items:reads})).evidenceVerified,false,'explicit incorrect legacy hashes cannot be silently corrected');
    assert.equal((await assessReview(novel,{text:report.replace(one.sourceHash,''),items:reads})).evidenceVerified,false,'explicit blank hashes cannot request automatic binding');
    assert.equal((await assessReview(novel,{text:hashless.replace('门开着','伪造引文'),items:reads})).evidenceVerified,false);
    assert.equal((await assessReview(novel,{text:hashless.replace('第1行','L999'),items:reads})).evidenceVerified,false);
    await novelData.writeChapterWithMeta(novel.dir,'chapter-001.md','甲说门开着。\n补充一段。',{}, {baseContent:one.content});
    assert.equal((await assessReview(novel,{text:hashless,items:reads})).evidenceVerified,false,'unchanged quote cannot rebase an old read onto a changed resource');
    const newer=await readResource(novel,one.resourceRef);
    const fresh=[...reads,{name:'read_novel_resource',status:'completed',result:{structuredContent:{resourceRef:newer.resourceRef,hash:newer.sourceHash,mode:'content',offset:0,content:newer.content}}}];
    assert.equal((await assessReview(novel,{text:hashless,items:fresh})).evidenceVerified,true);
    assert.equal((await assessReview(novel,{text:hashless,items:fresh,expectedCoverageHashes:bound.coverageHashes})).evidenceVerified,false,'a later read cannot rebase an already submitted report');
    assert.equal(stableIssue({ issueId: 'style:x:y', severity: 'hard', evidence: [] }).severity, 'suspicion', 'hard claims without contradictory evidence cannot block delivery');
    const invalidated = await invalidateForResources(novel, [{ resourceRef: one.resourceRef }]);
    assert.deepEqual(invalidated, ['continuity:door:state']);
    const rows = (await fsp.readFile(fileFor(novel), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(rows.at(-1).type, 'review_issue_invalidated');
    await novelData.writeChapterWithMeta(novel.dir,'chapter-001.md','甲说门锁着。',{}, {baseContent:newer.content});
    const fixed=await readResource(novel,one.resourceRef);
    const fixedReads=[reads[1],{name:'read_novel_resource',status:'completed',result:{structuredContent:{resourceRef:fixed.resourceRef,hash:fixed.sourceHash,mode:'content',offset:0,content:fixed.content}}}];
    close.issues[0].evidence[0].quote='门锁着';
    close.issues[0].resolution.changes=[{beforeEvidenceIndex:0,after:{resourceRef:fixed.resourceRef,quote:'门锁着'}}];
    const fixedRun={...writing,items:fixedReads,committedResources:[{resourceRef:fixed.resourceRef,mode:'replace',newHash:fixed.sourceHash}],text:'```json\n'+JSON.stringify(close)+'\n```',resolutionAuthority:'independent_review'};
    fixedRun.reviewRecord=await assessReview(novel,fixedRun);
    assert.equal(fixedRun.reviewRecord.evidenceVerified,true);
    assert.equal((await evaluateTaskResult(fixedRun,true)).goalVerified,true,'actual repair, fresh reads and explicit closure can complete the task');
    assert.equal((await assessReview(novel,{...fixedRun,reviewFindings:mergeReviewFindings(fixedRun.reviewFindings,fixedRun.reviewRecord)})).evidenceVerified,true,'final reassessment of the same validated closure must be idempotent');
    const closedFindings=mergeReviewFindings(fixedRun.reviewFindings,fixedRun.reviewRecord);
    await novelData.writeChapterWithMeta(novel.dir,'chapter-001.md',fixed.content+'新增段落。',{}, {baseContent:fixed.content});
    const changedAgain=await readResource(novel,one.resourceRef);
    const changedReads=[reads[1],{name:'read_novel_resource',status:'completed',result:{structuredContent:{resourceRef:changedAgain.resourceRef,hash:changedAgain.sourceHash,mode:'content',offset:0,content:changedAgain.content}}}];
    const rereview=await assessReview(novel,{text:cleanText,items:changedReads,reviewFindings:closedFindings});
    assert.equal(mergeReviewFindings(closedFindings,rereview)[0].status,'open','changing a closure dependency requires current evidence before it can remain resolved');
    console.log('review-ledger-contract: ok');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
