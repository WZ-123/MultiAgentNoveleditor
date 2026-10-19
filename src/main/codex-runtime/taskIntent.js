'use strict';

// Interpret the user's task once, before the author runs. This is a semantic
// interpretation with a visible receipt, never a proof of prose correctness.
const {listResourceDescriptors,readResource}=require('../mcp/novelResources');
const {contractError}=require('./contracts');
const {normalizeTaskConstraints}=require('./taskLedger');
const object=properties=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
async function intentInput(entry,text,constraints) {
  const catalogue=await listResourceDescriptors(entry);
  // Addressable virtual resources (e.g. an absent node-outline) are not
  // necessarily existing sources. Never promise the author can read them.
  const availability=await Promise.all(catalogue.map(async resource=>{
    if(!['outline','world','style','timeline'].includes(resource.kind))return {...resource,exists:true};
    try{await readResource(entry,resource.resourceRef);return {...resource,exists:true}}catch(error){
      if(error.code!=='ENOENT'&&error.details?.reason!=='resource_not_found')throw error;
      return {...resource,exists:false};
    }
  }));
  const descriptors=availability.filter(r=>r.exists);
  const unavailable=availability.filter(r=>!r.exists&&(text.includes(r.resourceRef)||r.title&&text.includes(r.title)));
  const roster=await Promise.all(descriptors.filter(r=>r.kind==='character').map(async r=>{
    const raw=await readResource(entry,r.resourceRef);const value=JSON.parse(raw.content);
    return {resourceRef:r.resourceRef,name:value.name,aliases:value.aliases||[]};
  }));
  const refs=descriptors.map(r=>r.resourceRef);
  const characters=roster.map(r=>r.resourceRef);
  const ref=values=>({type:'string',enum:values.length?values:['__none__']});
  const requestQuote={anyOf:[{type:'string',enum:[...new Set([text,...text.split(/(?<=[，,。；;\n])/u).map(s=>s.trim()).filter(Boolean)])]},{type:'null'}]};
  const schema=object({
    operation:{type:'string',enum:constraints.operation&&constraints.operation!=='unspecified'?[constraints.operation]:['unspecified','read','write','edit','review','roleplay','outline']},operationRequestQuote:requestQuote,
    participants:object({selection:{type:'string',enum:['specified','all','unspecified']},characterRefs:{type:'array',items:ref(characters)},requestQuote}),
    perspective:object({mode:{type:'string',enum:['limited','omniscient','per_character','unspecified'],description:'limited binds one narrative focal character; omniscient is an explicit narrative choice; per_character means separate responses/reactions from each character with no single narrator or focal ID.'},focusCharacterRef:{anyOf:[ref(characters),{type:'null'}]},requestQuote}),
    requiredReadResourceRefs:{type:'array',items:ref(refs)},
    missingRequestedSources:{type:'array',items:ref(unavailable.map(r=>r.resourceRef))},
    memoryUpdateRequired:{type:'boolean'},atomicMemoryWithChapter:{type:'boolean'},preserveOriginalMemories:{type:'boolean'},
    reviewAspects:{type:'array',items:{type:'string',enum:['timeline','viewpoint','character','world','style','format']}},
  });
  return {descriptors,roster,schema,unavailable,text:'解析用户本次任务的范围，不创作、不审查正文、不执行工具。只把用户明确指定的参与者/全部角色、叙述视角和必须读取的资料绑定到目录中的ID；未指定的参与者或视角保留unspecified。requestQuote引用用户原句。读取“全部角色卡及各自记忆”须列出全部对应资源；“前章/前两章”按目录与当前目标解析。记忆写入、同批及保留原记忆仅在用户要求时为true。资料目录不是必须全读的指令。仅选择实际存在的资料；若用户明确要求的资料不存在，在missingRequestedSources列出，不能虚构读取。\n'+JSON.stringify({request:text,existingConstraints:constraints,roster,resources:descriptors.map(r=>({resourceRef:r.resourceRef,kind:r.kind,title:r.title||r.name||null})),unavailableResources:unavailable.map(r=>({resourceRef:r.resourceRef,kind:r.kind,title:r.title||null}))})};
}
function bindTaskIntent(constraints,raw,{text,descriptors,modelId,unavailable=[]}) {
  const next=normalizeTaskConstraints(constraints);
  const known=new Set(descriptors.map(r=>r.resourceRef));
  const characters=descriptors.filter(r=>r.kind==='character').map(r=>r.resourceRef);
  const verifyQuote=value=>typeof value==='string'&&value.trim()&&text.includes(value);
  if(next.operation==='unspecified'&&raw?.operation&&raw.operation!=='unspecified') {
    if(!['read','write','edit','review','roleplay','outline'].includes(raw.operation)||!verifyQuote(raw.operationRequestQuote))throw contractError('任务操作缺少有效的用户依据','task_intent_invalid');
    next.operation=raw.operation;
    if(next.operation==='review')next.reviewRequired=true;
  }
  const explicitMissing=(raw?.missingRequestedSources||[]).filter(ref=>text.includes(ref)||unavailable.some(source=>source.resourceRef===ref&&source.title&&text.includes(source.title)));
  if(explicitMissing.length)throw contractError('用户要求的资料尚不存在：'+explicitMissing.join('、'),'task_sources_unavailable');
  if(!raw||!['specified','all','unspecified'].includes(raw.participants?.selection)||!['limited','omniscient','per_character','unspecified'].includes(raw.perspective?.mode)||!Array.isArray(raw.requiredReadResourceRefs))throw contractError('任务范围解析结果不完整','task_intent_invalid');
  const participants=raw.participants.selection==='all'?characters:raw.participants.characterRefs;
  if(!Array.isArray(participants)||new Set(participants).size!==participants.length||participants.some(r=>!characters.includes(r)))throw contractError('任务参与者不属于当前小说','task_intent_invalid');
  if(raw.participants.selection!=='unspecified'&&(!participants.length||!verifyQuote(raw.participants.requestQuote)))throw contractError('指定参与者缺少用户原句依据','task_intent_invalid');
  if(raw.participants.selection!=='unspecified'&&next.memoryParticipantCount!=null&&next.memoryParticipantCount!==participants.length)throw contractError('任务范围解析的参与人数与用户要求不符','task_intent_invalid');
  if(raw.participants.selection==='unspecified'&&participants.length)throw contractError('未指定参与者不能静默绑定角色','task_intent_invalid');
  if(raw.perspective.mode!=='unspecified') {
    if(!verifyQuote(raw.perspective.requestQuote)||raw.perspective.mode==='limited'&&!characters.includes(raw.perspective.focusCharacterRef))throw contractError('叙述视角缺少用户依据或有效焦点','task_intent_invalid');
    if(raw.perspective.mode==='per_character'&&raw.perspective.focusCharacterRef!=null)throw contractError('逐角色作答不能绑定单一叙述焦点','task_intent_invalid');
    next.narrativePerspective=raw.perspective.mode==='per_character'?null:{mode:raw.perspective.mode,focusCharacterRef:raw.perspective.mode==='limited'?raw.perspective.focusCharacterRef:null};
  }
  if(raw.requiredReadResourceRefs.some(r=>!known.has(r)))throw contractError('必读资料不属于当前小说','task_intent_invalid');
  const previousReads=next.intentBinding?.version===1?[]:next.requiredReadResourceRefs;
  next.requiredReadResourceRefs=[...new Set([...previousReads,...raw.requiredReadResourceRefs])];
  next.memoryUpdateRequired ||= raw.memoryUpdateRequired===true;
  next.atomicMemoryWithChapter ||= raw.atomicMemoryWithChapter===true;
  next.preserveOriginalMemories ||= raw.preserveOriginalMemories===true;
  if(raw.participants.selection!=='unspecified') {
    next.participantScopeFixed=true;next.participantCharacterRefs=participants;
    if(next.memoryUpdateRequired){next.requiredWriteResourceRefs=participants.map(r=>'character-memory:'+r.slice('character:'.length));next.memoryScopeBound=true;}
  }
  next.intentBinding={version:2,status:'bound',modelId:modelId||null,operation:next.operation,operationRequestQuote:raw.operationRequestQuote||null,participantSelection:raw.participants.selection,participantRequestQuote:raw.participants.requestQuote,perspectiveSelection:raw.perspective.mode,perspectiveRequestQuote:raw.perspective.requestQuote,reviewAspects:raw.reviewAspects||[]};
  return next;
}
module.exports={intentInput,bindTaskIntent};
