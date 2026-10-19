export function positiveInstructions(text) {
  return String(text).normalize('NFKC').trim().split(/[，,。；;\n]/u)
    .map(value => value.trim().replace(/(?:不要|不必|不用|无需|禁止|(?:^|\s|请|但|也|更|千万)别(?=审|检|自|写|读|改))[\s\S]*$/u, '')).filter(Boolean).join('，');
}
export function taskConstraintsFor(text, skillName, editorContext) {
  const source = String(text).normalize('NFKC').trim();
  const positiveSource = positiveInstructions(source);
  const positive = positiveSource.split('，');
  const requestedReview = positive.some(value => /(?:审校|审阅|审查|自查|自检|自我?(?:筛查|检查)|检查[^。；;\n]{0,24}(?:一致性|冲突|人[物设]|世界观|文风|本章|全书|全文)|一致性[^。；;\n]{0,12}(?:检查|审查))/u.test(value));
  const writingRequest = positive.some(value => /^(?:(?:请|帮我|替我|麻烦)\s*)*(?:继续)?(?:写|创作|续写|补写|修改|改写|修订|重写)/u.test(value)
    || /(?:续写|补写|创作|改写|重写|写)\s*(?:下一章|下章|新章|第[一二三四五六七八九十百\d]+章)/u.test(value));
  const operation = requestedReview && !writingRequest ? 'review' : ({
    'mana-fiction-writing': 'write', 'mana-de-ai': 'edit', 'mana-consistency-review': 'review',
    'mana-outline': 'outline', 'mana-character-roleplay': writingRequest ? 'write' : 'roleplay',
  })[skillName] || (/^(?:(?:请|帮我|替我|麻烦)\s*)*(?:读取|阅读|查看)/u.test(positiveSource) ? 'read'
      : /^(?:(?:请|帮我|替我|麻烦)\s*)*(?:修改|改写|修订|重写)/u.test(source) ? 'edit'
        : writingRequest ? 'write' : /(?:角色驱动|扮演角色|角色扮演)/u.test(positiveSource) ? 'roleplay' : 'unspecified');
  const resourceRef = String(editorContext?.resourceRef || (editorContext?.chapterFileName ? `chapter:${editorContext.chapterFileName}` : ''));
  const hasSelection = ['selection', 'insertion'].includes(editorContext?.editScope?.mode);
  const targetsNewChapter = source.split(/[，,。；;\n]/u).some(clause =>
    !/(?:不要|不必|不用|禁止|别)[^，,。；;\n]*(?:下一章|下章|新章)/u.test(clause)
    && /(?:(?:写|创作|生成|新建|创建)\s*(?:出|一)?(?:个)?(?:下一章|下章|新章(?:节)?)|保存(?:为|成)\s*(?:一(?:个)?)?新章(?:节)?|^\s*(?:下一章|下章))/u.test(clause));
  const targetsWholeNovel = /(?:全书|整本(?:小说)?|整部(?:小说)?|全文|全篇)/u.test(positiveSource);
  const targetsCurrent = hasSelection || (!targetsNewChapter && /(?:当前章(?:节)?|本章|这一章|选中(?:的)?(?:段落|正文|文本))/u.test(positiveSource));
  const explicitRefs = [...new Set(positiveSource.match(/(?:chapter:chapter-[\w.-]+\.md|character(?:-memory)?:[^\s,，。；;、]+|world:(?:lore|places)|outline:(?:master|nodes|hierarchy|chapter:\d+:\d+:\d+)|style:memory|timeline:all)/gu) || [])];
  const chapterRefs = explicitRefs.filter(ref => ref.startsWith('chapter:'));
  const targetRefs = ['read', 'review'].includes(operation) || !chapterRefs.length ? explicitRefs : chapterRefs;
  const reviewRequired = operation === 'review' || requestedReview;
  const digits = String.raw`\d[\d,，]*`;
  const range = positiveSource.match(new RegExp(`(${digits})\\s*(?:[—–－-]|至|到|~|～)\\s*(${digits})\\s*(?:个)?(?:净正文)?(?:汉)?字`, 'u'));
  const match = positiveSource.match(new RegExp(`(?:(\\d+(?:\\.\\d+)?|[一二三四五六七八九十])\\s*万\\s*字)|(${digits})\\s*(?:个)?(?:净正文)?(?:汉)?字`, 'u'));
  const chinese = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  const deletionSource = positiveSource.replace(/(?:不(?:允许|能|得|可)?|无须|禁止)\s*(?:删除|删掉|移除)[^，]*/gu, '');
  const integer = (value) => Number(String(value || '').replace(/[,，]/gu, ''));
  const requested = range ? integer(range[1]) : match ? (match[2] ? integer(match[2]) : Math.round((Number(match[1]) || chinese[match[1]] || 0) * 10000)) : null;
  return {
    operation,
    wordCountScope: targetsCurrent ? 'target_resources' : targetsNewChapter ? 'new_writing' : targetsWholeNovel ? 'whole_novel' : 'saved_resources',
    targetResourceRefs: targetRefs.length ? targetRefs : targetsCurrent && resourceRef ? [resourceRef] : [],
    allowedWriteResourceRefs: hasSelection && resourceRef ? [resourceRef] : [],
    allowResourceDeletion: /(?:删除|删掉|移除)\s*(?:当前|本|这[个一份]?|该|整[个份章]|指定|全部|所有|第[一二三四五六七八九十\d]+)?(?:的)?\s*(?:章(?:节)?|文件|角色(?:卡|记忆)?|世界观|资料|资源)/u.test(deletionSource),
    minBodyCjk: requested,
    maxBodyCjk: range ? integer(range[2]) : null,
    wordCountToleranceRatio: requested ? 0 : 0.05,
    completionEvidence: requested ? ['bodyChineseCharacterCount', 'resourceHashes'] : [],
    prohibitRepetition: /(?:不要|避免)[^。；\n]{0,16}重复/u.test(source),
    requiresCompleteEnding: /完整(?:的)?结局/u.test(positiveSource),
    reviewRequired,
    repairRequired: reviewRequired && (['write','edit'].includes(operation) || /(?:修复|修正|修好|纠正|改正)/u.test(positiveSource))
      && !/(?:只|仅)[^，。；;]{0,8}(?:报告|列出)|不(?:用|要|必)?(?:修复|修正|修改)/u.test(source),
    reviewScope: targetsWholeNovel ? 'whole_novel' : explicitRefs.length || targetsCurrent ? 'target_resources'
      : ['write', 'edit', 'outline'].includes(operation) ? 'saved_resources' : 'observed_resources',
    reviewTargetResourceRefs: explicitRefs.length ? explicitRefs : targetsCurrent && resourceRef ? [resourceRef] : [],
    reviewScopeBound: false,
  };
}
