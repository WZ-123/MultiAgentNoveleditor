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
    description: 'Read one exact novel resource and return its complete-resource hash and deterministic counts. A missing resource returns exists=false without a hash; create it with native apply_patch if the user requested creation. Use mode="metadata" for hash/count only. Use startLine/endLine for exact 1-based original line ranges when patch context is needed. Byte pagination remains available for compatibility.',
    inputSchema: { type: 'object', properties: { resourceRef: { type: 'string' }, mode: { type: 'string', enum: ['content', 'metadata'] }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 262144 }, startLine: { type: 'integer', minimum: 1 }, endLine: { type: 'integer', minimum: 1 } }, required: ['resourceRef'], additionalProperties: false },
    async handler(args, ctx) {
      let resource;
      try { resource = await readResource(requireNovel(ctx), args.resourceRef); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        // Absence is a normal lookup outcome before creating a chapter. Do not
        // report a failed MCP call that makes the host interrupt the whole turn.
        return textResult({ resourceRef: args.resourceRef, workspacePath: resourceRelativePath(args.resourceRef), exists: false, code: 'resource_not_found', message: '资源尚不存在；如用户要求创建，请使用原生 apply_patch 新建对应文件。' });
      }
      const bytes = Buffer.from(resource.content, 'utf8');
      const base = { resourceRef: resource.resourceRef, workspacePath: resourceRelativePath(resource.resourceRef), kind: resource.kind, hash: resource.sourceHash, chineseCharacterCount: chineseCharacterCount(resource.content), bodyChineseCharacterCount: bodyChineseCharacterCount(resource.content), totalBytes: bytes.length };
      if (args.mode === 'metadata') return textResult({ ...base, mode: 'metadata' });
      if (args.startLine != null || args.endLine != null) {
        const lines = resource.content.split('\n');
        const startLine = Math.max(1, Number(args.startLine) || 1);
        const endLine = Math.min(lines.length, Math.max(startLine, Number(args.endLine) || startLine));
        return textResult({ ...base, mode: 'content', startLine, endLine, totalLines: lines.length, content: lines.slice(startLine - 1, endLine).join('\n') });
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
        if (error.code !== 'ENOENT') throw error;
        // Absence is a normal lookup outcome before creating a chapter. Do not
        // report a failed MCP call that makes the host interrupt the whole turn.
        return textResult({ resourceRef: args.resourceRef, workspacePath: resourceRelativePath(args.resourceRef), exists: false, code: 'resource_not_found', message: '资源尚不存在；如用户要求创建，请使用原生 apply_patch 新建对应文件。' });
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
    description: 'Deterministically check whether travel between two timestamped events is physically feasible.',
    inputSchema: { type: 'object', properties: { eventA: { type: 'object' }, eventB: { type: 'object' }, transport: { type: 'string', enum: ['walk', 'run', 'horse', 'car', 'train', 'plane', 'magic'] } }, required: ['eventA', 'eventB'], additionalProperties: false },
    async handler(args) { return textResult(checkFeasibility(args.eventA, args.eventB, { transport: args.transport })); },
  },
];

function getToolByName(name) { return TOOLS.find((tool) => tool.name === name) || null; }

module.exports = { TOOLS, getToolByName, textResult, utf8Page };
