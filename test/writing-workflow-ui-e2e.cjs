'use strict';
// Run with Electron. Uses the production renderer, preload, IPC and isolated disk.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const ROOT = path.resolve(__dirname, '..');
const temp = fsSync.mkdtempSync(path.join(os.tmpdir(), 'mana-writing-ui-audit-'));
process.env.MANA_USER_DATA_ROOT = path.join(temp, 'data');
process.env.MANA_AUTOMATED_TEST = '1';
app.setPath('userData', process.env.MANA_USER_DATA_ROOT);
app.commandLine.appendSwitch('mute-audio');
app.on('web-contents-created', (_event, contents) => contents.setAudioMuted(true));
const evidenceDir = process.env.MANA_WRITING_UI_EVIDENCE_DIR
  ? path.resolve(process.env.MANA_WRITING_UI_EVIDENCE_DIR)
  : path.join(ROOT, 'artifacts/chat-chain-audit/writing-fixed-evidence');
let fake;
let win;
async function wait(expression) {
  const start = Date.now();
  while (Date.now() - start < 45000) {
    if (await win.webContents.executeJavaScript('Boolean(' + expression + ')')) return;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('UI probe timeout: ' + expression);
}
async function shot(name) {
  await win.webContents.executeJavaScript('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
  await fs.writeFile(path.join(evidenceDir, name), (await win.capturePage()).toPNG());
}
async function send(text) {
  await win.webContents.executeJavaScript(`(() => {const el=document.querySelector('[data-testid="codex-input"]'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,${JSON.stringify(text)});el.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await new Promise(r => setTimeout(r, 100));
  await win.webContents.executeJavaScript(`document.querySelector('button[aria-label="发送"]').click()`);
}
app.whenReady().then(async () => {
  await fs.mkdir(evidenceDir, { recursive: true });
  const { createFakeResponsesServer } = require(path.join(ROOT, 'test/fixtures/fake-responses-server'));
  let plan = [];
  let reviewIssues=[],reviewCalls=0,reviewFailure=false;
  let intentGate=null,reviewGate=null,perCharacterIntent=false;
  function reviewPrompt(value) {
    if(typeof value==='string'&&value.startsWith('对冻结正文及资料进行一次只读一致性审查'))return value;
    if(value&&typeof value==='object')for(const child of Object.values(value)){const found=reviewPrompt(child);if(found)return found;}
    return null;
  }
  fake = await createFakeResponsesServer({respondTaskIntent:async(_body,intent)=>{if(intentGate)await intentGate;if(perCharacterIntent){const raw=JSON.parse(intent.text);raw.perspective={mode:'per_character',focusCharacterRef:null,requestQuote:raw.participants.requestQuote};raw.requiredReadResourceRefs=['character-memory:lin','character-memory:he'];return {text:JSON.stringify(raw)};}return intent;}, respond: async body => {
    const prompt=reviewPrompt(body.input);
    if(prompt) {
      if(reviewGate)await reviewGate;
      reviewCalls++;const bundle=JSON.parse(prompt.slice(prompt.indexOf('\n')+1));
      const catalogue=bundle.sources.flatMap(source=>source.lines.filter(line=>line.citationId).map(line=>({resourceRef:source.resourceRef,citationId:line.citationId,quote:line.text})));
      if(reviewFailure)return {text:'invalid structured review'};
      const result=structuredClone({reviews:bundle.targets.map(resourceRef=>({resourceRef,aspects:['timeline','viewpoint','character','world','style','format'],conclusion:'确定性审查接口夹具，不代表实际语义检测。',limitations:[]})),issues:reviewIssues.filter(issue=>issue.status!=='closed').map(issue=>({category:issue.category,severity:issue.severity,contradiction:issue.contradiction,evidence:issue.evidence,affectedResourceRefs:issue.affectedResourceRefs||bundle.targets})),resolutions:reviewIssues.filter(issue=>issue.status==='closed').map(issue=>{
        const known=(bundle.priorFindings||[]).find(previous=>previous.contradiction===issue.contradiction);
        assert.ok(known,'fixture must select an actual prior issue');return {issueId:known.issueId,kind:issue.resolution.kind,explanation:issue.resolution.explanation,evidence:issue.evidence,changes:issue.resolution.changes||[{beforeEvidenceIndex:0,after:issue.evidence[0]}]};
      })});
      function cite(value) {
        if(Array.isArray(value))return value.map(cite);
        if(!value||typeof value!=='object')return value;
        if(value.resourceRef&&value.quote) {
          const candidate=catalogue.find(c=>c.resourceRef===value.resourceRef&&c.quote.includes(value.quote))||catalogue.find(c=>c.resourceRef===value.resourceRef&&value.quote.includes(c.quote));
          assert.ok(candidate,'fixture evidence must select a real citation');return {citationId:candidate.citationId};
        }
        return Object.fromEntries(Object.entries(value).map(([key,child])=>[key,cite(child)]));
      }
      const encoded=cite(result);
      return {text:JSON.stringify(encoded)};
    }
    const next=plan.shift(); return typeof next==='function' ? next(body) : next || { text: '替身回合结束。' };
  } });
  const data = require(path.join(ROOT, 'src/main/store/novelData'));
  const novel = await require(path.join(ROOT, 'src/main/store/novels')).createNovel({ title: '写作功能审计', dir: path.join(temp, 'novel') });
  await data.writeCharacter(novel.dir, { id: 'lin', name: '林岚', personality: '谨慎', relationships: { su: '信任，但尚未告知旧案真相' } });
  await data.writeCharacterMemory(novel.dir, { characterId: 'lin', factsKnown: [{ summary: '旧记忆' }] });
  await data.writeChapterWithMeta(novel.dir, 'chapter-001.md', '城门九点关闭。', {}, { baseContent: '' });
  await data.writeChapterWithMeta(novel.dir, 'chapter-002.md', '十点时守门人说城门从未关闭。', {}, { baseContent: '' });
  await data.writeWorld(novel.dir, { lore: '城门每晚九点关闭。' });
  await require(path.join(ROOT, 'src/main/store/appConfig')).save({ lastNovelId: novel.id, lastNovelDir: novel.dir });
  const model = require(path.join(ROOT, 'src/main/modelConfig'));
  await model.saveCredential({ id: 'fixture', apiKey: 'audit-fixture-secret' });
  await model.saveConnection({ id: 'fixture', name: 'Audit Fixture', credentialId: 'fixture', baseUrl: fake.origin, templateId: 'deepseek', auth: { mode: 'bearer' }, models: [{ id: 'deepseek-v4-flash', name: 'Fixture', verification: { responses: 'ok', tools: 'ok' } }] });
  await model.setActive({ connectionId: 'fixture', modelId: 'deepseek-v4-flash', reasoningEffort: null });
  await require(path.join(ROOT, 'src/main/index')).initBackend();
  win = new BrowserWindow({ width: 1400, height: 1000, webPreferences: { preload: path.join(ROOT, 'preload.js'), nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  await win.loadFile(path.join(ROOT, 'dist/index.html'));
  await wait(`document.querySelector('[data-testid="codex-input"]') && !document.querySelector('[data-testid="codex-input"]').disabled`);
  await win.webContents.executeJavaScript(`document.querySelector('button[title="在编辑器中打开角色卡"]').click()`);
  await wait(`document.querySelector('button[aria-label="编辑角色卡 林岚"]')`);
  await win.webContents.executeJavaScript(`document.querySelector('button[aria-label="编辑角色卡 林岚"]').click()`);
  await wait(`document.querySelector('input[value="su"]')`);
  await win.webContents.executeJavaScript(`document.querySelector('input[value="su"]')?.scrollIntoView({block:'center'})`);
  await shot('relationships-preserved.png');
  await win.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(b=>b.innerText==='保存角色卡').click()`);
  await wait(`document.body.innerText.includes('已保存角色「林岚」')`);
  const after = await data.readCharacter(novel.dir, 'lin');
  assert.deepEqual(after.relationships, [{ with: 'su', type: '信任，但尚未告知旧案真相' }]);
  console.log('TEST_PASS actual character edit save preserves relationships with formal readback');
  const read = ref => ({ namespace: 'mcp__novel_tools', toolName: 'read_novel_resource', arguments: { resourceRef: ref } });
  // These fixture responses exercise transport/coverage; real semantic
  // extraction is tested separately against the live model and saved prose.
  const report = async refs => '审校报告\n```json\n' + JSON.stringify({coveredResourceRefs:refs,issues:[]})+'\n```';
  const settled = async text => {
    await wait(`document.body.innerText.includes(${JSON.stringify(text)}) && !document.querySelector('[data-testid="codex-streaming-message"]') && document.querySelector('[data-testid="codex-chat-panel"]')?.dataset.runState === 'completed'`);
  };
  const objective = text => `[...document.querySelectorAll('[data-testid="task-objective-status"]')].at(-1)?.innerText.includes('${text}')`;
  const findPatch = value => {
    if (typeof value==='string') {
      try{return findPatch(JSON.parse(value))}catch{
        const first=value.indexOf('{'),last=value.lastIndexOf('}');
        if(first>=0&&last>first)try{return findPatch(JSON.parse(value.slice(first,last+1)))}catch{}
        return null;
      }
    }
    if (!value || typeof value!=='object') return null;
    if (value.preparedOnly && typeof value.patch==='string') return value.patch;
    return Object.values(value).reverse().map(findPatch).find(Boolean);
  };
  const applyPrepared=body=>{const patch=findPatch(body.input);assert.ok(patch);return {customToolName:'apply_patch',input:patch};};
  plan = [read('character-memory:lin'),{namespace:'mcp__novel_tools',toolName:'prepare_novel_patch',arguments:{participantCharacterRefs:['character:lin'],changes:[{resourceRef:'character-memory:lin',memoryAppend:{factsKnown:[{summary:'得知钥匙被偷'}]}}]}},applyPrepared,{text:'角色记忆保存完成。'}];
  await send('进入角色驱动模式，保存林岚得知钥匙被偷的角色记忆');
  await wait(`document.querySelector('[data-testid="codex-confirmation-card"]')`);
  await win.webContents.executeJavaScript(`[...document.querySelectorAll('[data-testid="codex-confirmation-card"] button')].find(b=>b.innerText.includes('确认写入')).click()`);
  await settled('角色记忆保存完成。');
  assert.deepEqual((await data.readCharacterMemory(novel.dir,'lin')).factsKnown.map(item=>item.summary),['旧记忆','得知钥匙被偷']);
  await wait(objective('执行证据齐全'));
  assert.ok(fake.requests.some(r => JSON.stringify(r.body.input).includes('<name>mana-character-roleplay</name>')));
  await shot('roleplay-memory-saved.png');
  console.log('TEST_PASS natural roleplay prompt mounts role skill and saves memory with approval');
  plan = [read('chapter:chapter-001.md'), { text: '只读第一章。\n' + await report(['chapter:chapter-001.md']) }];
  await send('审校全书的人物和世界观一致性');
  await settled('只读第一章。');
  await wait(objective('目标尚未完成'));
  await wait(`document.querySelector('[data-testid="task-review-status"]')`);
  await shot('whole-review-incomplete.png');
  console.log('TEST_PASS whole review with one chapter stays incomplete');
  const wholeRefs = ['chapter:chapter-001.md', 'chapter:chapter-002.md', 'character:lin', 'world:lore'];
  plan = [...wholeRefs.map(read),{namespace:'mcp__novel_tools',toolName:'check_writing_task',arguments:{}}, { text: '完整范围审校。' }];
  await send('继续未完成任务');
  await settled('完整范围审校。');
  await wait(objective('执行证据齐全'));
  await shot('whole-review-completed.png');
  console.log('TEST_PASS continuation retains frozen review scope and completes full read/report coverage');
  plan = [read('character:missing'), read('character:lin'), { text: '未找到目标后改查现有角色，本轮继续完成。' }];
  await send('读取不存在的角色卡，找不到时修正查询');
  await settled('未找到目标后改查现有角色，本轮继续完成。');
  assert.equal(await win.webContents.executeJavaScript(`!!document.querySelector('[data-testid="codex-error"]')`), false);
  await win.webContents.executeJavaScript(`[...document.querySelectorAll('summary')].filter(el=>el.innerText==='工具记录').at(-1)?.click()`);
  await shot('missing-character-recovered.png');
  console.log('TEST_PASS missing character is a normal query result and model recovers in the same turn');
  plan = [{ customToolName: 'apply_patch', input: '*** Begin Patch\n*** Add File: chapters/chapter-003.md\n+林岚找回钥匙。\n*** End Patch' }, { text: '只保存正文，尚未自查。' }];
  await send('写下一章，写完自查人物与世界观冲突');
  await wait(`document.querySelector('[data-testid="codex-confirmation-card"]')`);
  await win.webContents.executeJavaScript(`[...document.querySelectorAll('[data-testid="codex-confirmation-card"] button')].find(b=>b.innerText.includes('确认写入')).click()`);
  await settled('只保存正文，尚未自查。');
  await wait(objective('目标尚未完成'));
  assert.ok((await data.readChapter(novel.dir, 'chapter-003.md')).includes('找回钥匙'));
  await shot('post-write-review-required.png');
  console.log('TEST_PASS formal chapter save does not satisfy requested post-write review');
  const writtenRefs = ['chapter:chapter-003.md', 'character:lin', 'world:lore'];
  plan = [...writtenRefs.map(read),{namespace:'mcp__novel_tools',toolName:'check_writing_task',arguments:{}}, { text: '写后自查报告。' }];
  await send('继续未完成任务');
  await settled('写后自查报告。');
  await wait(objective('执行证据齐全'));
  await shot('post-write-review-completed.png');
  console.log('TEST_PASS post-write review continuation preserves formal save and completes evidence');
  plan = [read('../invalid'), read('character:lin'), { text: '参数错误后已改正查询。' }];
  await send('读取角色资料，参数有误时继续修正');
  await settled('参数错误后已改正查询。');
  assert.equal(await win.webContents.executeJavaScript(`!!document.querySelector('[data-testid="codex-error"]')`), false);
  console.log('TEST_PASS malformed read parameters return actual recoverable query error');
  plan = [{ customToolName: 'apply_patch', input: '*** Begin Patch\n*** Delete File: chapters/chapter-001.md\n*** End Patch' }, { text: '整章删除被宿主拦下，本轮未更改正文。' }];
  await send('修改当前章节，只清理格式，不要删除章节');
  await settled('整章删除被宿主拦下，本轮未更改正文。');
  assert.ok((await data.readChapter(novel.dir, 'chapter-001.md')).includes('城门'));
  await wait(`document.body.innerText.includes('本次写作或修改请求不包含整项删除')`);
  assert.equal(await win.webContents.executeJavaScript(`!!document.querySelector('[data-testid="codex-confirmation-card"]')`), false);
  await shot('unrequested-delete-blocked.png');
  console.log('TEST_PASS editing cannot propose whole-resource deletion as a patch workaround');
  const resource = await require('../src/main/mcp/novelResources').readResource(novel,'chapter:chapter-001.md');
  plan = [read(resource.resourceRef), {namespace:'mcp__novel_tools',toolName:'prepare_novel_patch',arguments:{changes:[{resourceRef:resource.resourceRef,replacements:[{oldText:'城门九点关闭。',newText:'城门九点关闭。守卫核对名册。'}]}]}}, body => {
    const patch=findPatch(body.input);assert.ok(patch,'native patch must come from the actual preparation tool result');return {customToolName:'apply_patch',input:patch};
  },read(resource.resourceRef), {namespace:'mcp__novel_tools',toolName:'check_writing_task',arguments:{report:{coveredResourceRefs:[resource.resourceRef],issues:[]}}},{text:'精确修改及审查已完成。'}];
  const userCount=await win.webContents.executeJavaScript(`document.querySelectorAll('[data-testid="codex-message-user"]').length`);
  await send('修改 chapter:chapter-001.md，将“城门九点关闭。”精确改成“城门九点关闭。守卫核对名册。”，写后自查本章');
  await wait(`document.querySelector('[data-testid="codex-confirmation-card"]')`);
  await win.webContents.executeJavaScript(`[...document.querySelectorAll('[data-testid="codex-confirmation-card"] button')].find(b=>b.innerText.includes('确认写入')).click()`);
  await settled('精确修改及审查已完成。');await wait(objective('执行证据齐全'));
  assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('[data-testid="codex-message-user"]').length`),userCount+1,'independent review must not require a second human message');
  assert.equal(await data.readChapter(novel.dir,'chapter-001.md'),'城门九点关闭。守卫核对名册。\n');
  await win.webContents.executeJavaScript(`[...document.querySelectorAll('[data-testid="task-review-report"] summary')].at(-1).click()`);
  await wait(`document.body.innerText.includes('本次报告未列出问题。')`);
  await shot('prepared-patch-structured-review.png');
  console.log('TEST_PASS prepared patch uses current mirror, native approval and formal commit; structured review is revalidated and visible');
  await data.writeCharacter(novel.dir,{id:'he',name:'何芷'});
  await data.writeCharacterMemory(novel.dir,{characterId:'he',factsKnown:[{id:'he-original',summary:'保留原始事实'}]});
  const povRef='chapter:chapter-004.md';
  const issue={issueId:'pov:chapter-004:knowledge',category:'pov',severity:'hard',status:'open',contradiction:'林岚有限视角中直接叙述何芷内心，且林岚并不知道',evidence:[{resourceRef:povRef,location:'L1',quote:'何芷心想船要沉。'},{resourceRef:povRef,location:'L2',quote:'林岚并不知道。'}]};
  const submit=report=>({namespace:'mcp__novel_tools',toolName:'check_writing_task',arguments:{report}});
  reviewIssues=[issue];
  plan=[{customToolName:'apply_patch',input:'*** Begin Patch\n*** Add File: chapters/chapter-004.md\n+何芷心想船要沉。\n+林岚并不知道。\n*** End Patch'},read(povRef),submit({coveredResourceRefs:[povRef],issues:[issue]}),{text:'正文已保存，实际审查发现硬冲突尚未修复。'}];
  await send('使用林岚有限视角写下一章，保存后自查，发现问题修正后交付');
  await wait(`document.querySelector('[data-testid="codex-confirmation-card"]')`);
  await win.webContents.executeJavaScript(`[...document.querySelectorAll('[data-testid="codex-confirmation-card"] button')].find(b=>b.innerText.includes('确认写入')).click()`);
  await settled('正文已保存，实际审查发现硬冲突尚未修复。');await wait(objective('目标尚未完成'));
  await wait(`document.querySelector('[data-testid="task-hard-issues"]')`);
  assert.ok((await data.readChapter(novel.dir,'chapter-004.md')).includes('何芷心想'));
  await shot('semantic-hard-issue-open.png');
  console.log('TEST_PASS prose is not keyword-blocked; an evidence-backed required hard conflict keeps the task incomplete');
  reviewIssues=[];
  plan=[read(povRef),submit({coveredResourceRefs:[povRef],issues:[]}),{text:'提交空报告，没有实际修复。'}];
  await send('继续未完成任务');await settled('提交空报告，没有实际修复。');await wait(objective('目标尚未完成'));
  console.log('TEST_PASS continuation cannot erase known hard conflicts with an empty report');
  const closed={...issue,status:'closed',evidence:[{resourceRef:povRef,location:'L1',quote:'林岚看见何芷攥住舷边。'},issue.evidence[1]],resolution:{kind:'fixed',explanation:'改为焦点可观察的动作，保留她不知道对方内心的事实'}};
  reviewIssues=[closed];
  plan=[read('character:lin'),read(povRef),{namespace:'mcp__novel_tools',toolName:'prepare_novel_patch',arguments:{narrativePerspective:{mode:'limited',focusCharacterRef:'character:lin'},changes:[{resourceRef:povRef,replacements:[{oldText:'何芷心想船要沉。',newText:'林岚看见何芷攥住舷边。'}]}]}},applyPrepared,read(povRef),submit({coveredResourceRefs:[povRef],issues:[closed]}),{text:'实际修复、读回并关闭同一问题。'}];
  await send('继续未完成任务');await wait(`document.querySelector('[data-testid="codex-confirmation-card"]')`);
  await win.webContents.executeJavaScript(`[...document.querySelectorAll('[data-testid="codex-confirmation-card"] button')].find(b=>b.innerText.includes('确认写入')).click()`);
  await settled('实际修复、读回并关闭同一问题。');await wait(objective('执行证据齐全'));
  await shot('semantic-hard-issue-resolved.png');
  console.log('TEST_PASS actual repair and current evidence close the original issue and finish the same task');
  reviewIssues=[];
  await data.writeCharacter(novel.dir,{id:'extra',name:'未参与者'});
  const selected=['character:lin','character:he'];
  const changes=[{resourceRef:'chapter:chapter-005.md',content:'林岚和何芷核对药单，各自记下现场见闻。'},...['lin','he'].map(id=>({resourceRef:'character-memory:'+id,memoryAppend:{factsKnown:[{summary:'在场核对药单'}],lastUpdatedChapterRef:'chapter:chapter-005.md'}}))];
  const stagedCandidate=value=>{if(typeof value==='string'){try{return stagedCandidate(JSON.parse(value))}catch{const first=value.indexOf('{'),last=value.lastIndexOf('}');if(first>=0&&last>first)try{return stagedCandidate(JSON.parse(value.slice(first,last+1)))}catch{}return null;}}if(!value||typeof value!=='object')return null;if(value.preparationId&&(value.draftOnly||value.preparedOnly))return value;return Object.values(value).reverse().map(stagedCandidate).find(Boolean);};
  plan=[read('character-memory:lin'),read('character-memory:he'),{namespace:'mcp__novel_tools',toolName:'prepare_novel_patch',arguments:{participantCharacterRefs:selected,changes:changes.slice(0,2)}},body=>{const staged=stagedCandidate(body.input);assert.ok(staged);assert.equal(staged.preparedOnly,false);assert.equal(staged.patch,undefined);assert.deepEqual(staged.missingResourceRefs,['character-memory:he']);return {namespace:'mcp__novel_tools',toolName:'prepare_novel_patch',arguments:{preparationId:staged.preparationId,changes:changes.slice(2)}};},body=>{const staged=stagedCandidate(body.input);assert.ok(staged);return {namespace:'mcp__novel_tools',toolName:'prepare_novel_patch',arguments:{preparationId:staged.preparationId,changes:[{resourceRef:'chapter:chapter-005.md',replacements:[{oldText:'核对药单',newText:'逐项核对药单'}]}]}};},applyPrepared,{text:'两位参与者的正文和记忆已同批保存。'}];
  await send('角色驱动写下一章，只让林岚、何芷两位角色参与，把两人的新增事实分别写入各自记忆，与正文同一补丁保存，保留原始记忆');
  await wait(`document.querySelector('[data-testid="codex-confirmation-card"]')`);
  await win.webContents.executeJavaScript(`[...document.querySelectorAll('[data-testid="codex-confirmation-card"] button')].find(b=>b.innerText.includes('确认写入')).click()`);
  await settled('两位参与者的正文和记忆已同批保存。');await wait(objective('执行证据齐全'));
  await wait(`document.body.innerText.includes('已绑定 2 位参与角色')`);
  assert.equal((await data.readCharacterMemory(novel.dir,'he')).factsKnown[0].summary,'保留原始事实');
  assert.equal((await data.readCharacterMemory(novel.dir,'lin')).factsKnown.at(-1).summary,'在场核对药单');
  assert.ok((await data.readChapter(novel.dir,'chapter-005.md')).includes('逐项核对药单'));
  await shot('selected-character-memories-bound.png');
  console.log('TEST_PASS named participant subset binds exactly two memories; staged drafts assemble before one atomic native approval');
  await data.writeCharacter(novel.dir,{id:'he',name:'何芷',attributes:{私密信息:'只有何芷知道石匣里有信。'}});
  const auditRef='chapter:chapter-006.md';
  const auditContent='18:10，林岚进院。\n\n林岚等了九分钟。\n\n18:18，她进屋。\n\n她不知道何芷有没有公开石匣里的信。';
  reviewIssues=[
    {issueId:'timeline:chapter-006:window',category:'timeline',severity:'hard',status:'open',contradiction:'八分钟窗口容不下九分钟等待。',evidence:[{resourceRef:auditRef,quote:'林岚等了九分钟。'},{resourceRef:auditRef,quote:'18:18，她进屋。'}]},
    {issueId:'knowledge:chapter-006:letter',category:'knowledge',severity:'hard',status:'open',contradiction:'焦点未知的信被正文预设属实。',evidence:[{resourceRef:auditRef,quote:'石匣里的信'},{resourceRef:'character:he',quote:'只有何芷知道石匣里有信。'}]},
  ];
  const beforeReview=reviewCalls;
  plan=[read('character:lin'),read('character:he'),{namespace:'mcp__novel_tools',toolName:'prepare_novel_patch',arguments:{narrativePerspective:{mode:'limited',focusCharacterRef:'character:lin'},changes:[{resourceRef:auditRef,content:auditContent}]}},applyPrepared,read(auditRef),submit({coveredResourceRefs:[auditRef],issues:[]}),submit({coveredResourceRefs:[auditRef],issues:[]}),{text:'作者空报告不能覆盖独立审查报告中的时间和视角问题。'}];
  await send('用林岚第三人称有限视角写下一章，保存后自查时间和人物信息，发现问题修好再交付');
  await wait(`document.querySelector('[data-testid="codex-confirmation-card"]')`);
  await win.webContents.executeJavaScript(`[...document.querySelectorAll('[data-testid="codex-confirmation-card"] button')].find(b=>b.innerText.includes('确认写入')).click()`);
  await settled('作者空报告不能覆盖独立审查报告中的时间和视角问题。');await wait(objective('目标尚未完成'));
  await wait(`[...document.querySelectorAll('[data-testid="task-hard-issues"] summary')].at(-1)?.innerText.includes('2 项')`);
  await win.webContents.executeJavaScript(`[...document.querySelectorAll('[data-testid="task-narrative-audit"] summary')].at(-1).click()`);
  await shot('narrative-witness-conflicts.png');
  assert.equal(await data.readChapter(novel.dir,'chapter-006.md'),auditContent+'\n','legal saves remain available while task acceptance fails');
  assert.equal(reviewCalls,beforeReview+1,'same version is reviewed once; empty writer reports cannot override or repeat it');
  console.log('TEST_PASS independent review findings retain time and limited-view conflicts despite empty author reports');
  reviewIssues=[];
  reviewFailure=true;
  const beforeFailure=reviewCalls;
  plan=[read(auditRef),{namespace:'mcp__novel_tools',toolName:'check_writing_task',arguments:{}},{namespace:'mcp__novel_tools',toolName:'check_writing_task',arguments:{}},{text:'审查服务本版本失败，不能当作检查通过。'}];
  await send('审校 chapter:chapter-006.md 的人物与世界观一致性，只报告不要修改');
  await settled('审查服务本版本失败，不能当作检查通过。');await wait(objective('目标尚未完成'));
  assert.equal(reviewCalls,beforeFailure+1,'a failed analysis is cached rather than silently retried');
  await shot('narrative-review-failure-cached.png');
  console.log('TEST_PASS read-only review failure stays incomplete and cannot trigger a second inference for the same version');
  reviewFailure=false;
  // Exercise the staged path itself: a real native patch/approval with a
  // deterministic short-draft fixture, not just the legacy author save path.
  const service=require('../src/main/codex-runtime').getCodexSessionService();
  const nativeStart=service._startNativeTurn.bind(service);
  const shortRef='chapter:chapter-008.md',shortContent='稿'.repeat(1324)+'\n';
  let shortRun;
  service._startNativeTurn=async params=>{
    const parent=[...service.activeRuns.values()].find(r=>r.entry&&!r.purpose&&!r.turnId&&r.threadId===params.threadId);
    if(!parent||shortRun)return nativeStart(params);
    shortRun=parent;
    const adapter=require('../src/main/codex-runtime/writingPreparationStage');
    try {
      await adapter.prepareStage(service,parent,{text:'短稿保存协议夹具，仅验证保存和未完成状态。',outputSchema:{type:'object',properties:{changes:{type:'array',items:{type:'object',properties:{resourceRef:{type:'string'},content:{type:'string'}},required:['resourceRef','content'],additionalProperties:false}}},required:['changes'],additionalProperties:false}});
      return nativeStart({...params,input:await adapter.commitInput(service,parent)});
    } finally {service._startNativeTurn=nativeStart;}
  };
  plan=[{text:JSON.stringify({changes:[{resourceRef:shortRef,content:shortContent}]})},()=>({namespace:'mcp__novel_tools',toolName:'prepare_novel_patch',arguments:{preparationId:shortRun.preparationStage.candidate.preparationId,expectedRevision:shortRun.preparationStage.candidate.revision}}),applyPrepared,{text:'原生提交结束。'}];
  await send('新写一章，正文1500—2000字，保存已有草稿。');
  await wait(`document.querySelector('[data-testid="codex-confirmation-card"]')`);
  await win.webContents.executeJavaScript(`[...document.querySelectorAll('[data-testid="codex-confirmation-card"] button')].find(b=>b.innerText.includes('确认写入')).click()`);
  await settled('正文 1324 字。');await wait(objective('目标尚未完成'));
  await wait(`[...document.querySelectorAll('[data-testid="task-word-count"]')].at(-1)?.innerText.includes('尚差 176 字')`);
  assert.equal(await data.readChapter(novel.dir,'chapter-008.md'),shortContent);
  const shortState=await service.getRunState({runId:shortRun.runId});
  assert.equal(shortState.status,'completed');assert.equal(shortState.taskResult.persistence.status,'saved');assert.equal(shortState.taskResult.goalVerified,false);
  assert.deepEqual(shortState.taskResult.objective.unmet,['word_count']);assert.equal(shortState.taskResult.checks.wordCount.toleranceRatio,0);
  assert.equal(plan.length,0,'one preparation and one native commit, no automatic rewriting');
  await shot('staged-short-draft-saved.png');
  console.log('TEST_PASS staged 1324-character draft saves through native approval; zero-tolerance 1500–2000 target stays incomplete with 176-character deficit');
  const beforeStopUsers=await win.webContents.executeJavaScript(`document.querySelectorAll('[data-testid="codex-message-user"]').length`);
  plan=[read('character:lin'),{text:'只读资料，未实际起稿。'}];
  await send('写下一章并保存，写后自查');await settled('只读资料，未实际起稿。');await wait(objective('目标尚未完成'));
  assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('[data-testid="codex-message-user"]').length`),beforeStopUsers+1);
  const stageRows=(await fs.readFile(path.join(process.env.MANA_USER_DATA_ROOT,'codex-task-ledger.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(stageRows.some(row=>['writing_review_started','writing_recovery_started','writing_review_context_created'].includes(row.type)),false,'host must never silently add model turns to make a task pass');
  assert.equal(plan.length,0);
  await shot('incomplete-without-automatic-retry.png');
  console.log('TEST_PASS early ending remains incomplete without hidden recovery or additional model turns');
  let releaseIntent;intentGate=new Promise(resolve=>{releaseIntent=resolve;});
  plan=[{text:'取消后不应启动作者。'}];
  await send('写下一章并保存，写后自查');
  await wait(`document.querySelector('[data-testid="task-intent-running"]')`);
  await win.webContents.executeJavaScript(`document.querySelector('button[aria-label="停止"]').click()`);
  await wait(`document.querySelector('[data-testid="codex-chat-panel"]')?.dataset.runState === 'interrupted'`);
  releaseIntent();intentGate=null;
  await new Promise(resolve=>setTimeout(resolve,700));
  assert.equal(plan.length,1,'stopping scope parsing must not start an author turn');plan=[];
  await shot('task-intent-cancelled.png');
  console.log('TEST_PASS stopping task scope parsing remains interrupted and cannot start the author');
  const reviewBodyBefore=await data.readChapter(novel.dir,'chapter-001.md');
  let releaseReview;reviewGate=new Promise(resolve=>{releaseReview=resolve;});
  plan=[read('chapter:chapter-001.md'),{namespace:'mcp__novel_tools',toolName:'check_writing_task',arguments:{}},{text:'停止后不应作为最终答复发布。'}];
  await send('审校 chapter:chapter-001.md 的时间一致性，只报告不要修改');
  await wait(`document.querySelector('[data-testid="narrative-review-running"]')`);
  const reviewParent=[...service.activeRuns.values()].find(run=>run.entry&&!run.purpose);
  assert.ok(reviewParent);
  await win.webContents.executeJavaScript(`document.querySelector('button[aria-label="停止"]').click()`);
  await wait(`document.querySelector('[data-testid="codex-chat-panel"]')?.dataset.runState === 'interrupted'`);
  releaseReview();reviewGate=null;
  await new Promise(resolve=>setTimeout(resolve,700));
  const cancelledReview=await service.getRunState({runId:reviewParent.runId});
  assert.equal(cancelledReview.status,'interrupted');assert.equal(cancelledReview.reviewSubmission,null);
  assert.equal(cancelledReview.narrativeReview?.status==='completed',false);
  assert.equal(await data.readChapter(novel.dir,'chapter-001.md'),reviewBodyBefore);
  assert.equal(plan.length,1,'stopping independent review must not dispatch the remaining author response');plan=[];
  await shot('narrative-review-cancelled.png');
  console.log('TEST_PASS stopping independent review preserves interrupted state, rejects late review output and keeps formal prose unchanged');
  perCharacterIntent=true;plan=[read('character-memory:lin'),read('character-memory:he'),{text:'分别按本人记忆作答，未保存。'}];
  await send('只让林岚和何芷参与，读取两人记忆，分别按本人记忆作答，不保存。');
  await settled('分别按本人记忆作答，未保存。');perCharacterIntent=false;
  await win.webContents.executeJavaScript(`document.querySelectorAll('[data-testid="task-intent"]').forEach(el=>el.open=true)`);
  await wait(`document.body.innerText.includes('逐角色分别作答')`);
  await shot('per-character-readonly-responses.png');
  console.log('TEST_PASS separate character responses bind no single focal narrator and remain readonly');
  await fs.writeFile(path.join(evidenceDir,'results.json'),JSON.stringify({date:new Date().toISOString(),checks:21,characterRelationshipsAfterSave:after.relationships},null,2)+'\n');
  await fake.close();
  win.destroy();
  await fs.rm(temp, { recursive: true, force: true });
  app.exit(0);
}).catch(async error => {
  console.error(error);
  if (win) await shot('ui-probe-failure.png').catch(() => {});
  if (fake) await fake.close();
  app.exit(1);
});
