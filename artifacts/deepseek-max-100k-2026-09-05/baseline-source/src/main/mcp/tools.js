'use strict';

const { listResources, readResource, searchResources } = require('./novelResources');
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
const resourceKinds = { type: 'array', items: { type: 'string', enum: ['novel', 'chapter', 'chapter-summary', 'character', 'character-memory', 'world', 'outline', 'timeline', 'asset', 'style'] } };

const TOOLS = [
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
    description: 'Read a novel resource by resourceRef, returning the complete-resource hash and byte pagination metadata.',
    inputSchema: { type: 'object', properties: { resourceRef: { type: 'string' }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 262144 } }, required: ['resourceRef'], additionalProperties: false },
    async handler(args, ctx) {
      const resource = await readResource(requireNovel(ctx), args.resourceRef);
      const bytes = Buffer.from(resource.content, 'utf8');
      const limit = Math.min(262144, Math.max(1, Number(args.limit) || 65536));
      const slice = utf8Page(bytes, args.offset, limit);
      return textResult({ resourceRef: resource.resourceRef, workspacePath: resourceRelativePath(resource.resourceRef), kind: resource.kind, hash: resource.sourceHash, totalBytes: bytes.length, offset: slice.start, nextCursor: slice.end < bytes.length ? String(slice.end) : null, content: slice.content });
    },
  },
  {
    name: 'search_novel_resources',
    description: 'Search all matching novel resources without application-side context ranking.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, kinds: resourceKinds, cursor: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 200 } }, required: ['query'], additionalProperties: false },
    async handler(args, ctx) { return textResult(await searchResources(requireNovel(ctx), args)); },
  },
  {
    name: 'scan_de_ai_patterns',
    description: 'Run the deterministic local Chinese de-AI pattern scanner on one resource. It does not call a model.',
    inputSchema: { type: 'object', properties: { resourceRef: { type: 'string' } }, required: ['resourceRef'], additionalProperties: false },
    async handler(args, ctx) {
      const resource = await readResource(requireNovel(ctx), args.resourceRef);
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
    description: 'Deterministically check whether travel between two timestamped events is physically feasible.',
    inputSchema: { type: 'object', properties: { eventA: { type: 'object' }, eventB: { type: 'object' }, transport: { type: 'string', enum: ['walk', 'run', 'horse', 'car', 'train', 'plane', 'magic'] } }, required: ['eventA', 'eventB'], additionalProperties: false },
    async handler(args) { return textResult(checkFeasibility(args.eventA, args.eventB, { transport: args.transport })); },
  },
];

function getToolByName(name) { return TOOLS.find((tool) => tool.name === name) || null; }

module.exports = { TOOLS, getToolByName, textResult, utf8Page };
