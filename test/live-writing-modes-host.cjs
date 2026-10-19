'use strict';
// Opt-in real-login study. No fake provider, tool responses or generated prose.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const sync = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const ROOT = path.resolve(__dirname, '..');
const OUT = path.resolve(process.env.MANA_STUDY_ROOT || path.join(ROOT, 'artifacts/chat-chain-audit', `luna-writing-modes-${new Date().toISOString().replace(/[:.]/gu,'-')}`));
const PRIVATE = process.env.MANA_STUDY_PRIVATE_ROOT || sync.mkdtempSync(path.join(os.tmpdir(), 'mana-real-luna-writing-'));
process.env.MANA_USER_DATA_ROOT = path.join(PRIVATE, 'data');
process.env.MANA_AUTOMATED_TEST = '1';
app.setPath('userData', process.env.MANA_USER_DATA_ROOT);
app.commandLine.appendSwitch('mute-audio');
app.on('web-contents-created', (_, c) => c.setAudioMuted(true));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (file, data) => sync.appendFileSync(path.join(OUT, file), JSON.stringify({ at: new Date().toISOString(), ...data }) + '\n');
const save = (file, data) => fs.writeFile(path.join(OUT, file), JSON.stringify(data, null, 2) + '\n');
let win, service, current = null, novel;
const evaluate = code => win.webContents.executeJavaScript(code, true);
async function wait(code, ms = 60000) {
  const at = Date.now();
  while (Date.now() - at < ms) { if (await evaluate(`Boolean(${code})`)) return; await sleep(200); }
  throw new Error('UI timeout: ' + code);
}
async function shot(name) {
  await evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
  await fs.writeFile(path.join(OUT, 'screenshots', name + '.png'), (await win.webContents.capturePage()).toPNG());
}
async function input(text) {
  await evaluate(`(()=>{const e=document.querySelector('[data-testid="codex-input"]');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(text)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await sleep(100);
}
async function inventory() {
  const data = require('../src/main/store/novelData');
  const chapters = {};
  for (const name of await fs.readdir(path.join(novel.dir, 'chapters'))) if (name.endsWith('.md')) chapters[name] = await data.readChapter(novel.dir, name);
  const memories = {};
  for (const id of ['lin', 'su', 'he', 'ye', 'lu', 'cen']) memories[id] = await data.readCharacterMemory(novel.dir, id);
  return { chapters, memories };
}
async function seed() {
  if(sync.existsSync(path.join(OUT,'novel/novel.json'))) throw new Error('Study novel already exists; use a fresh MANA_STUDY_ROOT or MANA_STUDY_RESUME=1');
  const d = require('../src/main/store/novelData');
  novel = await require('../src/main/store/novels').createNovel({ title: '雾港六人局·双模式实测', dir: path.join(OUT, 'novel') });
  const rows = [
    ['lin','林岚','验潮员','谨慎、重证据，短句，不轻信誓言','查出潮钟误差，保护弟弟','只知道潮钟慢了七分钟；不知道药箱暗格和密道口令','保留一页抄本，未告诉任何人','与苏砚合作但防备，与何芷互相尊重'],
    ['su','苏砚','巡港队长','守程序，话少，不滥用武力','在封桥前合法完成交接','知道通行证须双印；不知道慢七分钟和药箱暗格','父亲卷入旧案，不愿公开','信林岚的测量，怀疑陆行舟'],
    ['he','何芷','医师','温和但边界坚定，以具体症状说服人','把冷藏药送到灯塔诊所','仅她知道药箱暗格有蓝签账页；她尚未透露','蓝签账页藏在药箱暗格','信叶澄的操船，不信岑寂的委托'],
    ['ye','叶澄','摆渡人','敏锐、务实，说话带水路术语','保住执照与船员','知道低潮碎石滩危险、渡口至灯塔航程四十分钟；不知道暗格和七分钟','听到船底异响，尚不能判断原因','欠何芷人情，与陆行舟争运价'],
    ['lu','陆行舟','钟匠','嘴快但操作谨慎，遇证据才认错','修好潮钟并洗清偷芯嫌疑','知道自己没有换过钟芯；不知道慢了几分钟','看到岑寂昨夜进过钟楼，但不知做了什么','怕苏砚拘捕，愿向林岚展示工具'],
    ['cen','岑寂','议事厅文书','礼貌含糊，擅用被动句','阻止旧账公开但不伤及病人','知道议事厅今夜要收走蓝签账页；不知道藏处，不知道密道口令','昨夜进钟楼取公文，没有改钟','试探何芷，向苏砚强调程序'],
  ];
  for (const [id,name,role,personality,goal,known,secret,relations] of rows) {
    await d.writeCharacter(novel.dir, { id,name,role,personality,attributes:{欲望:goal,已知信息:known,隐瞒事实:secret,关系:relations},relationships: rows.filter(r=>r[0]!==id).map(r=>({with:r[0],type:relations.includes(r[1])?relations:'认识但无私下信息共享'})) });
    await d.writeCharacterMemory(novel.dir, { characterId:id, factsKnown:[{id:id+'-initial',summary:known,sourceChapterRef:'chapter:chapter-001.md'}],privateMisbeliefs:[],unresolvedIntentions:[{id:id+'-goal',summary:goal}],lastUpdatedChapterRef:'chapter:chapter-001.md' });
  }
  const lore = `# 雾港世界设定\n## 地理与时间\n雾港为潮汐岛城，北岸旧渡口、中央钟楼、东侧封桥、西侧灯塔诊所。当前为秋汛第六日，阴雨、能见度不足两百米。所有时间用二十四小时制。\n旧渡口到灯塔水路四十分钟，步行绕北堤九十分钟；钟楼到渡口步行十五分钟。不存在瞬移、飞行、瞬间传信。\n封桥时间为21:00，封桥只关闭东桥，不关闭水路；渡船仍须执照和通行证。\n低潮始于20:30，碎石滩不可拖曳重船；正规航道可航行但不得缩短四十分钟。\n## 制度\n冷藏药出港须巡港队长与医师各盖一印，缺一不可。议事厅文书的公文不能代替医师签字。\n居民不允许强行搜身，须经队长立案和当事人见证；拘捕不能仅凭怀疑。\n潮钟只是公共时钟，不控制潮水、封桥和天气；校时须与机械怀表及潮表两种来源核对。\n## 技术与物资\n只有机械钟、油灯、纸张、蒸汽冷柜，无电报、手机、监控或魔法。船用手摇绞盘，不存在自动驾驶。\n药箱铅封完整，开启外箱会破坏铅封；暗格可在保持铅封时滑出，但外人看不出位置。冷藏药离开冰柜后只能保存六十分钟。\n蓝签账页只是旧账证据，不能凭一页直接定罪。证据需核对年月、页码、签章。\n## 信仰与信息边界\n灯塔守夜人相信海雾会记住名字，这是信仰而非客观超能力。\n角色私密信息不自动共享；只有在场听到或看到具体证据才能成为角色已知事实。\n第1章结束于20:05，六人刚在旧渡口集齐，所有人尚未启航。何芷未说出暗格，林岚未说出七分钟。\n`;
  await d.writeWorld(novel.dir,{lore,places:[{id:'pier',name:'旧渡口',description:'北岸，通向灯塔正规水路四十分钟'},{id:'tower',name:'钟楼',description:'步行到旧渡口十五分钟'},{id:'clinic',name:'灯塔诊所',description:'西侧，病人等冷藏药'}]});
  await d.writeStyleMemory(novel.dir,'第三人称有限视角，一场只跟随一个焦点人物。用动作和对话呈现冲突，不给他人直接内心独白。禁用现代技术和网络词。不要每段总结，不用命运齿轮、眸光一闪等套话。场景末完成当场决定，可保留后续悬念。');
  await d.writeChapterWithMeta(novel.dir,'chapter-001.md','# 第一章 雾口\n\n20:05，六人聚在旧渡口。林岚把潮表压在木箱边，机械怀表还在她袖口。她确认潮钟慢了七分钟，却未开口。\n\n何芷将铅封完整的冷藏药箱放回冰柜，蓝签账页藏在只有她知道的暗格。苏砚摊开尚未盖印的通行证，要求先核对药单。\n\n叶澄检查船绳，提醒水路四十分钟。陆行舟抱着工具袋，不敢直视队长。岑寂带来议事厅的交接公文，没人看见他此前进过钟楼。\n\n远处钟声响起。林岚看着六人的影子，没有拿出那页抄本。',{},{baseContent:''});
  await fs.writeFile(path.join(novel.dir,'outlines/outline.md'),'# 总纲\n六人在封桥前运送冷藏药，因时间、程序和隐藏的账页相互试探。最终依据证据达成有限信任。不得一次揭开所有秘密。\n第二章20:05—20:20，林岚视角，在渡口完成双印和是否启航的决定，不必抵达灯塔。\n第三章紧接第二章，用角色主观动机推动阻力、选择与后果。');
  let priorChapter=null;
  if(process.env.MANA_STUDY_CHAPTER2_FIXTURE) {
    const source=path.resolve(process.env.MANA_STUDY_CHAPTER2_FIXTURE);const content=await fs.readFile(source,'utf8');
    await d.writeChapterWithMeta(novel.dir,'chapter-002.md',content,{}, {baseContent:''});
    priorChapter={source,hash:require('node:crypto').createHash('sha256').update(content).digest('hex')};
  }
  let priorChapter3=null;
  if(process.env.MANA_STUDY_CHAPTER3_FIXTURE) {
    const source=path.resolve(process.env.MANA_STUDY_CHAPTER3_FIXTURE);const content=await fs.readFile(source,'utf8');
    await d.writeChapterWithMeta(novel.dir,'chapter-003.md',content,{}, {baseContent:''});
    priorChapter3={source,hash:require('node:crypto').createHash('sha256').update(content).digest('hex')};
  }
  await require('../src/main/store/appConfig').save({lastNovelId:novel.id,lastNovelDir:novel.dir});
  await save('fixture.json',{novelId:novel.id,characterCount:rows.length,worldRules:13,novelDir:novel.dir,priorChapter,priorChapter3});
}
async function execute(c) {
  if(c.requireCompletedTaskFrom) {
    const previous=(await fs.readFile(path.join(OUT,'results.jsonl'),'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse).find(r=>r.id===c.requireCompletedTaskFrom);
    const terminal=previous?.result?.events?.findLast(e=>e.type==='turn_completed');
    if(!terminal?.taskResult?.goalVerified)throw new Error('前置任务未完成，不能把后续独立请求计作完整流程验证：'+c.requireCompletedTaskFrom);
  }
  if(c.action==='seedFormatRegression') {
    if(service.activeRuns.size)throw new Error('Regression fixture may only be seeded while idle');
    const d=require('../src/main/store/novelData');
    const before=await d.readChapter(novel.dir,c.file);
    let count=0;
    const content=before.replace(/。(?=\n)/gu,match=>count++<4?match+'\\n+':match);
    if(count<4)throw new Error('Fixture requires four existing paragraph ends');
    await d.writeChapterWithMeta(novel.dir,c.file,content,{}, {baseContent:before});
    // The fixture is an out-of-band disk edit. Reload before testing the user
    // cleanup flow so it cannot accidentally test a stale editor save instead.
    win.webContents.reload();
    await wait(`document.querySelector('[data-testid="codex-input"]')&&!document.querySelector('[data-testid="codex-input"]').disabled`);
    await save(c.id+'-fixture.json',{kind:'literal-escape-regression',file:c.file,before,content,injectedFragments:4});
    return {injectedFragments:4};
  }
  if (c.action==='screenshot') {await shot(c.id);return {body:await evaluate('document.body.innerText')}}
  if (c.action==='openChapter') {
    await wait(`document.querySelector('[data-chapter-file="${c.file}"]')`);
    await evaluate(`document.querySelector('[data-chapter-file="${c.file}"]').click()`);await sleep(500);await shot(c.id);
    return {body:await evaluate('document.body.innerText')};
  }
  if (c.action==='newConversation') {
    await evaluate(`document.querySelector('[data-testid="codex-chat-panel"] > div > div button')?.click()`);
    await wait(`[...document.querySelectorAll('button')].some(b=>b.innerText.trim()==='新对话')`);
    await evaluate(`[...document.querySelectorAll('button')].find(b=>b.innerText.trim()==='新对话').click()`);
    await wait(`document.querySelectorAll('[data-testid^="codex-message-"]').length===0&&!document.querySelector('[data-testid="codex-input"]')?.disabled`);await sleep(300);return {};
  }
  if(c.action==='selectConversation') {
    await evaluate(`document.querySelector('button[aria-label="对话列表"]').click()`);
    await wait(`document.querySelectorAll('aside button[aria-label="删除对话"]').length>${Number(c.index)}`);
    await evaluate(`document.querySelectorAll('aside button[aria-label="删除对话"]')[${Number(c.index)}].parentElement.querySelector('button').click()`);
    await wait(`!document.querySelector('aside button[aria-label="关闭对话列表"]')&&document.querySelector('[data-testid="codex-message-user"]')&&!document.querySelector('[data-testid="codex-input"]')?.disabled`);await sleep(300);return {};
  }
  if (c.action==='turn') {
    await wait(`document.querySelector('[data-testid="codex-input"]')&&!document.querySelector('[data-testid="codex-input"]').disabled&&!document.querySelector('button[aria-label="停止"]')`);
    await input(c.text);current.events=[];current.confirmations=[];
    // Opt-in protocol probe only. Ordinary chat is unchanged: this installs the
    // production handoff adapter before its first native author dispatch, then
    // uses the actual renderer, native tools and approval UI. No output stubs.
    const nativeStart=service._startNativeTurn.bind(service);
    let handoffUsed=false;
    if(c.preparationHandoff)service._startNativeTurn=async params=>{
      const run=[...service.activeRuns.values()].find(r=>r.threadId===params.threadId&&r.entry&&!r.purpose&&!r.turnId);
      if(!run||handoffUsed)return nativeStart(params);
      handoffUsed=true;
      const adapter=require('../src/main/codex-runtime/writingPreparationStage');
      let stopTimer;
      if(c.stopPreparation)stopTimer=setTimeout(()=>service.interrupt({runId:run.runId}),100);
      try {
        const candidate=await adapter.prepareStage(service,run,{text:c.preparationHandoff.text,outputSchema:c.preparationHandoff.schema});
        await save(c.id+'-prepared.json',{candidate,parentRunId:run.runId,stage:run.preparationStage,parentActive:service.activeRuns.has(run.runId),projectOwner:service.projectRuns.get(run.entry.id)});
        if(c.conflictAfterPreparation) {
          const memory=await require('../src/main/store/novelData').readCharacterMemory(novel.dir,'lin');
          memory.unresolvedIntentions.push({id:'concurrent-edit',summary:'并发用户编辑，必须保留'});
          await require('../src/main/store/novelData').writeCharacterMemory(novel.dir,memory);
        }
        const commit=await adapter.commitInput(service,run);
        return nativeStart({...params,input:commit});
      } finally {clearTimeout(stopTimer);service._startNativeTurn=nativeStart;}
    };
    const at=Date.now();await evaluate(`document.querySelector('button[aria-label="发送"]').click()`);
    await wait(`document.querySelector('button[aria-label="停止"]')||document.querySelector('[data-testid="codex-error"]')`,20000);
    const approved=new Set();let last=0;
    while(Date.now()-at<(c.timeoutMs||600000)) {
      const state=await evaluate(`({running:!!document.querySelector('button[aria-label="停止"]'),error:document.querySelector('[data-testid="codex-error"]')?.innerText,preview:document.querySelector('[data-testid="codex-confirmation-card"]')?.innerText})`);
      if(state.preview&&Date.now()-last>1000) {
        const key=[...service.pendingConfirmations.keys()].at(-1);
        if(key&&!approved.has(key)) {
          const pending=service.pendingConfirmations.get(key);
          const unexpectedDelete=pending?.nativeChanges?.some(change=>change.kind?.type==='delete')&&c.allowDelete!==true;
          const outsideScope=c.allowedWriteRefs?.length&&pending?.nativeChanges?.some(change=>!c.allowedWriteRefs.includes(change.resourceRef));
          const decline=c.decline||unexpectedDelete||outsideScope;
          approved.add(key);current.confirmations.push({key,preview:state.preview,decision:decline?'decline':'accept'});
          await evaluate(`document.querySelector('[data-testid="codex-confirmation-card"]').scrollIntoView({block:'center'})`);await shot(c.id+'-approval-'+approved.size);
          await evaluate(`[...document.querySelectorAll('[data-testid="codex-confirmation-card"] button')].find(b=>b.innerText.includes(${JSON.stringify(decline?'拒绝':'确认写入')})&&!b.disabled)?.click()`);last=Date.now();
        }
      }
      if(!state.running) {await sleep(500);service._startNativeTurn=nativeStart;await shot(c.id);await save(c.id+'-readback.json',await inventory());return {durationMs:Date.now()-at,...state,handoffUsed,body:await evaluate('document.body.innerText'),events:current.events,confirmations:current.confirmations}}
      await sleep(300);
    }
    await evaluate(`document.querySelector('button[aria-label="停止"]')?.click()`);throw new Error('Observation limit '+(Date.now()-at));
  }
  if(c.action==='shutdown'){await service.dispose();app.exit(0);return {}}
  throw new Error('Unknown command');
}
app.whenReady().then(async()=>{
  await fs.mkdir(path.join(OUT,'screenshots'),{recursive:true});
  await save('private-session.json',{privateRoot:PRIVATE});
  // Keep login material only in the temporary private directory, never artifacts.
  await fs.mkdir(path.join(process.env.MANA_USER_DATA_ROOT,'codex-home'),{recursive:true,mode:0o700});
  const auth=path.join(os.homedir(),'.codex/auth.json');
  if(sync.existsSync(auth)){const dest=path.join(process.env.MANA_USER_DATA_ROOT,'codex-home/auth.json');if(!sync.existsSync(dest))await fs.copyFile(auth,dest);await fs.chmod(dest,0o600);}
  // Explicit opt-in host runtime override for testing models newer than the bundled runtime.
  if (process.env.MANA_STUDY_CODEX_BINARY) {
    const {CodexProcessManager}=require('../src/main/codex-runtime/processManager');
    const nativeStart=CodexProcessManager.prototype._start;
    CodexProcessManager.prototype._start=function(){this.binary=process.env.MANA_STUDY_CODEX_BINARY;return nativeStart.call(this)};
  }
  if(process.env.MANA_STUDY_RESUME==='1') {
    novel=await require('../src/main/store/novels').importExistingNovel(path.join(OUT,'novel'));
    await require('../src/main/store/appConfig').save({lastNovelId:novel.id,lastNovelDir:novel.dir});
  } else await seed();
  await require('../src/main/index').initBackend();
  service=require('../src/main/codex-runtime').getCodexSessionService();
  service.on('event',e=>{
    // Do not repeat the complete growing transcript on every streamed token.
    const {runState,...event}=e;
    const compact={...event,...(e.type==='turn_started'?{modelId:runState?.modelId||event.modelId,taskConstraints:runState?.taskConstraints||event.taskConstraints}:{})};
    log('events.jsonl',{command:current?.id,...compact});
    if(current?.events&&e.type!=='text_delta')current.events.push(compact);
  });
  const account=await service.accountStatus();
  await save('account-status.json',{type:account.account?.type||null,requiresOpenaiAuth:account.requiresOpenaiAuth});
  const resumedModels=process.env.MANA_STUDY_RESUME==='1'?await require('../src/main/modelConfig').publicSnapshot():null;
  const models=resumedModels?.connections.some(c=>c.kind==='codexSubscription'&&c.models?.length)?{state:resumedModels}:process.env.MANA_STUDY_SKIP_TOKEN_REFRESH==='1'?await (async()=>{
    // Reuse a still-valid, already authenticated isolated test session. Model
    // availability still comes from the REAL server; no fabricated catalogue.
    if(account.account?.type!=='chatgpt')throw new Error('Real subscription account unavailable');
    const result=await service.processManager.request('model/list',{limit:100});
    const actual=(result.data||[]).filter(m=>m.id&&m.id!=='auto'&&!m.hidden).map(m=>({id:m.id,name:m.displayName||m.id,capabilities:{supportsTools:true,reasoningEfforts:(m.supportedReasoningEfforts||[]).map(e=>e.reasoningEffort||e)}}));
    return {state:await require('../src/main/modelConfig').saveCodexSubscription(actual)};
  })():await service.refreshSubscriptionModels();
  const available=models.state.connections.find(c=>c.kind==='codexSubscription')?.models||[];
  await save('available-models.json',available);
  const selected=available.find(m=>m.id==='gpt-6-luna');
  if(!selected)throw new Error('gpt-6-luna unavailable; refusing model substitution');
  await require('../src/main/modelConfig').setActive({connectionId:'codex-subscription',modelId:selected.id,reasoningEffort:'medium'});
  win=new BrowserWindow({width:1440,height:1000,webPreferences:{preload:path.join(ROOT,'preload.js'),nodeIntegration:false,contextIsolation:true,sandbox:true,backgroundThrottling:false}});
  win.webContents.on('console-message',(_e,level,message)=>{if(level>=2)log('renderer-errors.jsonl',{level,message})});
  await win.loadFile(path.join(ROOT,'dist/index.html'));
  await wait(`document.querySelector('[data-testid="codex-input"]')&&!document.querySelector('[data-testid="codex-input"]').disabled`);
  await shot('ready');await save('status.json',{ready:true,pid:process.pid,model:selected.id,effort:'medium',muted:win.webContents.isAudioMuted(),privateRoot:PRIVATE});
  const completed=new Set((await fs.readFile(path.join(OUT,'results.jsonl'),'utf8').catch(()=>'')).trim().split('\n').filter(Boolean).map(x=>JSON.parse(x).id));
  setInterval(()=>save('status.json',{ready:true,pid:process.pid,model:selected.id,effort:'medium',muted:win.webContents.isAudioMuted(),privateRoot:PRIVATE,current:current?.id,completed:[...completed]}),3000);
  while(true){const list=JSON.parse(await fs.readFile(path.join(OUT,'commands.json'),'utf8').catch(()=>'[]'));const c=list.find(c=>!completed.has(c.id));if(!c){await sleep(500);continue}current={...c};log('starts.jsonl',c);try{log('results.jsonl',{id:c.id,ok:true,result:await execute(c)})}catch(e){log('results.jsonl',{id:c.id,ok:false,error:e.stack});if(win)await shot(c.id+'-failure')}completed.add(c.id);current=null;}
}).catch(async e=>{await fs.mkdir(OUT,{recursive:true});log('fatal.jsonl',{error:e.stack});console.error(e);app.exit(1)});
