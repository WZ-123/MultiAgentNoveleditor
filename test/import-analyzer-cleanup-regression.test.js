#!/usr/bin/env node
'use strict';

const analyzer = require('../src/main/import/analyzer');
const {
  _cleanAnalysisMarkdown,
  _extractTimelineFromOutline,
  _extractNamesFromOutline,
  _extractTrustedCjkNamesFromHints,
  _appendCandidateNamesToHints,
  _normalizeCandidateNameItems,
  _mergeCandidateNameItems,
  _normalizePersonName,
  _isDefinitelyNonPersonName,
  _looksLikeChinesePersonName,
  _extractNonChineseNamesFromHints,
  _sanitizeCharacterCards,
  _buildCharacterFocusedText,
} = analyzer._internal;

let total = 0;
let failed = 0;

function pass(message) {
  total++;
  console.log('  PASS', message);
}

function fail(message, detail) {
  total++;
  failed++;
  console.log('  FAIL', message, detail || '');
}

const dirtyStyle = '好的，根据您提供的文本，以下是对该小说写作风格特征与作者创作意图的分析。\n\n---\n\n#### ## 叙述视角\n\n内容';
const cleanStyle = _cleanAnalysisMarkdown(dirtyStyle);
if (!cleanStyle.startsWith('## 叙述视角') && !cleanStyle.startsWith('### 叙述视角')) {
  fail('cleans model preface and malformed headings', cleanStyle);
} else if (/好的|以下是|#### ##/.test(cleanStyle)) {
  fail('removes preface text', cleanStyle);
} else {
  pass('cleans model preface and malformed headings');
}

const outline = `## 主要人物关系
* **我（主角）**：叙述者。
* **陈可**：空姐。
* **刘燕君**：另一名空姐。
* **金发女孩**：描述性称呼。

## 章节概要
* **迫降与初遇**：飞机迫降，主角发现陈可。
* **基地初开**：刘燕君苏醒。`;

const names = _extractNamesFromOutline('空姐陈可\n空姐刘燕君\n' + outline);
if (names.includes('陈可') && names.includes('刘燕君') && !names.includes('金发女孩')) {
  pass('extracts concrete names without descriptive placeholder');
} else {
  fail('extracts concrete names without descriptive placeholder', JSON.stringify(names));
}

const noisyNames = _extractNamesFromOutline(`## 主要人物关系
* **一行人将**：这不是姓名。
* **一边一只**：这不是姓名。
* **下手也相**：这不是姓名。
* **陈可**：空姐。
* **刘燕君**：空姐。
* **上野茜**：乘客。`);
if (noisyNames.includes('陈可') && noisyNames.includes('刘燕君') && noisyNames.includes('上野茜') && !noisyNames.includes('一行人将') && !noisyNames.includes('一边一只') && !noisyNames.includes('下手也相')) {
  pass('rejects sentence fragments when extracting fallback names');
} else {
  fail('rejects sentence fragments when extracting fallback names', JSON.stringify(noisyNames));
}

if (_normalizePersonName('陈可') === '陈可' && _looksLikeChinesePersonName('刘燕君') && !_normalizePersonName('一片空白') && !_normalizePersonName('一行人将')) {
  pass('normalizes only plausible Chinese person names');
} else {
  fail('normalizes only plausible Chinese person names');
}

const garbageCandidates = [
  '第一部分',
  '第二部分',
  '第三部分',
  '第五阶段',
  '和舞蹈生',
  '和陈可一',
  '金发碧眼',
  '陈可的上',
  '能去主动',
  '都拿过世',
  '角色确认',
  '导入分析',
];
if (garbageCandidates.every(_isDefinitelyNonPersonName) && !_isDefinitelyNonPersonName('飞鸟马时') && !_isDefinitelyNonPersonName('调月莉音')) {
  pass('rejects structural and phrase-like garbage without blocking Japanese kanji names');
} else {
  fail('rejects structural and phrase-like garbage without blocking Japanese kanji names', JSON.stringify(garbageCandidates.map((name) => [name, _isDefinitelyNonPersonName(name)])));
}

const jpCjkHints = _appendCandidateNamesToHints('关键日本人名：飞鸟马时、调月莉音。其他阶段内容不要识别。', ['飞鸟马时', '调月莉音']);
const jpCjkNames = _extractTrustedCjkNamesFromHints(jpCjkHints);
if (jpCjkNames.includes('飞鸟马时') && jpCjkNames.includes('调月莉音') && !jpCjkNames.includes('其他阶段')) {
  pass('extracts AI-confirmed Japanese kanji names from Chatbox hints');
} else {
  fail('extracts AI-confirmed Japanese kanji names from Chatbox hints', JSON.stringify(jpCjkNames));
}

const foreignNames = _extractNonChineseNamesFromHints('角色：アリサ、レム、Катюша、Иван Петров。不要识别 USER 和 JSON。');
if (foreignNames.includes('アリサ') && foreignNames.includes('レム') && foreignNames.includes('Катюша') && foreignNames.includes('Иван Петров')) {
  pass('extracts trusted Japanese kana and Russian Cyrillic names from hints');
} else {
  fail('extracts trusted Japanese kana and Russian Cyrillic names from hints', JSON.stringify(foreignNames));
}

