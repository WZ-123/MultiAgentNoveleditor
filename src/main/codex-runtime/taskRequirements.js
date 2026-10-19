'use strict';
const { normalizeTaskConstraints } = require('./taskLedger');
const { listResourceDescriptors, readResource } = require('../mcp/novelResources');

async function deriveRequirements(payload) {
  const { taskConstraintsFor, positiveInstructions } = await import('../../domain/writingTaskConstraints.mjs');
  const inferred = taskConstraintsFor(payload.text, payload.skillName, { ...payload.editorContext, editScope: payload.editScope });
  const supplied = payload.taskConstraints || {};
  const constraints = normalizeTaskConstraints({ ...inferred, ...supplied,
    operation: supplied.operation && supplied.operation !== 'unspecified' ? supplied.operation : inferred.operation,
    targetResourceRefs: [...new Set([...inferred.targetResourceRefs, ...(supplied.targetResourceRefs || [])])],
    requiredWriteResourceRefs: supplied.requiredWriteResourceRefs || [],
    allowResourceDeletion: inferred.allowResourceDeletion === true,
    reviewRequired: inferred.reviewRequired || supplied.reviewRequired,
    reviewScope: inferred.reviewRequired ? inferred.reviewScope : supplied.reviewScope,
    reviewTargetResourceRefs: [...new Set([...inferred.reviewTargetResourceRefs, ...(supplied.reviewTargetResourceRefs || [])])],
    // Only persisted continuation state may supply a previously frozen scope.
    reviewScopeBound: false,
  });
  const skillName = payload.skillName || (inferred.operation === 'review' ? 'mana-consistency-review'
    : /(?:角色驱动|扮演角色|角色扮演)/u.test(positiveInstructions(payload.text)) ? 'mana-character-roleplay' : undefined);
  return { ...payload, skillName, taskConstraints: constraints };
}

async function bindRequirements(entry, constraints, text) {
  // Re-evaluate this obligation even for persisted, already-bound tasks.
  constraints.narrativeAuditRequired=constraints.reviewRequired===true;
  const { positiveInstructions } = await import('../../domain/writingTaskConstraints.mjs');
  const requestedText = positiveInstructions(text);
  const memoryIntent = requestedText.replace(/(?:不更新|不保存|不写入|不同步)[^，]*/gu,'')
    .replace(/(?:已经|已|此前|先前)(?:写入|保存|更新|同步)(?:的|过)?/gu,'');
  const memoryUpdate = /(?:(?:写入|保存|更新|同步)[^，。；;]{0,40}记忆|记忆[^，。；;]{0,20}(?:写入|保存|更新|同步))/u.test(memoryIntent);
  const needsBinding = !((!constraints.reviewRequired || constraints.reviewScopeBound) && !(constraints.operation === 'read' && constraints.wordCountScope === 'whole_novel' && !constraints.targetResourceRefs.length));
  const needsWriteScope = ['write','edit','roleplay'].includes(constraints.operation) && !constraints.writeScopeBound;
  if (!needsBinding && !memoryUpdate && !needsWriteScope) return constraints;
  const descriptors = await listResourceDescriptors(entry);
  if(needsWriteScope) {
    constraints.chapterWritePolicy=constraints.wordCountScope==='new_writing'?'new':'any';
    constraints.initialChapterResourceRefs=descriptors.filter(item=>item.kind==='chapter').map(item=>item.resourceRef);
    constraints.resourceWritePolicy=constraints.operation==='edit'&&constraints.targetResourceRefs.length?'targets':'any';
    constraints.writeScopeBound=true;
  }
  if(memoryUpdate) {
    constraints.memoryUpdateRequired=true;
    const count=requestedText.match(/([一二两三四五六七八九十]|\d+)\s*(?:人(?!称)|位角色)/u)?.[1];
    const chinese={一:1,二:2,两:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9,十:10};
    constraints.memoryParticipantCount=count?(Number(count)||chinese[count]):null;
    if(!constraints.memoryScopeBound && /(?:所有|全部|全体)(?:的)?角色|每(?:一)?(?:个|位)角色/u.test(requestedText)) {
      constraints.participantCharacterRefs=descriptors.filter(item=>item.kind==='character').map(item=>item.resourceRef);
      constraints.requiredWriteResourceRefs=constraints.participantCharacterRefs.map(ref=>'character-memory:'+ref.slice('character:'.length));
      constraints.memoryScopeBound=true;
    }
    if(/同一[^，。；;]{0,12}(?:批次|事务|补丁|确认)|同批/u.test(requestedText))constraints.atomicMemoryWithChapter=true;
    if(/保留[^，。；;]{0,20}原(?:始|有|来)[^，。；;]{0,8}记忆/u.test(requestedText))constraints.preserveOriginalMemories=true;
  }
  if(!needsBinding) return constraints;
  constraints.reviewSourceKinds ||= [];
  if (constraints.operation === 'read' && constraints.wordCountScope === 'whole_novel' && !constraints.targetResourceRefs.length) {
    constraints.targetResourceRefs = descriptors.filter(item => item.kind === 'chapter').map(item => item.resourceRef);
  }
  if (constraints.reviewRequired && !constraints.reviewScopeBound) {
    const refs = new Set(constraints.reviewTargetResourceRefs);
    if (constraints.reviewScope === 'whole_novel') for (const item of descriptors) if (item.kind === 'chapter') refs.add(item.resourceRef);
    if (constraints.reviewScope === 'target_resources') for (const ref of constraints.targetResourceRefs) refs.add(ref);
    // Freeze the requested canonical sources, without injecting their contents.
    const kinds = new Set();
    if (/(?:人物|人设|角色)/u.test(requestedText)) kinds.add('character');
    if (/(?:世界观|设定)/u.test(requestedText)) kinds.add('world');
    if (/(?:文风|风格)/u.test(requestedText)) kinds.add('style');
    for (const item of descriptors.filter(item => kinds.has(item.kind))) {
      const resource = await readResource(entry, item.resourceRef);
      if (resource.content.trim() && !['[]', '{}'].includes(resource.content.trim())) {
        if (constraints.reviewScope === 'whole_novel') refs.add(item.resourceRef);
        else if (!constraints.reviewSourceKinds.includes(item.kind)) constraints.reviewSourceKinds.push(item.kind);
      }
    }
    constraints.reviewTargetResourceRefs = [...refs];
    constraints.reviewScopeBound = true;
  }
  constraints.narrativeAuditRequired=constraints.reviewRequired===true;
  return constraints;
}
module.exports = { bindRequirements, deriveRequirements };
