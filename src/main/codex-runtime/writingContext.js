'use strict';
const {readResource,listResourceDescriptors,parseResourceRef}=require('../mcp/novelResources');

const contextResources=value=>value?.mode==='writing_context'?[...(value.sharedSources||[]),...(value.actors||[]).flatMap(actor=>[actor.card,actor.subjectiveMemory].filter(Boolean))]:[];
async function buildWritingContext(entry,run,{includeDefaults=false}={}) {
  const c=run.taskConstraints||{};
  const refs=new Set([...(c.requiredReadResourceRefs||[]),...(c.reviewTargetResourceRefs||[]),...(c.targetResourceRefs||[])]);
  for(const ref of c.allowedWriteResourceRefs||[])refs.add(ref);
  if(run.selectionState?.resourceRef)refs.add(run.selectionState.resourceRef);
  for(const ref of c.participantCharacterRefs||[]){refs.add(ref);refs.add('character-memory:'+ref.slice('character:'.length));}
  if(includeDefaults||!refs.size) {
    const descriptors=await listResourceDescriptors(entry);
    for(const r of descriptors.filter(r=>['world','outline','style'].includes(r.kind)))refs.add(r.resourceRef);
    const previous=descriptors.filter(r=>r.kind==='chapter').at(-1);if(previous)refs.add(previous.resourceRef);
    if(includeDefaults&&!c.participantCharacterRefs?.length)for(const r of descriptors.filter(r=>['character','character-memory'].includes(r.kind)))refs.add(r.resourceRef);
  }
  const sources=await Promise.all([...refs].map(async ref=>{
    let r;
    try{r=await readResource(entry,ref)}catch(error){
      if(error.code!=='ENOENT'&&error.details?.reason!=='resource_not_found')throw error;
      return {resourceRef:ref,kind:parseResourceRef(ref).kind,mode:'content',exists:false,content:null};
    }
    return {resourceRef:ref,kind:r.kind,mode:'content',hash:r.sourceHash,offset:0,content:r.content};
  }));
  const actors=new Map();const sharedSources=[];
  for(const source of sources) {
    if(!['character','character-memory'].includes(source.kind)){sharedSources.push(source);continue;}
    const id=source.resourceRef.slice(source.resourceRef.indexOf(':')+1),ref='character:'+id;
    if(!actors.has(ref))actors.set(ref,{characterRef:ref,card:null,subjectiveMemory:null,baselineMemory:run.memoryBaselines?.['character-memory:'+id]||null});
    actors.get(ref)[source.kind==='character'?'card':'subjectiveMemory']=source;
  }
  return {mode:'writing_context',taskScope:c,sharedSources,actors:[...actors.values()],
    informationBoundary:'sharedSources供作者核对客观资料；actors中的主观记忆只属于该人物，不形成全员共享知识。baselineMemory是任务开始前状态，现场新见闻须由当前场景发生的信息传递支持。'};
}
module.exports={buildWritingContext,contextResources};
