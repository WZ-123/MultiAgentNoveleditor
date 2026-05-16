'use strict';

const CHAPTER_INDEX = '[0-9一二三四五六七八九十百零两]+';

const CREATE_PATTERNS = [
  new RegExp(`(?:^|\\s)(?:开始|继续|直接|先)?(?:写|撰写|生成|产出)(?:一下)?(?:第${CHAPTER_INDEX}章|这章|这一章|下一章|正文)`),
  new RegExp(`第${CHAPTER_INDEX}章.*(?:剧情|内容).*(?:是|为|大概是|大致是|准备写|打算写|写成|展开)`),
  new RegExp(`(?:根据|按照).*(?:剧情|提纲|梗概|思路).*(?:写成|扩写成).*(?:第${CHAPTER_INDEX}章|正文|章节)`),
  /(?:把|将).*(?:剧情|梗概|提纲|这段情节).*(?:写成|扩写成).*(?:一章|正文|章节)/,
  /(?:帮我|请|麻烦)?(?:开始|继续)?写(?:这一章|这章|下一章|正文)/,
];

const REVISE_PATTERNS = [
  /(?:修改|调整|细化|润色|重写|改写|强化|压缩|收一下|扩写|补充|完善|重审|再审查|重新审查|检查|校验|合理性|逻辑|时空|时间线)/,
  /(?:这一版|这版|这个草稿|当前草稿|刚才那版).*(?:改|调|润|重写|重审|检查|校验)/,
  /(?:开头|结尾|节奏|对白|转场|时序|时间线|人物).*(?:改|调|润|顺|收|强化)/,
];

const NEGATIVE_PATTERNS = [
  /(?:大纲|纲要|卷章结构|章节结构|剧情结构)/,
  /(?:角色卡|人物卡|设定卡|世界观设定)/,
  /(?:替换|插入|修改).*(?:选中|这段话|这句话|当前文本)/,
  /(?:删除|清理).*(?:时间线|章节|事件)/,
];

const SELECTION_SCOPE_PATTERNS = [
  /(?:选中|划选|高亮|这段话|这句话|当前文本|这段|这一段|这一句|刚高亮的这句|刚才那句)/,
];

const SELECTION_EDIT_PATTERNS = [
  /(?:修改|调整|改写|重写|补充|扩写|细化|强化|完善|润色|插入|加一段|加一点|加一层|加一些|加点|增加|补一段|补一点)/,
];

const NARRATIVE_GUIDANCE_PATTERNS = [
  /(?:剧情|情节|走向|方向|铺垫|伏笔|呼应|因果|合理性|逻辑|时空|时间线|人物关系|人物状态|感情戏|情感线|冲突|转折|承接|过渡|节奏|动机)/,
];

function normalize(text) {
  return String(text || '')
    .replace(/[\t\r\n]+/g, ' ')
    .replace(/[，、；。！？【】（）]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^(?:请先帮我|请帮我|先帮我|麻烦你帮我|麻烦帮我|麻烦你|麻烦|请先|请|先|帮我|我想|想先|想|需要)+\s*/g, '')
    .trim();
}

function matchesAny(text, patterns) {
  return patterns.some((pattern) => pattern.test(text));
}

function isSelectionScopedNarrativeRewrite(text, session) {
  const editorContext = session?.editorContext || {};
  const hasSelectedText = !!String(editorContext.selectedText || '').trim();
  if (!hasSelectedText || editorContext.type !== 'chapter') return false;
  const explicitScope = matchesAny(text, SELECTION_SCOPE_PATTERNS);
  const narrativeRewrite = matchesAny(text, SELECTION_EDIT_PATTERNS)
    && matchesAny(text, NARRATIVE_GUIDANCE_PATTERNS);
  return narrativeRewrite && (explicitScope || hasSelectedText);
}

function detectChapterChatIntent(userText, session) {
  const workflowPhase = session?.workflowPhase || 'idle';
  if (workflowPhase !== 'writing') {
    return { shouldRoute: false, mode: null, reason: '' };
  }

  const text = normalize(userText);
  if (!text) {
    return { shouldRoute: false, mode: null, reason: '' };
  }
  const selectionScopedNarrativeRewrite = isSelectionScopedNarrativeRewrite(text, session);
  if (matchesAny(text, NEGATIVE_PATTERNS) && !selectionScopedNarrativeRewrite) {
    return { shouldRoute: false, mode: null, reason: '' };
  }

  const hasPendingDraft = !!session?.pendingChapterDraft;
  if (hasPendingDraft && (matchesAny(text, REVISE_PATTERNS) || selectionScopedNarrativeRewrite)) {
    return { shouldRoute: true, mode: 'revise', reason: 'pending-chapter-draft' };
  }
  if (hasPendingDraft && /(?:继续|接着).*(?:改|写|润|调)|(?:把|将).*(?:这一版|这版).*(?:改|调|顺)/.test(text)) {
    return { shouldRoute: true, mode: 'revise', reason: 'chapter-followup' };
  }
  if (selectionScopedNarrativeRewrite) {
    return { shouldRoute: true, mode: 'revise', reason: 'selection-narrative-rewrite' };
  }
  if (matchesAny(text, CREATE_PATTERNS)) {
    return { shouldRoute: true, mode: 'create', reason: 'chapter-create-intent' };
  }

  return { shouldRoute: false, mode: null, reason: '' };
}

function detectChapterConfirmIntent(userText, session) {
  if (!session?.pendingChapterDraft) return false;
  const text = normalize(userText);
  if (!text) return false;
  if (matchesAny(text, NEGATIVE_PATTERNS)) return false;
  return /(?:确认|保存|写入|采用|定稿).*(?:这一章|这章|这一版|这版|正文)?|(?:把|将).*(?:这一章|这章|这版).*(?:保存|写入)|(?:就按|按照).*(?:这版|这一版).*(?:写入|保存)/.test(text);
}

module.exports = {
  detectChapterChatIntent,
  detectChapterConfirmIntent,
};