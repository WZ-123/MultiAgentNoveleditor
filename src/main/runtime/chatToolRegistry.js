'use strict';

const WRITE_TOOL_NAMES = new Set([
  'write_chapter', 'replace_chapter_text', 'apply_chapter_patch',
  'replace_selected_text', 'replace_text_near_cursor', 'insert_text_at_cursor',
  'create_character', 'update_character', 'delete_character', 'patch_character_memory',
  'update_world', 'apply_world_patch', 'append_style_memory', 'append_summary',
  'write_outline_nodes', 'confirm_outline', 'set_workflow_phase',
  'create_novel', 'grant_asset', 'revoke_asset', 'apply_asset_patch',
]);

const CHAPTER_MUTATION_TOOLS = new Set([
  'write_chapter', 'replace_chapter_text', 'apply_chapter_patch',
  'replace_selected_text', 'replace_text_near_cursor', 'insert_text_at_cursor',
]);

const FRONTEND_TOOL_NAMES = new Set([
  'replace_selected_text', 'replace_text_near_cursor', 'insert_text_at_cursor', 'get_full_editor_content',
]);

const BACKEND_TOOL_NAMES = new Set(['set_workflow_phase', 'confirm_outline', 'spawn_subagent']);
const WEB_TOOL_NAMES = new Set(['WebSearch', 'WebFetch']);

function getToolCapability(name) {
  const toolName = String(name || '');
  const effect = WRITE_TOOL_NAMES.has(toolName) || /^(?:write_|update_|create_|delete_|append_|replace_|apply_|grant_|revoke_)/u.test(toolName)
    ? 'write'
    : /^(?:read_|list_|query_|search_|check_|review_|get_|retrieve_)/u.test(toolName) || WEB_TOOL_NAMES.has(toolName)
      ? 'read'
      : 'unknown';
  const execution = FRONTEND_TOOL_NAMES.has(toolName)
    ? 'frontend'
    : BACKEND_TOOL_NAMES.has(toolName)
      ? 'backend'
      : WEB_TOOL_NAMES.has(toolName)
        ? 'web'
        : 'mcp';
  return {
    name: toolName,
    execution,
    effect,
    parallelSafe: effect === 'read' && execution !== 'frontend' && execution !== 'backend',
    cacheScope: effect === 'read' ? 'turn' : 'none',
    requiresConfirmation: effect === 'write',
    supportsCheckpoint: CHAPTER_MUTATION_TOOLS.has(toolName),
    chapterMutation: CHAPTER_MUTATION_TOOLS.has(toolName),
  };
}

function classifyChatTaskContract(userText, session = {}) {
  const source = String(userText || '');
  const text = source.toLowerCase();
  const labels = [];
  const add = (label) => { if (!labels.includes(label)) labels.push(label); };
  if (/(?:人设|角色卡|角色资料|人物卡|character|ooc|补全角色|修改角色|创建角色|删除角色|enrich)/iu.test(text)) add('character_edit');
  if (/(?:世界观|设定|地点|地名|lore|world|place|places|势力)/iu.test(text)
    && /(?:修改|更新|补充|新增|删除|改|调整|查看|查询|读)/u.test(text)) add('world_edit');
  if (/(?:去\s*[aａ]\s*[iｉ]\s*味|ai\s*味|ＡＩ\s*味|套话|八股|机翻腔|模型味|审查|检查|review|一致性|事实核对|错漏|冲突|段落功能|一句一段)/iu.test(text)) add('review');
  if (/(?:写下一章|续写|写作|草稿|章节|改写|修订|润色|正文|剧情|大纲|保存(?:这个|这篇)?章节|确认写入)/u.test(text)) add('writing');
  if (/(?:(?:选中|光标|当前章节|这一章|本章|正文).{0,24}(?:替换|改(?:成|为|一下)?|修改|插入|润色|重写)|(?:替换|修改|插入|润色|重写).{0,24}(?:选中|光标|当前章节|这一章|本章|正文))/u.test(text)) add('writing');
  if (/(?:资产|物品|道具|装备|asset|grant|revoke|移交|转交)/iu.test(text)) add('asset_edit');
  if (/(?:创建|新建|建立).{0,8}(?:小说|项目)|(?:create|new).{0,8}(?:novel|project)/iu.test(text)) add('project_setup');
  if (!labels.length) add('general');

  const writeIntent = /(?:写入|保存|应用|替换|修改|更新|补充|新增|删除|改写|修订|创建|移交|转交|grant|revoke|apply|replace|write|update|delete|create)/iu.test(text);
  const primary = labels.find((label) => label !== 'general') || 'general';
  return {
    id: primary,
    labels,
    phaseHint: String(session?.workflowPhase || ''),
    operation: writeIntent ? 'mutate' : 'read',
    risk: writeIntent ? 'high' : labels.includes('review') ? 'medium' : 'low',
    reason: labels.length > 1 ? 'multi-label-intent' : `${primary}-intent`,
  };
}

module.exports = {
  BACKEND_TOOL_NAMES,
  CHAPTER_MUTATION_TOOLS,
  FRONTEND_TOOL_NAMES,
  WEB_TOOL_NAMES,
  classifyChatTaskContract,
  getToolCapability,
};
