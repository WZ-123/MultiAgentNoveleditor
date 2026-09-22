'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');

function transformOutsideDialogue(text, transform) {
  let output = '';
  let segment = '';
  let quote = '';
  const flush = () => { output += quote ? segment : transform(segment); segment = ''; };
  for (const character of String(text || '')) {
    if (!quote && (character === '“' || character === '"')) {
      flush(); quote = character; segment = character; continue;
    }
    segment += character;
    if ((quote === '“' && character === '”') || (quote === '"' && character === '"' && segment.length > 1)) {
      flush(); quote = '';
    }
  }
  flush();
  return output;
}

function repairMaleThirdPerson(text) {
  return transformOutsideDialogue(text, (segment) => segment
    .replace(/李雾/gu, '林雾')
    .replace(/她的/gu, '他的')
    .replace(/她/gu, '他')
    .replace(/我的/gu, '他的')
    .replace(/我/gu, '林雾'));
}

async function repairNovelPov(novelDir, chapterNumbers) {
  const results = [];
  for (const number of chapterNumbers) {
    const file = `chapter-${String(number).padStart(3, '0')}.md`;
    const filePath = path.join(path.resolve(novelDir), 'chapters', file);
    const before = await fsp.readFile(filePath, 'utf8');
    const after = repairMaleThirdPerson(before);
    if (after !== before) await fsp.writeFile(filePath, after, 'utf8');
    results.push({ file, changed: after !== before, replacements: [...before].reduce((sum, character, index) => sum + (after[index] !== character ? 1 : 0), 0) });
  }
  return results;
}

if (require.main === module) {
  const novelDir = process.argv[2];
  const chapters = process.argv.slice(3).map(Number).filter(Number.isInteger);
  if (!novelDir || !chapters.length) throw new Error('Usage: node scripts/repair-narrative-pov.js <novel-dir> <chapter-number...>');
  repairNovelPov(novelDir, chapters).then((results) => console.log(JSON.stringify(results, null, 2))).catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
}

module.exports = { repairMaleThirdPerson, repairNovelPov, transformOutsideDialogue };
