'use strict';

const assert = require('node:assert/strict');
const { repairMaleThirdPerson } = require('../scripts/repair-narrative-pov');

const source = '她把我的册子收好。李雾没有回头。“我不会交出去，”她说。\n"我的名字不重要。"';
const repaired = repairMaleThirdPerson(source);
assert.equal(repaired, '他把他的册子收好。林雾没有回头。“我不会交出去，”他说。\n"我的名字不重要。"');
console.log('narrative-pov-cleanup: ok');
