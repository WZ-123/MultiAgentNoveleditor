import { findDeterministicNotButPatterns } from './qualityReview.mjs';

function compactText(value) {
  return String(value || '').normalize('NFKC').replace(/\s+/gu, ' ').trim();
}

function countMatches(text, pattern) {
  return (compactText(text).match(pattern) || []).length;
}

function paragraphCount(text) {
  return String(text || '').replace(/\r\n/gu, '\n').split(/\n\s*\n/gu).map((item) => item.trim()).filter(Boolean).length;
}

function sentenceCount(text) {
  return countMatches(text, /[。！？!?]/gdu);
}

const CONTENT_ADDITION_RULES = [
  {
    id: 'added_dialogue',
    label: '凭空增加对白',
    pattern: /[“”「」『』]/gdu,
  },
  {
    id: 'added_metaphor',
    label: '凭空增加比喻或解释性类比',
    pattern: /仿佛|如同|好像|宛如|似乎(?:是|在)/gdu,
  },
  {
    id: 'added_atmosphere',
    label: '凭空增加环境或氛围描写',
    pattern: /空气中|光线|月光|阳光|雨声|风声|雾气|尘埃|气息|夜色|寒意|暖意/gdu,
  },
  {
    id: 'added_psychology',
    label: '凭空增加心理解释',
    pattern: /心里|心头|内心|意识到|明白了?|感到|觉得|情绪|念头/gdu,
  },
];

export function assessDeAiMinimality(sourceText, revisedText, options = {}) {
  const source = compactText(sourceText);
  const revised = compactText(revisedText);
  const guidance = compactText(options.guidance);
  const allowParagraphMerge = options.allowParagraphMerge === true
    || /合并|重分段|机械拆段|一句一段|段落功能/gu.test(guidance);
  const violations = [];
  const sourceNotButPatterns = findDeterministicNotButPatterns(sourceText);
  const revisedNotButPatterns = findDeterministicNotButPatterns(revisedText);

  if (!revised) {
    violations.push({ id: 'empty_rewrite', label: '候选改写为空' });
  }

  if (revisedNotButPatterns.length > 0) {
    violations.push(sourceNotButPatterns.length > 0
      ? {
          id: 'not_but_pattern_persists',
          label: '候选仍保留「不是……而是/是/却是/只是……」对照骨架',
          evidence: revisedNotButPatterns[0].excerpt,
        }
      : {
          id: 'introduced_not_but_pattern',
          label: '候选新引入「不是……而是/是/却是/只是……」对照骨架',
          evidence: revisedNotButPatterns[0].excerpt,
        });
  }

  const sourceLength = source.length;
  const revisedLength = revised.length;
  const expansionLimit = Math.max(sourceLength + 24, Math.ceil(sourceLength * 1.45));
  if (sourceLength >= 12 && revisedLength > expansionLimit) {
    violations.push({
      id: 'excessive_expansion',
      label: `无必要扩写（${sourceLength}→${revisedLength} 字）`,
    });
  }

  for (const rule of CONTENT_ADDITION_RULES) {
    const before = countMatches(source, rule.pattern);
    const after = countMatches(revised, rule.pattern);
    if (after > before) {
      violations.push({ id: rule.id, label: rule.label });
    }
  }

  const sourceParagraphs = paragraphCount(sourceText);
  const revisedParagraphs = paragraphCount(revisedText);
  if (!allowParagraphMerge && sourceParagraphs >= 3 && revisedParagraphs <= 1) {
    violations.push({ id: 'flattened_paragraph_rhythm', label: '把原有多段节奏压成单段' });
  }

  const sourceSentences = sentenceCount(sourceText);
  const revisedSentences = sentenceCount(revisedText);
  if (!allowParagraphMerge && sourceSentences >= 5 && revisedSentences <= Math.floor(sourceSentences / 2)) {
    violations.push({ id: 'flattened_sentence_rhythm', label: '过度合并原有短句节奏' });
  }

  return {
    ok: violations.length === 0,
    score: Math.max(0, Number((1 - violations.length * 0.2).toFixed(2))),
    violations,
    metrics: {
      sourceLength,
      revisedLength,
      sourceParagraphs,
      revisedParagraphs,
      sourceSentences,
      revisedSentences,
      allowParagraphMerge,
      sourceNotButPatternCount: sourceNotButPatterns.length,
      revisedNotButPatternCount: revisedNotButPatterns.length,
    },
  };
}

export function minimalityRetryInstruction(assessment) {
  const labels = (assessment?.violations || []).map((item) => item.label).filter(Boolean);
  return [
    '上一版候选因违反“最小必要修改”被拒绝。',
    labels.length ? `问题：${labels.join('；')}。` : '',
    '请重新改写：只处理原文中明确的套话或机械句式；不得增添原文没有的对白、动作、景物、感官、心理、比喻或情绪解释；保留原有短句、停顿、粗粝感和段落疏密。若没有必要修改，原样输出。',
  ].filter(Boolean).join('\n');
}
