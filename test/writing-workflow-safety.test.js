'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mana-writing-safety-'));
  process.env.MANA_USER_DATA_ROOT = path.join(root, 'data');
  const data = require('../src/main/store/novelData');
  const { readResource } = require('../src/main/mcp/novelResources');
  const { getToolByName } = require('../src/main/mcp/tools');
  const { recordReview, invalidateForResources } = require('../src/main/codex-runtime/reviewLedger');
  const { evaluateTaskResult } = require('../src/main/codex-runtime/taskCompletion');
  const { deriveRequirements, bindRequirements } = require('../src/main/codex-runtime/taskRequirements');
  const { taskConstraintsFor } = await import('../src/components/writingTaskConstraints.mjs');
  let passed = 0;
  const test = async (label, fn) => { await fn(); passed++; console.log('PASS writing-safety ' + label); };
  try {
    const entry = await require('../src/main/store/novels').createNovel({ title: '写作安全回归', dir: path.join(root, 'novel') });
    const ctx = { novel: entry, novelDir: entry.dir };
    for (const [file, body] of [['chapter-001.md', '甲说门开着。\n他收起钥匙。'], ['chapter-002.md', '乙说门锁着。']]) await data.writeChapterWithMeta(entry.dir, file, body, {}, { baseContent: '' });
    const refs = ['chapter:chapter-001.md', 'chapter:chapter-002.md'];
    const one = await readResource(entry, refs[0]);
    const two = await readResource(entry, refs[1]);
    const read = async ref => ({ name: 'read_novel_resource', status: 'completed', arguments: { resourceRef: ref }, result: await getToolByName('read_novel_resource').handler({ resourceRef: ref }, ctx) });
    const report = (covered, issues = []) => '审校报告\n```json\n' + JSON.stringify({ coveredResourceRefs: covered, issues }) + '\n```';
    const review = async (constraints, items, covered, issues = []) => {
      const text = report(covered, issues);
      const reviewRecord = await recordReview(entry, { text, items });
      return evaluateTaskResult({ entry, taskConstraints: constraints, items, text, reviewRecord }, true);
    };
    await test('whole book scope cannot collapse to the single chapter read by the model', async () => {
      const payload = await deriveRequirements({ text: '帮我检查全文的人物一致性' });
      await bindRequirements(entry, payload.taskConstraints, payload.text);
      assert.equal(payload.skillName, 'mana-consistency-review');
      assert.equal((await review(payload.taskConstraints, [await read(refs[0])], [refs[0]])).goalVerified, false);
      const covered=await review(payload.taskConstraints,await Promise.all(refs.map(read)),refs);
      assert.equal(covered.checks.review.status,'completed','whole source coverage is independently verified');
      assert.equal(covered.goalVerified,false,'full reading plus an empty writer report is still not a hosted semantic review');
      assert.ok(covered.objective.unmet.includes('narrative_review_not_run'));
    });
    await test('report must cover every read target, including implied targets', async () => {
      assert.equal((await review({ operation: 'review' }, await Promise.all(refs.map(read)), [refs[0]])).goalVerified, false);
    });
    await test('whole book reading also requires both chapters', async () => {
      const result = await evaluateTaskResult({ entry, taskConstraints: taskConstraintsFor('读取全书', '', {}), items: [await read(refs[0])] }, true);
      assert.equal(result.goalVerified, false);
    });
    await test('post writing review is independent of a valid formal save', async () => {
      const commit = { resourceRef: refs[0], mode: 'replace', newHash: one.sourceHash };
      const constraints = taskConstraintsFor('写下一章，写完自查人物与世界观冲突', '', {});
      const incomplete = await evaluateTaskResult({ entry, taskConstraints: constraints, committedResources: [commit], items: [] }, true);
      assert.equal(incomplete.persistence.status, 'saved');
      assert.equal(incomplete.goalVerified, false);
      const items = [await read(refs[0])];
      const text = report([refs[0]]);
      const reviewRecord = await recordReview(entry, { text, items });
      assert.equal((await evaluateTaskResult({ entry, taskConstraints: constraints, committedResources: [commit], items, text, reviewRecord }, true)).goalVerified, true);
      const partialScope = { operation: 'write', reviewRequired: true, reviewScope: 'target_resources', reviewTargetResourceRefs: [refs[1]] };
      const partialItems = [await read(refs[1])];
      const partialText = report([refs[1]]);
      const partialReview = await recordReview(entry, { text: partialText, items: partialItems });
      const missingSaved = await evaluateTaskResult({ entry, taskConstraints: partialScope, committedResources: [commit], items: partialItems, text: partialText, reviewRecord: partialReview }, true);
      assert.equal(missingSaved.goalVerified, false);
      assert.ok(missingSaved.checks.review.missingResourceRefs.includes(refs[0]));
    });
    const issue = evidence => ({ issueId: 'continuity:door:state', severity: 'hard', status: 'open', contradiction: '同一时刻开关状态冲突', evidence });
    const evidence = [one, two].map((r, i) => ({ resourceRef: r.resourceRef, hash: r.sourceHash, location: '第1行', quote: i ? '门锁着' : '门开着' }));
    await test('real quotes with current hashes and actual reads can be anchored', async () => {
      const row = await recordReview(entry, { text: report(refs, [issue(evidence)]), items: await Promise.all(refs.map(read)) });
      assert.equal(row.issues[0].verified, true);
      assert.equal(row.evidenceVerified, true);
    });
    await test('invented quotes, nonexistent lines and missing reads are not verified', async () => {
      for (const [edits, items] of [[{ quote: '不存在的句子' }, await Promise.all(refs.map(read))], [{ location: '第99999行' }, await Promise.all(refs.map(read))], [{}, []]]) {
        const row = await recordReview(entry, { text: report(refs, [issue(evidence.map(e => ({ ...e, ...edits })))]), items });
        assert.equal(row.issues[0].verified, false);
        assert.equal(row.issues[0].severity, 'suspicion');
      }
      const bad = await review({operation:'review',targetResourceRefs:refs},await Promise.all(refs.map(read)),refs,[issue(evidence.map(e=>({...e,location:'L9999'})))]);
      assert.equal(bad.checks.review.reportStatus,'invalid_evidence');
      assert.ok(bad.checks.review.unverifiedEvidence.every(e=>e.reason==='quote_not_at_location'));
    });
    await test('review reads expose exact line numbers without altering original evidence', async () => {
      const numbered=(await getToolByName('read_novel_resource').handler({resourceRef:refs[0],startLine:1,endLine:2,includeLineNumbers:true},ctx)).structuredContent;
      assert.equal(numbered.content,one.content.split('\n').slice(0,2).join('\n'));
      assert.equal(numbered.numberedContent,'L1: 甲说门开着。\nL2: 他收起钥匙。');
    });
    await test('native approval validation keeps the real reason for UI and continuation', async () => {
      const {CodexSessionService,additionalContext}=require('../src/main/codex-runtime/codexSessionService');
      const events=[],rows=[],record={};
      const run={runId:'audit-validation',conversationId:'audit-conversation'};
      const receiver={ledger:{record:async(...args)=>rows.push(args)},runRecords:new Map([[run.runId,record]]),_emitEvent:e=>events.push(e)};
      await assert.rejects(CodexSessionService.prototype._rejectNativeApproval.call(receiver,run,'patch-1',new Error('新增资源已经存在：character-memory:lin')),/新增资源已经存在/u);
      assert.equal(record.nativeValidationErrors[0].message,'新增资源已经存在：character-memory:lin');
      assert.equal(rows[0][1],'native_validation_failed');
      assert.equal(events[0].type,'run_state');
      const result=await evaluateTaskResult({...run,entry,taskConstraints:{operation:'write'}},true);
      const context=additionalContext({continuation:{sourceRunId:run.runId,savedResources:[],unmet:result.objective.unmet,checks:result.checks}},{},'');
      assert.equal(JSON.parse(context.taskContinuation.value).checks.nativeValidation.errors[0].message,record.nativeValidationErrors[0].message);
    });
    await test('ordinary editing cannot delete a whole resource as a patch workaround', async () => {
      const {CodexSessionService}=require('../src/main/codex-runtime/codexSessionService');
      const workspaceRoot=path.join(root,'deletion-guard');
      const run={runId:'delete-guard',conversationId:'delete-conversation',workspace:{root:workspaceRoot},nativeFileItems:new Map(),taskConstraints:taskConstraintsFor('修改当前章节，只清理格式','',{})};
      const receiver={notificationQueue:Promise.resolve(),_runForProtocolParams:()=>run,ledger:{record:async()=>{}},runRecords:new Map(),_emitEvent:()=>{},_rejectNativeApproval:CodexSessionService.prototype._rejectNativeApproval};
      await assert.rejects(CodexSessionService.prototype._handleServerRequest.call(receiver,'item/fileChange/requestApproval',{itemId:'delete-patch',fileChanges:[{path:path.join(workspaceRoot,'chapters/chapter-001.md'),kind:{type:'delete'},diff:'原文'}]}),e=>e.code==='task_delete_not_requested');
      assert.equal(taskConstraintsFor('删除当前章节','mana-fiction-writing',{}).allowResourceDeletion,true);
      assert.equal(taskConstraintsFor('修改当前章节，不要删除章节','',{}).allowResourceDeletion,false);
      assert.equal(taskConstraintsFor('修改当前章节，不删除章节，也不允许删除角色卡','',{}).allowResourceDeletion,false);
    });
    await test('timeline checks handle canonical boat durations and never assume missing data feasible', async () => {
      const check=args=>getToolByName('check_timeline_feasibility').handler(args).then(r=>r.structuredContent);
      const a={when:'20:20',where:'旧渡口'},b={when:'21:00',where:'灯塔'};
      assert.equal((await check({eventA:a,eventB:b,transport:'boat',minimumTravelMinutes:40})).feasible,true);
      assert.equal((await check({eventA:a,eventB:{...b,when:'20:30'},minimumTravelMinutes:40})).feasible,false);
      assert.equal((await check({eventA:a,eventB:b})).feasible,null);
      assert.equal((await check({eventA:{time:'20:20'},eventB:{time:'21:00'}})).status,'unknown');
      assert.equal((await check({eventA:b,eventB:a,minimumTravelMinutes:40})).feasible,false);
      assert.equal((await check({eventA:{when:'2026-10-18T23:50:00Z',where:'甲'},eventB:{when:'2026-10-19T00:30:00Z',where:'乙'},minimumTravelMinutes:40})).feasible,true);
      assert.equal((await check({eventA:{when:'25:00',where:'甲'},eventB:b,minimumTravelMinutes:40})).status,'unknown');
    });
    await test('same evidence repeated with another line notation is not independent', async () => {
      const duplicated = [evidence[0], { ...evidence[0], location: 'L1' }];
      const row=await recordReview(entry, { text: report(refs, [issue(duplicated)]), items: await Promise.all(refs.map(read)) });
      assert.equal(row.issues[0].evidence.length,1,'duplicate locations collapse to one actual quotation, never independent support');
      assert.equal(row.issues[0].verified,true,'provenance of the one quotation is valid; it does not certify the semantic contradiction');
    });
    await test('malformed issues cannot silently become a clean report', async () => {
      const result = await review({ operation: 'review' }, await Promise.all(refs.map(read)), refs, [{ severity: 'hard' }]);
      assert.equal(result.goalVerified, false);
      const text = report(refs) + '\n```json\n{"coveredResourceRefs":[],"issues":\n```';
      assert.equal((await recordReview(entry, { text, items: await Promise.all(refs.map(read)) })).parsed, false);
      const brokenEvidence = [...evidence, { quote: '缺少资源标识' }];
      assert.equal((await recordReview(entry, { text: report(refs, [issue(brokenEvidence)]), items: await Promise.all(refs.map(read)) })).issues[0].verified, false);
    });
    await test('forged read content with the right hash does not prove coverage', async () => {
      const item = await read(refs[0]);
      item.result.structuredContent.content = '假'.repeat(one.content.length * 5);
      assert.equal((await evaluateTaskResult({ entry, taskConstraints: { operation: 'read', targetResourceRefs: [refs[0]] }, items: [item] }, true)).goalVerified, false);
    });
    await test('new reviews are not erased by an older invalidation event', async () => {
      const text = report(refs, [issue(evidence)]);
      const items = await Promise.all(refs.map(read));
      await recordReview(entry, { text, items });
      assert.deepEqual(await invalidateForResources(entry, [{ resourceRef: refs[0] }]), ['continuity:door:state']);
      await recordReview(entry, { text, items });
      assert.deepEqual(await invalidateForResources(entry, [{ resourceRef: refs[0] }]), ['continuity:door:state']);
    });
    await test('all missing addressable resources are normal not-found results', async () => {
      for (const ref of ['chapter:chapter-999.md', 'chapter-summary:chapter-999.md', 'outline:chapter:99:99:99', 'character:missing', 'character-memory:missing', 'asset:missing']) {
        const result = (await getToolByName('read_novel_resource').handler({ resourceRef: ref }, ctx)).structuredContent;
        assert.equal(result.exists, false);
        assert.equal(result.recoverable, true);
        assert.equal(result.hash, undefined);
      }
    });
    await test('character form preserves object relationships and extended relationship and skin fields', async () => {
      const source = await fs.readFile(path.join(__dirname, '../src/components/CharacterEditDialog.jsx'), 'utf8');
      const body = source.slice(source.indexOf('  const [draft'), source.indexOf('\n  return (', source.indexOf('export function CharacterEditDialog')));
      const split = source.slice(source.indexOf('function splitList'), source.indexOf('\nfunction Field'));
      for (const relationships of [{ su: '相互信任' }, [{ with: '苏绾', type: '信任', evidence: '共同脱险', confidence: 0.9 }]]) {
        const character = { id: 'lin', name: '林岚', relationships, skins: [{ name: '雨衣', custom: '保留字段' }] };
        await vm.runInNewContext('(async()=>{' + split + '\n' + body + '\nawait submit();})()', { character, GENDER_OPTIONS: [], useState: init => [typeof init === 'function' ? init() : init, () => {}], onSave: value => data.writeCharacter(entry.dir, value) });
        const saved = await data.readCharacter(entry.dir, 'lin');
        assert.equal(saved.relationships.length, 1);
        assert.equal(saved.skins[0].custom, '保留字段');
        if (Array.isArray(relationships)) assert.equal(saved.relationships[0].evidence, '共同脱险');
      }
    });
    await test('distinct character IDs never share memory, and legacy memory remains readable', async () => {
      const ids = ['lin+a', 'lin_a', '林甲', 'lin%2Ba', 'LIN', 'lin', 'long' + '名'.repeat(100)];
      for (const id of ids) await data.writeCharacterMemory(entry.dir, { characterId: id, factsKnown: [{ summary: id }] });
      for (const id of ids) assert.equal((await data.readCharacterMemory(entry.dir, id)).factsKnown[0].summary, id);
      const legacy = path.join(entry.dir, 'characters', 'legacy_a.memory.json');
      await fs.writeFile(legacy, JSON.stringify({ characterId: 'legacy+a', factsKnown: [{ summary: '旧文件' }] }));
      assert.equal((await data.readCharacterMemory(entry.dir, 'legacy+a')).factsKnown[0].summary, '旧文件');
      assert.equal(await data.characterMemoryExists(entry.dir, 'legacy_a'), false);
      await data.writeCharacterMemory(entry.dir, { characterId: 'legacy_a', factsKnown: [{ summary: '新角色' }] });
      await data.deleteCharacterMemory(entry.dir, 'legacy_a');
      assert.equal((await data.readCharacterMemory(entry.dir, 'legacy+a')).factsKnown[0].summary, '旧文件');
    });
    await test('negative review clauses and role driven writing preserve user intent', async () => {
      assert.equal(taskConstraintsFor('写下一章，不要自查全书', '', {}).reviewRequired, false);
      assert.equal(taskConstraintsFor('审校本章，不必审校全书', '', { resourceRef: refs[0] }).reviewScope, 'target_resources');
      const payload = await deriveRequirements({ text: '进入角色驱动模式，继续写下一章' });
      assert.equal(payload.skillName, 'mana-character-roleplay');
      assert.equal(payload.taskConstraints.operation, 'write');
      assert.equal(taskConstraintsFor('进入角色驱动模式，在新对话里接续第二章写下一章', '', {}).operation,'write');
      assert.equal(taskConstraintsFor('写下一章，不用写完整结局，不要写2000字', '', {}).requiresCompleteEnding, false);
      assert.equal(taskConstraintsFor('写下一章，不要写2000字', '', {}).minBodyCjk, null);
      assert.equal(taskConstraintsFor('检查角色性别与世界观一致性', '', {}).reviewRequired, true);
      assert.equal((await deriveRequirements({ text: '不要角色驱动，写下一章' })).skillName, undefined);
      assert.equal(taskConstraintsFor('写下一章，写后自我筛查', '', {}).reviewRequired, true);
      const newChapter = taskConstraintsFor('使用传统写作模式，写1500—2000字，保存为新章节。写后自查人物、世界规则和本章收束', '', {});
      assert.equal(newChapter.wordCountScope, 'new_writing');
      assert.equal(newChapter.reviewScope, 'saved_resources');
      await data.writeWorld(entry.dir, { lore: '测试世界观' });
      const partial = taskConstraintsFor('审校本章，不用检查世界观', '', { resourceRef: refs[0] });
      await bindRequirements(entry, partial, '审校本章，不用检查世界观');
      assert.equal(partial.reviewSourceKinds.includes('world'), false);
    });
    await test('requested character memories require actual current commits independently of prose and review', async () => {
      const c=await deriveRequirements({text:'写下一章，更新所有角色记忆'});
      await bindRequirements(entry,c.taskConstraints,c.text);
      assert.ok(c.taskConstraints.requiredWriteResourceRefs.includes('character-memory:lin'));
      const proseOnly=await evaluateTaskResult({entry,taskConstraints:c.taskConstraints,committedResources:[{resourceRef:refs[0],mode:'create',newHash:one.sourceHash}],items:[]},true);
      assert.ok(proseOnly.objective.unmet.includes('required_writes_missing'));
      assert.ok(proseOnly.checks.requiredWrites.missingResourceRefs.includes('character-memory:lin'));
      const unrelated=await deriveRequirements({text:'保存正文，读取所有角色记忆'});
      await bindRequirements(entry,unrelated.taskConstraints,unrelated.text);
      assert.deepEqual(unrelated.taskConstraints.requiredWriteResourceRefs,[]);
      for(const text of ['进入角色驱动模式，读取所有角色已经保存的记忆，不修改任何资料','读取所有角色卡，不更新任何角色记忆']) {
        const readonly=await deriveRequirements({text});await bindRequirements(entry,readonly.taskConstraints,text);
        assert.deepEqual(readonly.taskConstraints.requiredWriteResourceRefs,[]);
      }
    });
    await test('a fully read source supports local review without claiming whole-source review coverage',async()=>{
      const c=await deriveRequirements({text:'修改本章，写后自查世界观',editorContext:{resourceRef:refs[0]}});
      await bindRequirements(entry,c.taskConstraints,c.text);
      const source=await readResource(entry,'world:lore');
      const actual=await readResource(entry,refs[0]);
      const reads=[actual,source].map(r=>({tool:'read_novel_resource',status:'completed',result:{structuredContent:{resourceRef:r.resourceRef,hash:r.sourceHash,mode:'content',offset:0,content:r.content}}}));
      const run={entry,taskConstraints:c.taskConstraints,items:reads,committedResources:[{resourceRef:refs[0],mode:'replace',newHash:actual.sourceHash}]};
      const reviews=[{resourceRef:refs[0],aspects:['world'],conclusion:'依据测试世界观核对局部章节。',limitations:[]}];
      const text='```json\n'+JSON.stringify({coveredResourceRefs:[refs[0]],issues:[],reviews})+'\n```';
      const reviewRecord=await require('../src/main/codex-runtime/reviewLedger').assessReview(entry,{...run,text});
      run.text=text;run.reviewRecord=reviewRecord;
      assert.equal((await evaluateTaskResult(run,true)).goalVerified,false,'writer-supplied analysis cannot replace the hosted review');
      run.reviewSubmission={origin:'host_readonly_analysis'};
      assert.equal((await evaluateTaskResult(run,true)).goalVerified,true);
      assert.ok((await evaluateTaskResult({...run,items:reads.slice(0,1)},true)).checks.review.missingSourceKinds.includes('world'),'missing actual source reading must still fail');
    });
    await test('corrupt project metadata and world places cannot masquerade as empty canonical context', async () => {
      const meta = path.join(entry.dir, 'novel.json');
      const before = await fs.readFile(meta);
      await fs.writeFile(meta, '{broken');
      await assert.rejects(readResource(entry, 'novel:meta'), SyntaxError);
      await fs.writeFile(meta, before);
      await fs.mkdir(path.join(entry.dir, 'world'), { recursive: true });
      await fs.writeFile(path.join(entry.dir, 'world', 'places.json'), '{broken');
      await assert.rejects(readResource(entry, 'world:places'), SyntaxError);
    });
    console.log(`writing-workflow-safety: ok (${passed} scenarios)`);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