const candidateItems = _mergeCandidateNameItems(_normalizeCandidateNameItems([
  { name: '飞鸟马时', aliases: ['马时'] },
  { name: '马时', aliases: ['飞鸟马时'] },
  { name: '调月莉音', aliases: ['莉音'] },
  { name: '莉音', aliases: ['调月莉音'] },
  { name: '第一部分' },
  { name: '和舞蹈生' },
  { name: '陈可的上' },
  '飞鸟马时',
]));
const candidateNames = candidateItems.map((item) => item.name);
if (candidateNames.includes('飞鸟马时') && candidateNames.includes('调月莉音') && candidateItems.length === 2 && !candidateNames.includes('第一部分') && !candidateNames.includes('和舞蹈生')) {
  pass('merges repeated candidate names and filters AI garbage across chunks');
} else {
  fail('merges repeated candidate names and filters AI garbage across chunks', JSON.stringify(candidateItems));
}

const events = _extractTimelineFromOutline(outline);
if (events.length === 2 && events[0].title === '迫降与初遇' && events[1].event.includes('刘燕君')) {
  pass('builds timeline fallback from outline chapter summaries');
} else {
  fail('builds timeline fallback from outline chapter summaries', JSON.stringify(events));
}

const sanitized = _sanitizeCharacterCards([
  { id: 'chenke', name: '陈可', role: '空姐' },
  { id: 'fujizhang', name: '副驾驶', role: '副驾驶' },
  { id: 'jizhang', name: '机长', role: '机长' },
  { id: 'kongjie1', name: '', role: '空姐' },
  { id: 'black_stocking_attendant', name: '', role: '空姐' },
  { id: 'captain', name: '', role: '机长' },
  { id: 'first_officer', name: '', role: '副驾驶' },
  { id: 'protagonist', name: '', role: '主角' },
  { id: 'wo', name: '', role: '乘客', protagonist: true },
  { id: 'alina', name: 'Alina', role: '芭蕾舞者' },
  { id: 'bad1', name: '一片空白', role: '' },
  { id: 'bad2', name: '一行人将', role: '' },
  { id: 'bad3', name: '下手也相', role: '' },
  { id: 'bad4', name: '第一部分', role: '' },
  { id: 'bad5', name: '第三部分', role: '' },
  { id: 'bad6', name: '第五阶段', role: '' },
  { id: 'bad7', name: '和舞蹈生', role: '' },
  { id: 'bad8', name: '陈可的上', role: '' },
  { id: 'asuka', name: '飞鸟马时', role: '日本人' },
  { id: 'tsukitsuki', name: '调月莉音', role: '日本人' },
  { id: 'rem', name: 'レム', role: '旅人' },
  { id: 'katyusha', name: 'Катюша', role: '军官' },
  { id: 'ivan_petrov', name: 'Иван Петров', role: '医生' },
  { id: 'fake_ru', name: 'Алексей', role: '幻觉角色' },
], _appendCandidateNamesToHints('陈可\n刘燕君\nAlina\n飞鸟马时\n调月莉音\nレム\nКатюша\nИван Петров', ['飞鸟马时', '调月莉音']));
const sanitizedNames = sanitized.map((ch) => ch.name);
if (sanitizedNames.includes('陈可') && sanitizedNames.includes('我（主角）') && sanitizedNames.includes('Alina') && sanitizedNames.includes('飞鸟马时') && sanitizedNames.includes('调月莉音') && sanitizedNames.includes('レム') && sanitizedNames.includes('Катюша') && sanitizedNames.includes('Иван Петров') && !sanitizedNames.includes('Алексей') && !sanitizedNames.includes('副驾驶') && !sanitizedNames.includes('机长') && !sanitizedNames.includes('一片空白') && !sanitizedNames.includes('一行人将') && !sanitizedNames.includes('第一部分') && !sanitizedNames.includes('第三部分') && !sanitizedNames.includes('第五阶段') && !sanitizedNames.includes('和舞蹈生') && !sanitizedNames.includes('陈可的上')) {
  pass('sanitizes generic roles and synthetic ids from character cards');
} else {
  fail('sanitizes generic roles and synthetic ids from character cards', JSON.stringify(sanitized));
}

const focused = _buildCharacterFocusedText(_appendCandidateNamesToHints('陈可\n刘燕君\nAlina\n飞鸟马时\n调月莉音\nレム\nКатюша', ['飞鸟马时', '调月莉音']), '陈可在休息室。飞鸟马时看向调月莉音。レム看向Катюша。'.repeat(20) + ' captain first_officer black_stocking_attendant ');
if (focused.includes('候选角色姓名') && focused.includes('陈可') && focused.includes('Alina') && focused.includes('飞鸟马时') && focused.includes('调月莉音') && focused.includes('レム') && focused.includes('Катюша') && !focused.includes('black_stocking_attendant')) {
  pass('builds focused Chatbox character material instead of full-text role soup');
} else {
  fail('builds focused Chatbox character material instead of full-text role soup', focused);
}

if (failed > 0) {
  console.log(`\n${failed}/${total} failed`);
  process.exit(1);
}
console.log(`\n${total}/${total} passed`);
