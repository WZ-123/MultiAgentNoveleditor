'use strict';
const chatRuns=require('../store/chatRuns');
const receipts=new Map();
async function rememberReadVersion(ctx,result) {
  if(!ctx?.novel?.id || !result?.resourceRef || result.ok===false || !(result.hash || result.exists===false))return;
  const active=(await chatRuns.list()).filter(run=>run.novelId===ctx.novel.id&&['starting','running','waiting-approval'].includes(run.status)&&run.workspaceRoot);
  if(active.length!==1)return;
  const key=active[0].runId+':'+result.resourceRef;
  receipts.delete(key);receipts.set(key,result.exists===false?'absent':result.hash);
  while(receipts.size>512)receipts.delete(receipts.keys().next().value);
}
function readVersion(runId,resourceRef) {return receipts.get(runId+':'+resourceRef);}
module.exports={rememberReadVersion,readVersion};
