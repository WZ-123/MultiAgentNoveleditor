function compactText(text) {
  return String(text || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
}

function trimLeadingQuotes(text) {
  return compactText(text).replace(/^["'“”‘’「」『』（）()【】\s]+/, '');
}

function isSplitReactionLead(text) {
  const normalized = compactText(text);
  if (!normalized) return false;
  const sentences = normalized.split(/(?<=[。！？])/u).filter(Boolean);
  const tail = sentences[sentences.length - 1] || normalized;
  return /(?:然后|随后|接着|忽然|这时)[她他它我你](?:们)?[^。！？]{0,14}(?:笑了|沉默了|抬起头(?:来)?了?|抬起头|抬眼(?:看了?)?|抬眼|点了点头|闭上了眼|开口了?)[。！？]?$/u.test(tail);
}

function isSplitReactionExplanation(text) {
  const normalized = trimLeadingQuotes(text);
  return /^(?:那是一个|那是一种)/u.test(normalized);
}

function isSplitNotButPair(leftText, rightText) {
  const left = compactText(leftText);
  const right = trimLeadingQuotes(rightText);
  if (!left || !right) return false;
  const leftLooksIncomplete = /不是[^。！？；;]{0,40}(?:[,，]也不是[^。！？；;]{0,40})?$/u.test(left)
    || /不是[^。！？；;]{0,40}[,，]?$/u.test(left);
  const rightLooksLikeTurn = /^(?:而是|更像是|是)[^。！？]?/u.test(right);
  return leftLooksIncomplete && rightLooksLikeTurn;
}

function isSplitMultiNegativePair(leftText, rightText) {
  const left = compactText(leftText);
  const right = trimLeadingQuotes(rightText);
  if (!left || !right) return false;
  // Left ends with 2+ "不是X" clauses (consecutive negatives, possibly separated by 、or ，)
  const leftHasMultiNegative = /(?:不是[^。！？；;]{0,40}[、，,]){1,}不是[^。！？；;]{0,40}[。]?$/u.test(left)
    || /不是[^。！？；;]{0,40}[、，,]不是[^。！？；;]{0,40}[。]?$/u.test(left);
  // Right starts with "是"/"那是"/"他是" (the reveal)
  const rightIsReveal = /^(?:那是|他是|这是|是)(?![^。！？；]{0,20}(?:不是|也不是))/u.test(right);
  return leftHasMultiNegative && rightIsReveal;
}

function hasNoNoJustPattern(text) {
  const t = compactText(text);
  if (!t) return false;
  return /没有[^。！？；;]{0,20}[、，,]没有[^。！？；;]{0,20}[、，,]?只是/u.test(t);
}

function hasMultiNegativeEnumeration(text) {
  const t = compactText(text);
  if (!t) return false;
  // 3+ "不是X" clauses in the same sentence/paragraph followed by a reveal
  return /(?:不是[^。！？；;]{0,40}[、，,]){2,}不是[^。！？；;]{0,40}[。]?\s*(?:那是|他是|这是|是)/u.test(t);
}

const STOCK_IMAGE_PATTERNS = [
  /揉碎的丝绸/u,
  /从梦境深处传来/u,
  /活物般/u,
  /如同银白色的孔雀开屏/u,
  /如同被抽去了所有力气般/u,
];

function isAiEndingTriad(text) {
  const t = compactText(text);
  if (!t) return false;
  const hasQuestionLead = /[？?]/u.test(t);
  const hasTeaserTail = /(?:才刚刚开始|才刚刚拉开帷幕|等待着被发掘|等待着被揭开)/u.test(t);
  const hasAbstractWrap = /(?:盛宴|秘密|珍宝|帷幕|开始)/u.test(t);
  return hasQuestionLead && hasTeaserTail && hasAbstractWrap;
}

function isEllipsisSeparator(text) {
  return /^(?:(?:…|⋯){2,}|\.{3,})$/u.test(compactText(text));
}

function countLikeSimiles(text) {
  const matches = compactText(text).match(/如同|仿佛|好似/gdu);
  return Array.isArray(matches) ? matches.length : 0;
}

function hasStockImageReuse(text) {
  const t = compactText(text);
  return STOCK_IMAGE_PATTERNS.some((pattern) => pattern.test(t));
}

function hasLabelDescriptor(text) {
  const t = compactText(text);
  return /(?:声音|语气|嗓音|眼眸|眸中|目光|笑容)[^。！？]{0,10}带着(?:一丝|一种|几分|些许)/u.test(t);
}

function hasChecklistLikeSensoryEnumeration(text) {
  const t = compactText(text);
  if (!t) return false;
  const hits = t.match(/耳朵|眼睛|眼眸|鼻子|嘴巴|嘴唇|乳头|乳房|切口|大腿|皮肤|舌头/gdu) || [];
  return hits.length >= 5;
}

function countEmDashes(text) {
  const hits = String(text || '').match(/——/gdu);
  return Array.isArray(hits) ? hits.length : 0;
}

function countSentenceTerminators(text) {
  const hits = compactText(text).match(/[。！？!?]/gdu);
  return Array.isArray(hits) ? hits.length : 0;
}

function isDialogueLikeParagraph(text) {
  const t = compactText(text);
  if (!t) return false;
  return /^[“"「『]/u.test(t)
    || /[”"」』]$/.test(t)
    || /^[^：:]{1,16}[：:][“"「『]/u.test(t);
}

function isSingleSentenceNarrativeParagraph(text) {
  const t = compactText(text);
  if (!t || /^#+\s*/u.test(t) || isEllipsisSeparator(t) || isDialogueLikeParagraph(t)) return false;
  if (t.length < 8) return false;
  const terminators = countSentenceTerminators(t);
  return terminators <= 1 && /[。！？!?]$/u.test(t);
}

function detectMechanicalSingleSentenceRuns(paragraphs) {
  const list = Array.isArray(paragraphs) ? paragraphs : [];
  const annotations = [];
  let run = [];

  function flushRun() {
    if (run.length < 3) {
      run = [];
      return;
    }
    const totalChars = run.reduce((sum, paragraph) => sum + compactText(paragraph.text).length, 0);
    if (totalChars < 60) {
      run = [];
      return;
    }
    const note = '段落功能审查：连续多个非对话单句段讲同一段叙事，像把本可合并的说明/动作机械拆成一句一段。建议按叙事功能合并为自然段，只保留真正承担停顿、反转、情绪落点或场景切换的单句段。';
    for (const paragraph of run) {
      annotations.push({ paragraphId: paragraph.id, kind: 'choppy', note });
    }
    run = [];
  }

  for (const paragraph of list) {
    if (isSingleSentenceNarrativeParagraph(paragraph.text)) {
      run.push(paragraph);
    } else {
      flushRun();
    }
  }
  flushRun();

  return annotations;
}

export function detectParagraphFunctionAnnotations(paragraphs) {
  return detectMechanicalSingleSentenceRuns(paragraphs);
}

export function buildParagraphFunctionReviewPayload(paragraphs, focus = '') {
  const list = Array.isArray(paragraphs) ? paragraphs : [];
  const candidates = [];
  const runs = [];
  let currentRun = [];

  function flushRun() {
    if (currentRun.length >= 3) {
      runs.push({
        paragraphIds: currentRun.map((paragraph) => paragraph.id),
        paragraphIndexes: currentRun.map((paragraph) => paragraph.index),
        totalChars: currentRun.reduce((sum, paragraph) => sum + compactText(paragraph.text).length, 0),
      });
    }
    currentRun = [];
  }

  for (let index = 0; index < list.length; index += 1) {
    const paragraph = list[index];
    const isCandidate = isSingleSentenceNarrativeParagraph(paragraph.text);
    if (isCandidate) {
      currentRun.push(paragraph);
      candidates.push({
        id: paragraph.id,
        index: paragraph.index,
        text: paragraph.text,
        prevParagraphId: index > 0 ? list[index - 1].id : null,
        prevText: index > 0 ? list[index - 1].text : '',
        nextParagraphId: index + 1 < list.length ? list[index + 1].id : null,
        nextText: index + 1 < list.length ? list[index + 1].text : '',
      });
    } else {
      flushRun();
    }
  }
  flushRun();

  return {
    focus: String(focus || '').trim(),
    paragraphs: buildQualityReviewPayload(list).paragraphs,
    candidates,
    candidateRuns: runs,
    deterministicAnnotations: detectParagraphFunctionAnnotations(list),
  };
}

function detectHeuristicParagraphAnnotations(paragraphs) {
  const list = Array.isArray(paragraphs) ? paragraphs : [];
  const annotations = [...detectMechanicalSingleSentenceRuns(list)];
  const separatorIndexes = list
    .map((paragraph, index) => (isEllipsisSeparator(paragraph.text) ? index : -1))
    .filter((index) => index >= 0);
  const overusesEllipsisSeparators = separatorIndexes.length >= 4;

  for (let index = 0; index < list.length; index += 1) {
    const paragraph = list[index];
    const normalized = compactText(paragraph.text);
    if (!normalized) continue;

    if (isAiEndingTriad(normalized) && index >= Math.max(0, list.length - 3)) {
      annotations.push({
        paragraphId: paragraph.id,
        kind: 'other',
        note: 'AI 式章末三段式收尾：用“抛问题 + 抽象结论 + 预告才刚开始”收束章节，建议改成角色动作、对话或现场余波，不要替读者盖章总结。',
      });
    }

    if (countLikeSimiles(normalized) >= 2) {
      annotations.push({
        paragraphId: paragraph.id,
        kind: 'other',
        note: '比喻触发词过密：同段连续使用「如同/仿佛/好似」，容易形成 AI 式比喻堆砌，建议删到只留最有力的一个，其他改成直接描写。',
      });
    }

    if (hasNoNoJustPattern(normalized)) {
      annotations.push({
        paragraphId: paragraph.id,
        kind: 'not_but_overuse',
        patternId: 'no_no_just',
        confidence: 0.95,
        severity: 'high',
        note: '「没有A，没有B，只是C」属于 not-but 同类八股：先连否两个状态，再用「只是」兜答案，建议删掉整套对照骨架，把 C 直接写成状态或动作。',
      });
    }

    if (hasMultiNegativeEnumeration(normalized)) {
      annotations.push({
        paragraphId: paragraph.id,
        kind: 'not_but_overuse',
        patternId: 'multi_negative_enumeration',
        confidence: 0.95,
        severity: 'high',
        note: '连续否定铺排：同段反复罗列「不是 A/B/C」后再用「是/那是」兜出结论，建议删掉否定排比，直接写进叙事。',
      });
    }

    if (hasStockImageReuse(normalized)) {
      annotations.push({
        paragraphId: paragraph.id,
        kind: 'other',
        note: '顺手意象库存痕迹：出现了高复用陈词意象（如「揉碎的丝绸」「梦境深处」「活物般」一类），建议不要回收旧比喻，直接改成当下动作或质感。',
      });
    }

    if (hasLabelDescriptor(normalized)) {
      annotations.push({
        paragraphId: paragraph.id,
        kind: 'other',
        note: '标签式描述：反复使用「声音中带着一丝……」「眸中带着一种……」这类挂抽象词尾巴的句式，建议直接写声音怎么变、眼神落在哪里。',
      });
    }

    if (hasChecklistLikeSensoryEnumeration(normalized)) {
      annotations.push({
        paragraphId: paragraph.id,
        kind: 'other',
        note: '感官清单式枚举：按部位/感官逐项扫描，像在照清单打勾，建议只保留最有压强的 1-2 个感官点。',
      });
    }

    if (countEmDashes(paragraph.text) >= 2) {
      annotations.push({
        paragraphId: paragraph.id,
        kind: 'other',
        note: '破折号使用过密：一段里频繁用「——」插说明、补判断、制造假停顿，读起来很像 AI 在拿破折号当节奏器，建议改成更直接的句号或逗号结构。',
      });
    }
  }

  if (overusesEllipsisSeparators) {
    for (const index of separatorIndexes) {
      annotations.push({
        paragraphId: list[index].id,
        kind: 'other',
        note: '转场过度依赖「……」分隔线：本章省略号分隔出现过密，建议只在确实需要硬切时保留，其余直接用动作或时间变化转场。',
      });
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
  const annotations = [...detectHeuristicParagraphAnnotations(list)];

  for (let index = 0; index < list.length - 1; index += 1) {
    const current = list[index];
    const next = list[index + 1];

    if (isSplitReactionLead(current.text) && isSplitReactionExplanation(next.text)) {
      const note = '跨段 AI 套句：上一段以独立短反应句收尾，下一段再用「那是一个……」式解释；即使拆成两段也应视为同一问题，建议并回上文直叙。';
      annotations.push({ paragraphId: current.id, kind: 'choppy', patternId: 'reaction_then_explanation', confidence: 0.94, severity: 'high', note });
      annotations.push({ paragraphId: next.id, kind: 'choppy', patternId: 'reaction_then_explanation', confidence: 0.94, severity: 'high', note });
    }

    if (isSplitNotButPair(current.text, next.text)) {
      const note = '跨段 AI 套句：对照骨架被拆到了相邻两段里，仍属于「不是……而是……/更像是……」类八股，建议删掉对照骨架直接直叙。';
      annotations.push({ paragraphId: current.id, kind: 'not_but_overuse', patternId: 'split_not_but', confidence: 0.94, severity: 'high', note });
      annotations.push({ paragraphId: next.id, kind: 'not_but_overuse', patternId: 'split_not_but', confidence: 0.94, severity: 'high', note });
    }

    if (isSplitMultiNegativePair(current.text, next.text)) {
      const note = '跨段 AI 套句：连续否定铺排被拆到了相邻两段里（前一段结尾「不是A、不是B」、后一段开头「是D」），建议砍掉整套否定排比，把正句直接写进叙事。';
      annotations.push({ paragraphId: current.id, kind: 'not_but_overuse', patternId: 'split_multi_negative', confidence: 0.96, severity: 'high', note });
      annotations.push({ paragraphId: next.id, kind: 'not_but_overuse', patternId: 'split_multi_negative', confidence: 0.96, severity: 'high', note });
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
