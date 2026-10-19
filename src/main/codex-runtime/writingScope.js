'use strict';
const {listResourceDescriptors,parseResourceRef}=require('../mcp/novelResources');
const {normalizeTaskConstraints}=require('./taskLedger');
const {contractError}=require('./contracts');
const sameSet=(a,b)=>a.length===b.length&&a.every(ref=>b.includes(ref));

function assertWriteScope(constraints,refs) {
  const allowed=constraints.allowedWriteResourceRefs||[];
  const targets=constraints.targetResourceRefs||[];
  const memories=new Set(constraints.requiredWriteResourceRefs||[]);
  const outside=refs.filter(ref=>allowed.length&&!allowed.includes(ref)
    || constraints.chapterWritePolicy==='new'&&ref.startsWith('chapter:')&&constraints.initialChapterResourceRefs.includes(ref)
    || constraints.resourceWritePolicy==='targets'&&!targets.includes(ref)&&!memories.has(ref));
  if(outside.length)throw contractError(`修改超出本次任务范围：${outside.join('、')}`,'task_scope_violation',{outside});
  if(constraints.memoryUpdateRequired&&!constraints.memoryScopeBound)throw contractError('本次要求保存角色记忆；请在 prepare_novel_patch 中用 participantCharacterRefs 明确绑定参与角色的真实资源ID。','writing_scope_unbound');
}

async function bindCandidateScope(entry,constraints,{participantCharacterRefs,resourceRefs}) {
  const next=normalizeTaskConstraints(constraints);
  if(participantCharacterRefs!=null) {
    if(!Array.isArray(participantCharacterRefs)||!participantCharacterRefs.length||new Set(participantCharacterRefs).size!==participantCharacterRefs.length)throw contractError('参与角色必须是非空、无重复的 character 资源ID数组','invalid_participant_scope');
    const known=new Set((await listResourceDescriptors(entry)).filter(item=>item.kind==='character').map(item=>item.resourceRef));
    for(const ref of participantCharacterRefs)if(parseResourceRef(ref).kind!=='character'||!known.has(ref))throw contractError(`当前小说不存在参与角色：${ref}`,'invalid_participant_scope');
    if((next.memoryScopeBound||next.participantScopeFixed)&&!sameSet(next.participantCharacterRefs,participantCharacterRefs))throw contractError('本任务参与角色范围已经绑定，不能静默更换或缩小；请发起新任务变更范围。','task_scope_changed');
    if(next.memoryParticipantCount!=null&&participantCharacterRefs.length!==next.memoryParticipantCount)throw contractError(`本次要求 ${next.memoryParticipantCount} 位角色，实际绑定 ${participantCharacterRefs.length} 位`,'participant_count_mismatch');
    next.participantCharacterRefs=[...participantCharacterRefs];
    if(next.memoryUpdateRequired) {
      const refs=participantCharacterRefs.map(ref=>'character-memory:'+parseResourceRef(ref).key);
      if(next.requiredWriteResourceRefs.some(ref=>!refs.includes(ref)))throw contractError('不能省略本任务已经要求的角色记忆','task_scope_changed');
      next.requiredWriteResourceRefs=refs;
      next.memoryScopeBound=true;
    }
  }
  assertWriteScope(next,resourceRefs);
  return next;
}
module.exports={assertWriteScope,bindCandidateScope};
