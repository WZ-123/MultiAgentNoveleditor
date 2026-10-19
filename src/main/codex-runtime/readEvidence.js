'use strict';

function readResult(item) {
  if (item.result?.structuredContent) return item.result.structuredContent;
  try { return JSON.parse((item.result?.content || []).filter(block => block.type === 'text').map(block => block.text).join('\n')); }
  catch { return null; }
}
function successfulReadItems(items) {
  const expanded=(items||[]).flatMap(item=>{
    if(item.status!=='completed'||item.error||item.result?.isError)return [item];
    const sources=String(item.tool||item.toolName||item.name||'').includes('read_writing_context')?require('./writingContext').contextResources(readResult(item)):[];
    return sources.length?sources.map(source=>({...item,type:'writingContextSource',result:{structuredContent:source}})):[item];
  });
  return expanded.filter(item => item.status === 'completed' && !item.error && item.result?.isError !== true
    && (/read_novel_resource/u.test(String(item.tool || item.toolName || item.name || '')) || item.type==='writingContextSource'||item.type==='reviewSourceDelivery'&&item.origin==='host'||item.type==='writingSourceDelivery'&&item.origin==='host'&&item.purpose==='writing_preparation'&&!!item.executionRunId)
    && readResult(item)?.mode === 'content' && readResult(item)?.exists !== false && readResult(item)?.ok !== false);
}
function readIntervals(items, resource) {
  const bytes = Buffer.from(resource.content, 'utf8');
  const intervals = [];
  for (const item of successfulReadItems(items)) {
    const value = readResult(item);
    if (value.resourceRef !== resource.resourceRef || value.hash !== resource.sourceHash || typeof value.content !== 'string') continue;
    let start = Number(value.offset || 0);
    let content = value.content;
    if (value.startLine != null) {
      const lines = resource.content.split('\n');
      if (!Number.isInteger(value.startLine) || !Number.isInteger(value.endLine) || value.startLine < 1 || value.endLine < value.startLine || value.endLine > lines.length) continue;
      start = Buffer.byteLength(lines.slice(0, value.startLine - 1).join('\n') + (value.startLine > 1 ? '\n' : ''), 'utf8');
      if (content !== lines.slice(value.startLine - 1, value.endLine).join('\n')) continue;
      if (value.endLine < lines.length) content += '\n';
    }
    const end = start + Buffer.byteLength(content, 'utf8');
    if (Number.isSafeInteger(start) && start >= 0 && end <= bytes.length && bytes.subarray(start, end).equals(Buffer.from(content, 'utf8'))) intervals.push([start, end]);
  }
  const merged = [];
  for (const [start, end] of intervals.sort((a, b) => a[0] - b[0])) {
    const last = merged.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}
function completeReadRefs(items, resources) {
  const covered = new Set();
  for (const resource of resources) {
    const intervals = readIntervals(items, resource);
    let end = 0;
    for (const interval of intervals.sort((a, b) => a[0] - b[0])) {
      if (interval[0] > end) break;
      end = Math.max(end, interval[1]);
    }
    if (intervals.length && end === Buffer.byteLength(resource.content, 'utf8')) covered.add(resource.resourceRef);
  }
  return covered;
}
// Input reads remain real after this task updates the input resource. Accept
// only versions named in the host's own commit receipts, never arbitrary older
// tool text. Output readback/review continues to require the current version.
function readBeforeOwnWrites(items,commits) {
  const versions=new Set((commits||[]).filter(c=>c.oldHash&&c.mode!=='create').map(c=>c.resourceRef+':'+c.oldHash));
  const groups=new Map();
  for(const item of successfulReadItems(items)) {
    const v=readResult(item),key=v.resourceRef+':'+v.hash;
    if(!versions.has(key)||typeof v.content!=='string'||v.startLine!=null)continue;
    if(!groups.has(key))groups.set(key,[]);groups.get(key).push(v);
  }
  const covered=new Set();
  for(const pages of groups.values()) {
    let bytes=Buffer.alloc(0),valid=true;
    for(const page of pages.sort((a,b)=>(a.offset||0)-(b.offset||0))) {
      const start=Number(page.offset||0),part=Buffer.from(page.content);
      if(!Number.isSafeInteger(start)||start<0||start>bytes.length){valid=false;break;}
      const overlap=Math.min(part.length,bytes.length-start);
      if(!bytes.subarray(start,start+overlap).equals(part.subarray(0,overlap))){valid=false;break;}
      if(part.length>overlap)bytes=Buffer.concat([bytes,part.subarray(overlap)]);
    }
    if(valid&&require('node:crypto').createHash('sha256').update(bytes).digest('hex')===pages[0].hash)covered.add(pages[0].resourceRef);
  }
  return covered;
}
module.exports = { completeReadRefs, readIntervals, readResult, successfulReadItems,readBeforeOwnWrites };
