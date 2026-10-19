'use strict';

const { bodyChineseCharacterCount, chineseCharacterCount, listResources, readResource, searchResources } = require('./novelResources');
const { scanDeAiPatterns } = require('./deAiScanner');
const { checkFeasibility } = require('./feasibility');
const { resourceRelativePath } = require('../codex-runtime/nativeNovelWorkspace');

function textResult(value) {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }], structuredContent: value && typeof value === 'object' ? value : undefined };
}
function utf8Page(buffer, requestedOffset, requestedLimit) {
  let start = Math.min(buffer.length, Math.max(0, Number(requestedOffset) || 0));
  while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start += 1;
  let end = Math.min(buffer.length, start + Math.max(1, Number(requestedLimit) || 65536));
  while (end > start && end < buffer.length && (buffer[end] & 0xc0) === 0x80) end -= 1;
  if (end === start && start < buffer.length) {
    end = start + 1;
    while (end < buffer.length && (buffer[end] & 0xc0) === 0x80) end += 1;
  }
  return { start, end, content: buffer.subarray(start, end).toString('utf8') };
}
function requireNovel(ctx) {
  if (!ctx?.novel?.id || !ctx?.novelDir) throw new Error('请先打开小说项目');
  return { id: ctx.novel.id, dir: ctx.novelDir };
}
function missingResource(error, resourceRef) {
  if (error.code !== 'ENOENT' && error.details?.reason !== 'resource_not_found') throw error;
  return textResult({ resourceRef, workspacePath: resourceRelativePath(resourceRef), exists: false, code: 'resource_not_found',
    recoverable: true, message: `未找到小说资源：${resourceRef}。可列出或搜索现有资料；用户要求创建时可新建对应映射文件。` });
}
const resourceKinds = { type: 'array', items: { type: 'string', enum: ['novel', 'chapter', 'chapter-summary', 'character', 'character-memory', 'world', 'outline', 'timeline', 'asset', 'style'] } };
const timelineEventSchema = { type:'object', properties:{ when:{type:'string',description:'Same-day HH:mm, or dated ISO timestamp for overnight events'}, where:{anyOf:[{type:'string'},{type:'object',properties:{lat:{type:'number'},lng:{type:'number'},name:{type:'string'}}}]}, physical:{type:'object',properties:{distanceKmTo:{type:'object',additionalProperties:{type:'number',minimum:0}}}} }, required:['when','where'], additionalProperties:false };

