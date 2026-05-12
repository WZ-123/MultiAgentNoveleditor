#!/usr/bin/env node
'use strict';

const fs = require('node:fs').promises;
const path = require('node:path');

const novelData = require('../src/main/store/novelData');
const { ensureNovelLayout } = require('../src/main/store/paths');

let total = 0;
let failed = 0;

function pass(name, detail) {
  total++;
  console.log(`TEST_PASS ${name}${detail ? ': ' + detail : ''}`);
}

function fail(name, reason) {
  total++;
  failed++;
  console.log(`TEST_FAIL ${name}: ${reason}`);
}

async function main() {
  const root = path.join(__dirname, '..', 'tmp-test-character-card-parsing');
  const novelDir = path.join(root, 'novel');
  await fs.rm(root, { recursive: true, force: true });
  ensureNovelLayout(novelDir);

  try {
    const legacyRaw = {
      schemaVersion: 1,
      id: 'char-mozhzdvn',
      __raw: JSON.stringify({
        id: 'wu-laogou',
        name: '吴老狗',
        role: '反派-厉鬼',
        aliases: ['仙公', '吴老狗', '老登'],
        attributes: {
          外貌: '右脸有烫伤疤，死后化为菌丝血肉鬼体',
          语言特点: '声音像老式收音机，夹杂乱码',
          死亡原因: '被困山庙溶洞一个月后饿死',
        },
        bio: '吴老狗误以为自己得道成仙，自称仙公。楚岚嘲讽他是老登。'
      }) + '}',
      aliases: ['吴老狗'],
      attributes: {
        自称: '仙公',
        现存形态: '寄居山庙菌丝体',
      },
      bio: '吴老狗被楚岚重创但未被彻底消灭。'
    };

    const normalizedLegacy = novelData.normalizeCharacter(legacyRaw);
    if (normalizedLegacy?.name === '吴老狗') {
      pass('legacy_name_from_raw', normalizedLegacy.name);
    } else {
      fail('legacy_name_from_raw', JSON.stringify(normalizedLegacy));
    }

    if (normalizedLegacy?.role === '反派-厉鬼') {
      pass('legacy_role_from_raw', normalizedLegacy.role);
    } else {
      fail('legacy_role_from_raw', JSON.stringify(normalizedLegacy));
    }

    if ((normalizedLegacy?.appearance || '').includes('烫伤疤')) {
      pass('legacy_appearance_from_attributes', normalizedLegacy.appearance);
    } else {
      fail('legacy_appearance_from_attributes', JSON.stringify(normalizedLegacy));
    }

    if ((normalizedLegacy?.personality || '').includes('老式收音机')) {
      pass('legacy_personality_from_attributes', normalizedLegacy.personality);
    } else {
      fail('legacy_personality_from_attributes', JSON.stringify(normalizedLegacy));
    }

    if ((normalizedLegacy?.background || '').includes('吴老狗')) {
      pass('legacy_background_from_bio', normalizedLegacy.background.slice(0, 40));
    } else {
      fail('legacy_background_from_bio', JSON.stringify(normalizedLegacy));
    }

    if ((normalizedLegacy?.quotes || '').includes('老登') || (normalizedLegacy?.quotes || '').includes('仙公')) {
      pass('legacy_quotes_from_bio', normalizedLegacy.quotes);
    } else {
      fail('legacy_quotes_from_bio', JSON.stringify(normalizedLegacy));
    }

    await novelData.writeCharacter(novelDir, legacyRaw);
    await novelData.writeCharacter(novelDir, {
      id: 'chu-lan',
      name: '楚岚',
      role: '主角',
      faction: '崂山道门',
      attributes: {
        年龄: '30岁左右',
        职业: '道士 / 前程序员',
        籍贯: '山东青岛',
      },
      bio: '楚岚失业后回家翻出道门典籍，自学驱鬼，还开直播。'
    });

    const listed = await novelData.listCharacters(novelDir);
    const wu = listed.find((item) => item.id === 'char-mozhzdvn');
    const chu = listed.find((item) => item.id === 'chu-lan');

    if (wu?.role === '反派-厉鬼' && (wu?.background || '').includes('吴老狗')) {
      pass('list_characters_projects_legacy_fields', `${wu.role} / ${wu.background.slice(0, 18)}`);
    } else {
      fail('list_characters_projects_legacy_fields', JSON.stringify(wu));
    }

    if ((chu?.appearance || '').includes('30岁左右') && (chu?.background || '').includes('开直播')) {
      pass('list_characters_projects_flat_fields', `${chu.appearance} / ${chu.background.slice(0, 18)}`);
    } else {
      fail('list_characters_projects_flat_fields', JSON.stringify(chu));
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }

  console.log('');
  console.log(`TEST_SUMMARY ${total - failed}/${total} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
