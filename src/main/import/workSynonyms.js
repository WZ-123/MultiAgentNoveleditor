'use strict';

/** 作品名同义词组：Fandom 子站发现 + 母语搜索用（欧美验收集 6 部中英别名） */
const WORK_SYNONYM_GROUPS = [
  ['黑袍纠察队', 'the boys'],
  ['魔戒', 'lord of the rings', 'the lord of the rings', '指环王'],
  ['哈利波特', 'harry potter'],
  ['漫威', 'marvel', 'marvel comics', '漫威电影宇宙'],
  ['dc', 'dc comics', 'dc漫画', 'dc宇宙'],
  ['rwby'],
];

function workSynonyms(fanworkName) {
  const lower = String(fanworkName || '').trim().toLowerCase();
  if (!lower) return [];
  for (const group of WORK_SYNONYM_GROUPS) {
    if (group.some((g) => {
      const gl = g.toLowerCase();
      return lower === gl || lower.includes(gl) || gl.includes(lower);
    })) {
      return [...group];
    }
  }
  return [fanworkName];
}

module.exports = { workSynonyms, WORK_SYNONYM_GROUPS };
