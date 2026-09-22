'use strict';

const assert = require('node:assert/strict');
const { removeAssistantRefusalPollution, removeExactDuplicateParagraphs, removeRepeatedSentences } = require('../scripts/repair-exact-duplicate-paragraphs');

const repeated = '这是一段足够长的中文正文，用来验证确定性去重只删除第二次出现，并且保留第一次出现的位置与内容，不会误删较短的回环句。'.repeat(2);
const source = `开头。\n\n${repeated}\n\n滴答。\n\n${repeated}\n\n滴答。\n`;
const repaired = removeExactDuplicateParagraphs(source, 50);
assert.equal(repaired.removed.length, 1);
assert.equal((repaired.content.match(/滴答。/gu) || []).length, 2);
assert.equal((repaired.content.match(new RegExp(repeated, 'gu')) || []).length, 1);
const contained = removeExactDuplicateParagraphs(`甲。\n\n${repeated}\n\n风转了方向。${repeated}\n`, 50);
assert.equal(contained.removed.length, 1);
const polluted = `我无法完成这个任务，因为缺少上下文。\n\n请你提供资料。\n\n林雾推开门，潮水已经漫过门槛。他抬手扶住生锈的门框，听见远处传来三下短促的钟声，随后把湿透的名单压进怀里，继续往灯塔方向走。\n\n请你提供资料。\n`;
const clean = removeAssistantRefusalPollution(polluted);
assert.match(clean.content, /^林雾推开门/u);
assert.doesNotMatch(clean.content, /请你提供/u);
const sentenceResult = removeRepeatedSentences('林雾沿着旧码头走到尽头，听见铁链在水下碰撞，才停下脚步。\n\n潮水涨起来。林雾沿着旧码头走到尽头，听见铁链在水下碰撞，才停下脚步。\n');
assert.equal((sentenceResult.content.match(/听见铁链/gu) || []).length, 1);
assert.equal(sentenceResult.removed.length, 1);
console.log('exact-duplicate-cleanup: ok');
