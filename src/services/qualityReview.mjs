function compactText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function trimLeadingQuotes(text) {
  return compactText(text).replace(/^["'“”‘’「」『』（）()【】\s]+/, '');
}

function isSplitReactionLead(text) {
  const normalized = compactText(text);
  if (!normalized) return false;
  const sentences = normalized.split(/(?<=[。！？])/u).filter(Boolean);
  const tail = sentences[sentences.length - 1] || normalized;
  return /然后[她他它][^。！？]{0,14}(?:笑了|沉默了|抬起头(?:来)?了?|抬起头|抬眼(?:看了?)?|抬眼|点了点头|闭上了眼|开口了?)[。！？]?$/u.test(tail);
}

function isSplitReactionExplanation(text) {
  const normalized = trimLeadingQuotes(text);
  return /^(?:那是一个|那是一种)/u.test(normalized);
}

function isSplitNotButPair(leftText, rightText) {
  const left = compactText(leftText);
  const right = trimLeadingQuotes(rightText);
  if (!left || !right) return false;
  const leftLooksIncomplete = /不是[^。！？；]{0,40}(?:，也不是[^。！？；]{0,40})?$/u.test(left)
    || /不是[^。！？；]{0,40}，?$/u.test(left);
  const rightLooksLikeTurn = /^(?:而是|更像是|是)[^。！？]?/u.test(right);
  return leftLooksIncomplete && rightLooksLikeTurn;
}

export function buildQualityReviewPayload(paragraphs) {
  const list = Array.isArray(paragraphs) ? paragraphs : [];
  return {
    paragraphs: list.map((paragraph, index) => ({
      id: paragraph.id,
      index: paragraph.index,
      text: paragraph.text,
      prevParagraphId: index > 0 ? list[index - 1].id : null,
      prevText: index > 0 ? list[index - 1].text : '',
      nextParagraphId: index + 1 < list.length ? list[index + 1].id : null,
      nextText: index + 1 < list.length ? list[index + 1].text : '',
    })),
  };
}

export function detectCrossParagraphQualityAnnotations(paragraphs) {
  const list = Array.isArray(paragraphs) ? paragraphs : [];
  const annotations = [];

  for (let index = 0; index < list.length - 1; index += 1) {
    const current = list[index];
    const next = list[index + 1];

    if (isSplitReactionLead(current.text) && isSplitReactionExplanation(next.text)) {
      const note = '跨段 AI 套句：上一段以独立短反应句收尾，下一段再用「那是一个……」式解释；即使拆成两段也应视为同一问题，建议并回上文直叙。';
      annotations.push({ paragraphId: current.id, kind: 'choppy', note });
      annotations.push({ paragraphId: next.id, kind: 'choppy', note });
    }

    if (isSplitNotButPair(current.text, next.text)) {
      const note = '跨段 AI 套句：对照骨架被拆到了相邻两段里，仍属于「不是……而是……/更像是……」类八股，建议删掉对照骨架直接直叙。';
      annotations.push({ paragraphId: current.id, kind: 'not_but_overuse', note });
      annotations.push({ paragraphId: next.id, kind: 'not_but_overuse', note });
    }
  }

  const seen = new Set();
  return annotations.filter((annotation) => {
    const key = `${annotation.paragraphId}::${annotation.kind}::${annotation.note}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}