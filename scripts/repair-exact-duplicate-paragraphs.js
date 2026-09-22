'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');

function cjkCount(text) { return (String(text || '').match(/[\u3400-\u9fff]/gu) || []).length; }
function normalizeParagraph(text) { return String(text || '').replace(/\s+/gu, ''); }

function removeRepeatedSentences(markdown, minimumCjk = 12) {
  const seen = [];
  const removed = [];
  const content = String(markdown || '').replace(/[^。！？!?\n]+[。！？!?]/gu, (sentence) => {
    const normalized = normalizeParagraph(sentence);
    if (cjkCount(normalized) < minimumCjk) return sentence;
    const duplicate = seen.some((prior) => {
      if (prior === normalized) return true;
      const shorter = prior.length <= normalized.length ? prior : normalized;
      const longer = prior.length > normalized.length ? prior : normalized;
      return shorter.length / longer.length >= 0.85 && longer.includes(shorter);
    });
    if (duplicate) {
      removed.push(sentence);
      return '';
    }
    seen.push(normalized);
    return sentence;
  });
  return { content, removed };
}

function removeExactDuplicateParagraphs(markdown, minimumCjk = 50) {
  const trailingNewline = String(markdown || '').endsWith('\n');
  const paragraphs = String(markdown || '').split(/\n{2,}/u).map((paragraph) => paragraph.trim()).filter(Boolean);
  const seen = new Set();
  const seenParagraphs = [];
  const removed = [];
  const kept = [];
  for (const paragraph of paragraphs) {
    const normalized = normalizeParagraph(paragraph);
    const containedDuplicate = cjkCount(normalized) >= minimumCjk && seenParagraphs.some((prior) => {
      const shorter = prior.length <= normalized.length ? prior : normalized;
      const longer = prior.length > normalized.length ? prior : normalized;
      return cjkCount(shorter) >= minimumCjk && shorter.length / longer.length >= 0.75 && longer.includes(shorter);
    });
    if (cjkCount(normalized) >= minimumCjk && (seen.has(normalized) || containedDuplicate)) {
      removed.push(paragraph);
      continue;
    }
    seen.add(normalized);
    seenParagraphs.push(normalized);
    kept.push(paragraph);
  }
  return { content: `${kept.join('\n\n')}${trailingNewline ? '\n' : ''}`, removed };
}

function removeAssistantRefusalPollution(markdown) {
  const trailingNewline = String(markdown || '').endsWith('\n');
  let paragraphs = String(markdown || '').split(/\n{2,}/u).map((paragraph) => paragraph.trim()).filter(Boolean);
  const removed = [];
  if (/^(?:我无法完成|I (?:cannot|can't) complete)/iu.test(paragraphs[0] || '')) {
    const narrativeStart = paragraphs.findIndex((paragraph) => cjkCount(paragraph) >= 40
      && !/(?:任务|要求|问题|提供|上下文|资源|请你|无法)/u.test(paragraph)
      && !/^(?:[-*\d>.]|为了|这里|你的消息)/u.test(paragraph));
    if (narrativeStart > 0) {
      removed.push(...paragraphs.slice(0, narrativeStart));
      paragraphs = paragraphs.slice(narrativeStart);
    }
  }
  while (paragraphs.length && /^(?:请你提供|我无法完成|I (?:cannot|can't) complete)/iu.test(paragraphs.at(-1))) removed.push(paragraphs.pop());
  return { content: `${paragraphs.join('\n\n')}${trailingNewline ? '\n' : ''}`, removed };
}

async function repairNovel(novelDir, minimumCjk = 50) {
  const chapterDir = path.join(path.resolve(novelDir), 'chapters');
  const files = (await fsp.readdir(chapterDir)).filter((file) => /^chapter-\d+\.md$/u.test(file)).sort();
  const results = [];
  for (const file of files) {
    const filePath = path.join(chapterDir, file);
    const before = await fsp.readFile(filePath, 'utf8');
    const decontaminated = removeAssistantRefusalPollution(before);
    const repaired = removeExactDuplicateParagraphs(decontaminated.content, minimumCjk);
    const sentenceRepaired = removeRepeatedSentences(repaired.content);
    const removed = [...decontaminated.removed, ...repaired.removed, ...sentenceRepaired.removed];
    if (removed.length) await fsp.writeFile(filePath, sentenceRepaired.content, 'utf8');
    results.push({ file, removed: removed.length, removedCjk: removed.reduce((sum, paragraph) => sum + cjkCount(paragraph), 0) });
  }
  return results;
}

if (require.main === module) {
  const novelDir = process.argv[2];
  const minimumCjk = Number(process.argv[3] || 50);
  if (!novelDir) throw new Error('Usage: node scripts/repair-exact-duplicate-paragraphs.js <novel-dir> [minimum-cjk]');
  repairNovel(novelDir, minimumCjk).then((results) => {
    console.log(JSON.stringify({ minimumCjk, results, totalRemoved: results.reduce((sum, result) => sum + result.removed, 0), totalRemovedCjk: results.reduce((sum, result) => sum + result.removedCjk, 0) }, null, 2));
  }).catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
}

module.exports = { normalizeParagraph, removeAssistantRefusalPollution, removeExactDuplicateParagraphs, removeRepeatedSentences, repairNovel };
