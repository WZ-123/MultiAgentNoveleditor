'use strict';
const {isDeepStrictEqual}=require('node:util');
const MEMORY_KEYS=['factsKnown','emotionalMemory','relationshipDeltas','unresolvedIntentions','privateMisbeliefs'];
function assertMemoryBaseline(baseline,after) {
  if(!baseline) return;
  for(const key of MEMORY_KEYS) {
    const original=baseline[key] || [];
    if(!isDeepStrictEqual((after?.[key] || []).slice(0,original.length),original)) {
      const error=new Error(`不得覆盖或移除任务开始前的 ${key} 原始记忆；只修订本任务新增条目`);error.code='original_memory_changed';throw error;
    }
  }
  for(const key of Object.keys(baseline).filter(key=>!MEMORY_KEYS.includes(key)&&key!=='lastUpdatedChapterRef')) {
    if(!isDeepStrictEqual(after?.[key],baseline[key])) {const error=new Error(`不得改写原始角色记忆字段：${key}`);error.code='original_memory_changed';throw error;}
  }
}
module.exports={MEMORY_KEYS,assertMemoryBaseline};