const TOOLS = [
  ...require('./writingTools').WRITING_TOOLS,
  {
    name: 'connection_probe',
    description: 'Deterministic no-op used only to verify a complete Responses tool loop.',
    inputSchema: { type: 'object', additionalProperties: false },
    async handler() { return textResult({ ok: true, protocol: 'responses+mcp' }); },
  },
  {
    name: 'list_novel_resources',
    description: 'List addressable novel resources. Pagination controls transport only and does not rank context importance.',
    inputSchema: { type: 'object', properties: { kinds: resourceKinds, cursor: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 200 } }, additionalProperties: false },
    async handler(args, ctx) {
      const result = await listResources(requireNovel(ctx), args);
      return textResult({ ...result, data: result.data.map((item) => ({ ...item, workspacePath: resourceRelativePath(item.resourceRef) })) });
    },
  },
  {
    name: 'read_novel_resource',
    description: 'Read one exact novel resource and return its complete-resource hash and deterministic counts. A missing resource returns exists=false without a hash; create it with native apply_patch if the user requested creation. Use mode="metadata" for hash/count only. Use startLine/endLine for exact 1-based original line ranges when patch context is needed. Byte pagination remains available for compatibility.',
    inputSchema: { type: 'object', properties: { resourceRef: { type: 'string' }, mode: { type: 'string', enum: ['content', 'metadata'] }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 262144 }, startLine: { type: 'integer', minimum: 1 }, endLine: { type: 'integer', minimum: 1 }, includeLineNumbers: { type: 'boolean', description: 'With startLine/endLine, include numberedContent for evidence locations. content remains exact original text.' } }, required: ['resourceRef'], additionalProperties: false },
    async handler(args, ctx) {
      let resource;
      try { resource = await readResource(requireNovel(ctx), args.resourceRef); }
      catch (error) {
        return missingResource(error, args.resourceRef);
      }
      const bytes = Buffer.from(resource.content, 'utf8');
      const base = { resourceRef: resource.resourceRef, workspacePath: resourceRelativePath(resource.resourceRef), kind: resource.kind, hash: resource.sourceHash, chineseCharacterCount: chineseCharacterCount(resource.content), bodyChineseCharacterCount: bodyChineseCharacterCount(resource.content), totalBytes: bytes.length };
      if (args.mode === 'metadata') return textResult({ ...base, mode: 'metadata' });
      if (args.startLine != null || args.endLine != null) {
        const lines = resource.content.split('\n');
        const startLine = Math.max(1, Number(args.startLine) || 1);
        const endLine = Math.min(lines.length, Math.max(startLine, Number(args.endLine) || startLine));
        return textResult({ ...base, mode: 'content', startLine, endLine, totalLines: lines.length, content: lines.slice(startLine - 1, endLine).join('\n'),
          ...(args.includeLineNumbers ? { numberedContent: lines.slice(startLine - 1, endLine).map((line, index) => `L${startLine + index}: ${line}`).join('\n') } : {}) });
      }
      const limit = Math.min(262144, Math.max(1, Number(args.limit) || 65536));
      const slice = utf8Page(bytes, args.offset, limit);
      return textResult({ ...base, mode: 'content', offset: slice.start, nextCursor: slice.end < bytes.length ? String(slice.end) : null, content: slice.content });
    },
  },
  {
    name: 'search_novel_resources',
    description: 'Search all matching novel resources without application-side context ranking.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, kinds: resourceKinds, cursor: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 200 } }, required: ['query'], additionalProperties: false },
    async handler(args, ctx) { return textResult(await searchResources(requireNovel(ctx), args)); },
  },
  {
    name: 'report_writing_progress',
    description: 'Report which chapter is currently being drafted or checked. This tool never writes novel data; saved counts come only from host-verified commits.',
    inputSchema: {
      type: 'object',
      properties: {
        chapterResourceRef: { type: 'string', pattern: '^chapter:.+\\.md$' },
        activity: { type: 'string', enum: ['drafting', 'checking', 'preparing-save'] },
      },
      required: ['chapterResourceRef', 'activity'],
      additionalProperties: false,
    },
    async handler(args, ctx) {
      requireNovel(ctx);
      if (!/^chapter:.+\.md$/u.test(String(args.chapterResourceRef || ''))) throw new Error('chapterResourceRef 必须指向章节资源');
      return textResult({ reported: true, chapterResourceRef: String(args.chapterResourceRef), activity: args.activity, savedCountsAuthoritative: false });
    },
  },
  {
    name: 'scan_de_ai_patterns',
    description: 'Run the deterministic local Chinese de-AI pattern scanner on one resource. It does not call a model.',
    inputSchema: { type: 'object', properties: { resourceRef: { type: 'string' } }, required: ['resourceRef'], additionalProperties: false },
    async handler(args, ctx) {
      let resource;
      try { resource = await readResource(requireNovel(ctx), args.resourceRef); }
      catch (error) {
        return missingResource(error, args.resourceRef);
      }
      return textResult({ resourceRef: args.resourceRef, hash: resource.sourceHash, ...scanDeAiPatterns({ resourceRef: args.resourceRef, content: resource.content, baseContentHash: resource.sourceHash }) });
    },
  },
  {
    name: 'check_de_ai_minimality',
    description: 'Deterministically reject de-AI rewrites that add content or flatten the original rhythm.',
    inputSchema: { type: 'object', properties: { original: { type: 'string' }, candidate: { type: 'string' }, guidance: { type: 'string' } }, required: ['original', 'candidate'], additionalProperties: false },
    async handler(args) {
      const { assessDeAiMinimality } = await import('../../services/deAiMinimality.mjs');
      return textResult(assessDeAiMinimality(args.original, args.candidate, { guidance: args.guidance || '' }));
    },
  },
  {
    name: 'check_timeline_feasibility',
    description: 'Check elapsed time against canonical travel/work duration or estimated distance/speed. Events use when/where, not time/location. Set minimumTravelMinutes from an actually read world/scene rule when available; no distance or duration returns unknown, never assumed feasible. HH:mm assumes the same day; overnight events require dated timestamps. Estimated speed does not prove world-specific feasibility. For inaccurate clocks include clockReadings with actualTime, displayedTime and signed canonical offsetMinutes (fast positive, slow negative); travel feasibility cannot override a clock contradiction.',
    inputSchema: { type: 'object', properties: { eventA: timelineEventSchema, eventB: timelineEventSchema, minimumTravelMinutes:{type:'number',minimum:0,description:'Minimum duration in minutes from canonical evidence; supports boat routes and work durations without invented distances'}, transport: { type: 'string', enum: ['walk', 'run', 'horse', 'car', 'train', 'plane', 'boat', 'magic'] },clockReadings:{type:'array',minItems:1,items:{type:'object',properties:{actualTime:{type:'string'},displayedTime:{type:'string'},offsetMinutes:{type:'number',description:'Canonical displayed minus actual minutes. Fast is positive, slow is negative; use dated timestamps across midnight.'}},required:['actualTime','displayedTime','offsetMinutes'],additionalProperties:false}} }, required: ['eventA', 'eventB'], additionalProperties: false },
    async handler(args) { return textResult(checkFeasibility(args.eventA, args.eventB, { transport: args.transport, minimumTravelMinutes:args.minimumTravelMinutes,clockReadings:args.clockReadings })); },
  },
];

const resourceReader=TOOLS.find(tool=>tool.name==='read_novel_resource');
const readHandler=resourceReader.handler;
resourceReader.handler=async(args,ctx)=>{
  const result=await readHandler(args,ctx);
  await require('./readVersionReceipts').rememberReadVersion(ctx,result.structuredContent);
  return result;
};

function getToolByName(name) { return TOOLS.find((tool) => tool.name === name) || null; }

module.exports = { TOOLS, getToolByName, textResult, utf8Page };
