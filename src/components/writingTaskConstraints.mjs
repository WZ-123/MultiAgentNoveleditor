export function taskConstraintsFor(text, skillName, editorContext) {
  const operation = ({
    'mana-fiction-writing': 'write', 'mana-de-ai': 'edit', 'mana-consistency-review': 'review',
    'mana-outline': 'outline', 'mana-character-roleplay': 'roleplay',
  })[skillName] || 'unspecified';
  const resourceRef = String(editorContext?.resourceRef || (editorContext?.chapterFileName ? `chapter:${editorContext.chapterFileName}` : ''));
  const hasSelection = ['selection', 'insertion'].includes(editorContext?.editScope?.mode);
  const source = String(text);
  const digits = String.raw`\d[\d,，]*`;
  const range = source.match(new RegExp(`(${digits})\\s*(?:[—–－-]|至|到|~|～)\\s*(${digits})\\s*(?:个)?(?:净正文)?(?:汉)?字`, 'u'));
  const match = source.match(new RegExp(`(?:(\\d+(?:\\.\\d+)?|[一二三四五六七八九十])\\s*万\\s*字)|(${digits})\\s*(?:个)?(?:净正文)?(?:汉)?字`, 'u'));
  const chinese = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  const integer = (value) => Number(String(value || '').replace(/[,，]/gu, ''));
  const requested = range ? integer(range[1]) : match ? (match[2] ? integer(match[2]) : Math.round((Number(match[1]) || chinese[match[1]] || 0) * 10000)) : null;
  return {
    operation,
    targetResourceRefs: hasSelection && resourceRef ? [resourceRef] : [],
    allowedWriteResourceRefs: hasSelection && resourceRef ? [resourceRef] : [],
    minBodyCjk: requested,
    maxBodyCjk: range ? integer(range[2]) : null,
    completionEvidence: requested ? ['bodyChineseCharacterCount', 'resourceHashes'] : [],
    prohibitRepetition: /(?:不要|避免)[^。；\n]{0,16}重复/u.test(source),
    requiresCompleteEnding: /完整(?:的)?结局/u.test(source),
  };
}
