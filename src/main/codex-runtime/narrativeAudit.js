'use strict';

// Host checks source provenance and requested review delivery, not semantic truth.
const { readIntervals } = require('./readEvidence');

function reviewUnits(resources) {
  const units = [];
  for (const resource of resources) {
    if (resource?.kind !== 'chapter') continue;
    const lines = resource.content.split('\n');
    let start = null;
    const flush = end => {
      if (start == null) return;
      units.push({ unitId: `${resource.resourceRef}:L${start + 1}-${end}`, resourceRef: resource.resourceRef,
        startLine: start + 1, endLine: end, text: lines.slice(start, end).join('\n') });
      start = null;
    };
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].trim()) flush(i);
      else if (start == null) start = i;
    }
    flush(lines.length);
  }
  return units;
}

function locateEvidence(raw, resources, reads) {
  const resource = resources.get(raw?.resourceRef);
  if(resource && !raw?.location && typeof raw?.quote==='string' && raw.quote) {
    const at=resource.content.indexOf(raw.quote);
    if(at<0 || resource.content.indexOf(raw.quote,at+1)>=0)return null;
    const first=resource.content.slice(0,at).split('\n').length;
    const last=first+raw.quote.split('\n').length-1;
    raw={...raw,location:first===last?`L${first}`:`L${first}-${last}`};
  }
  const match = String(raw?.location || '').normalize('NFKC').match(/^(?:L|第\s*)?(\d+)(?:\s*[-–—~至到:]\s*L?(\d+))?\s*行?$/iu);
  const start = Number(match?.[1]), end = Number(match?.[2] || start);
  if (!resource || !match || start < 1 || end < start) return null;
  const lines = resource.content.split('\n');
  if (end > lines.length || !raw.quote || typeof raw.quote !== 'string') return null;
  const excerpt = lines.slice(start - 1, end).join('\n');
  const baseOffset=Buffer.byteLength(lines.slice(0,start-1).join('\n')+(start>1?'\n':''));
  let at = excerpt.indexOf(raw.quote);
  if(Number.isSafeInteger(raw.quoteOffset)) {
    const local=raw.quoteOffset-baseOffset,bytes=Buffer.from(excerpt),quote=Buffer.from(raw.quote);
    if(local<0||!bytes.subarray(local,local+quote.length).equals(quote))return null;
    at=bytes.subarray(0,local).toString('utf8').length;
  }
  if (at < 0) return null;
  const offset = Buffer.byteLength(lines.slice(0, start - 1).join('\n') + (start > 1 ? '\n' : '') + excerpt.slice(0, at));
  const finish = offset + Buffer.byteLength(raw.quote);
  if (!readIntervals(reads, resource).some(([a, b]) => a <= offset && b >= finish)) return null;
  return { ...raw, hash: resource.sourceHash, offset, startLine: start, endLine: end };
}

// A completed review is a model assessment of the requested resources/aspects.
// It is deliberately not a certificate that every proposition was extracted.
function assessNarrativeReview(report,{targets,aspects=[]}) {
  const rows=report?.reviews;
  const errors=[];
  if(!Array.isArray(rows))return {status:'missing',errors:['review_assessment_missing'],qualityConclusion:'not_evaluated'};
  const refs=new Set(targets.map(r=>typeof r==='string'?r:r.resourceRef));
  const seen=new Set();
  for(const row of rows) {
    if(!refs.has(row.resourceRef)||seen.has(row.resourceRef)||!String(row.conclusion||'').trim()||!Array.isArray(row.aspects)||!Array.isArray(row.limitations))errors.push('invalid_review_resource:'+row.resourceRef);
    // Narrative/style dimensions apply to chapter prose, not to every memory
    // JSON or canonical source that is reviewed alongside it.
    if(row.resourceRef.startsWith('chapter:')&&aspects.some(aspect=>!row.aspects?.includes(aspect)))errors.push('review_aspect_missing:'+row.resourceRef);
    seen.add(row.resourceRef);
  }
  for(const ref of refs)if(!seen.has(ref))errors.push('review_resource_missing:'+ref);
  return {status:errors.length?'incomplete':'reported',errors,reviewedResourceRefs:[...seen],requestedResourceRefs:[...refs],aspects,
    limitations:rows.flatMap(row=>row.limitations||[]),qualityConclusion:'model_reported'};
}
const perspectiveSchema={type:'object',properties:{mode:{type:'string',enum:['limited','omniscient']},focusCharacterRef:{type:['string','null']}},required:['mode','focusCharacterRef'],additionalProperties:false};
module.exports={reviewUnits,locateEvidence,assessNarrativeReview,perspectiveSchema};
