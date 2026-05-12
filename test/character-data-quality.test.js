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
  const root = path.join(__dirname, '..', 'tmp-test-character-quality');
  const novelDir = path.join(root, 'novel');

  await fs.rm(root, { recursive: true, force: true });
  ensureNovelLayout(novelDir);

  try {
    const normalized = novelData.normalizeCharacter({ id: 'char-mozhzdvn', role: '主角' });
    if (normalized?.name === '未命名角色') {
      pass('normalize_generated_id_fallback', normalized.name);
    } else {
      fail('normalize_generated_id_fallback', JSON.stringify(normalized));
    }

    const fromOriginal = novelData.normalizeCharacter({ id: 'char-saber', originalName: '阿尔托莉雅' });
    if (fromOriginal?.name === '阿尔托莉雅') {
      pass('normalize_original_name', fromOriginal.name);
    } else {
      fail('normalize_original_name', JSON.stringify(fromOriginal));
    }

    await novelData.writeCharacter(novelDir, { id: 'char-mozhzdvn', role: '主角' });
    await novelData.writeCharacter(novelDir, { id: '楚岚', role: '主角' });

    const list = await novelData.listCharacters(novelDir);
    const broken = list.find((item) => item.id === 'char-mozhzdvn');
    const named = list.find((item) => item.id === '楚岚');

    if (broken?.name === '未命名角色') {
      pass('list_characters_masks_generated_id', broken.name);
    } else {
      fail('list_characters_masks_generated_id', JSON.stringify(broken));
    }

    if (named?.name === '楚岚') {
      pass('list_characters_uses_human_id_as_name', named.name);
    } else {
      fail('list_characters_uses_human_id_as_name', JSON.stringify(named));
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
