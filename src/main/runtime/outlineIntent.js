'use strict';

const CREATE_PATTERNS = [
  /(?:创建|生成|写|做|列|规划|设计|整理|梳理|搭|构思|完善|补全|丰满|细化)(?:一份|一个|一下)?(?:小说|故事|这本书|这部小说|本书|剧情)?(?:的)?(?:大纲|章节大纲|详细大纲|完整大纲|纲要|故事结构|剧情结构|章节结构|卷章结构|卷纲|章纲)/,
  /(?:创建|生成|做|列|规划|设计|整理|梳理|细化|完善)(?:一份|一个|一下)?(?:第[0-9一二三四五六七八九十百零两]+(?:章|节|卷)|这章|这一章|下一章)(?:的)?(?:大纲|章节大纲|详细大纲|完整大纲|章纲|剧情大纲|剧情提纲)/,
  /(?:帮我|请|想|需要)?(?:规划|设计|梳理)(?:一下)?(?:剧情走向|故事走向|主线|支线|章节安排|卷章安排|故事结构)/,
  /(?:第[0-9一二三四五六七八九十百零两]+(?:章|节|卷)).*(?:剧情|情节|走向).*(?:有何建议|怎么写|该怎么写|怎么安排|有什么建议)/,
  /(?:第[0-9一二三四五六七八九十百零两]+(?:章|节|卷)).*(?:剧情|情节|内容).*(?:是|为|大概是|大致是|准备写|打算写)/,
  /(?:第[0-9一二三四五六七八九十百零两]+(?:章|节|卷)).*(?:剧情|情节|内容)(?:顺序|安排)?(?:如下|大致如下|安排如下|大概如下)/,
  /(?:承上启下).*(?:第[0-9一二三四五六七八九十百零两]+(?:章|节|卷)|剧情|情节|走向)/,
  /(?:先|先来|先帮我)?(?:列|安排|拆分)(?:一下)?(?:章节|卷|节|卷章)(?:安排|结构)?/,
  /(?:按|按照).*(?:卷|章|节).*(?:拆|分|规划|安排)/,
  /(?:做|列|给).*(?:章节大纲|详细大纲|完整大纲)/,
];

const MODIFY_PATTERNS = [
  /(?:修改|调整|细化|完善|补充|扩展|增补|删减|重排|重写|优化).*(?:大纲|纲要|结构|章节安排|剧情走向|故事走向)/,
  /(?:这个|当前|上面|刚才|现有).*(?:大纲|结构).*(?:修改|调整|细化|完善|补充|扩展|增补|删减|重排|重写|优化)/,
  /(?:把|将).*(?:大纲|结构).*(?:改成|改为|调整为|细化成|扩展成)/,
];

const NEGATIVE_PATTERNS = [
  /(?:润色|改写|重写|续写|扩写|缩写).*(?:这段|这一段|这章|这一章|本章|章节|正文|对话|描写)/,
  /(?:替换|插入|修改).*(?:选中|这段话|这句话|这一句|当前文本)/,
  /(?:角色卡|人物卡|设定卡|世界观设定|时间线)/,
  /(?:读|查看|解释|分析).*(?:大纲|章节)/,
  /(?:总结|概括).*(?:这一章|本章|这段)/,
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

function detectOutlineChatIntent(userText, session) {
  const text = normalize(userText);
  if (!text) {
    return { shouldRoute: false, mode: null, reason: '' };
  }

  const hasPendingDraft = !!session?.pendingOutlineDraft;
  const workflowPhase = session?.workflowPhase || 'idle';
  const wantsReview = /(?:重新|再)?(?:审查|检查|校验).*(?:大纲|时空|时间线|人设|世界观|合理性|逻辑)|(?:时空|时间线|人设|世界观|合理性|逻辑).*(?:审查|检查|校验)/.test(text);

  if (matchesAny(text, NEGATIVE_PATTERNS)) {
    return { shouldRoute: false, mode: null, reason: '' };
  }

  const wantsCreate = matchesAny(text, CREATE_PATTERNS);
  const wantsModify = matchesAny(text, MODIFY_PATTERNS);

  if (hasPendingDraft && (wantsCreate || wantsModify)) {
    return { shouldRoute: true, mode: 'user_outline', reason: 'pending-outline-draft' };
  }

  if (hasPendingDraft && wantsReview) {
    return { shouldRoute: true, mode: 'user_outline', reason: 'outline-review' };
  }

  if (workflowPhase === 'outline' && hasPendingDraft && /(?:继续|接着).*(?:改|调|细化|完善)|(?:再).*(?:补|加).*(?:大纲|结构)/.test(text)) {
    return { shouldRoute: true, mode: 'user_outline', reason: 'outline-followup' };
  }

  if (wantsCreate) {
    return { shouldRoute: true, mode: 'plot_direction', reason: 'outline-create-intent' };
  }

  return { shouldRoute: false, mode: null, reason: '' };
}

function detectOutlineConfirmIntent(userText, session) {
  if (!session?.pendingOutlineDraft) return false;
  const text = normalize(userText);
  if (!text) return false;
  if (matchesAny(text, NEGATIVE_PATTERNS)) return false;
  const explicitConfirm = /(?:确认|保存|写入|采用|就这样|可以了|定稿|落盘).*(?:大纲|这个|当前)?|(?:把|将).*(?:大纲|这个).*(?:保存|写入)|(?:直接|现在).*(?:保存|写入)/.test(text);
  if (explicitConfirm) return true;
  const genericConfirm = /^(?:如上|按上面|按这个|照这个|照上面|就按这个|就按上面)(?:[,， ]*(?:请|直接)?(?:执行|处理|保存|写入))?$/.test(text);
  return genericConfirm;
}

module.exports = {
  detectOutlineChatIntent,
  detectOutlineConfirmIntent,
};