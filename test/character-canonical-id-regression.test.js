'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

async function runCharacterCanonicalIdRegressionTest() {
  const ROOT = path.resolve(__dirname, '..');
  const novelData = require(path.join(ROOT, 'src/main/store/novelData'));
  const { novelPaths } = require(path.join(ROOT, 'src/main/store/paths'));
  const results = { total: 0, passed: 0, failed: 0 };
  let novelDir = '';

  async function check(name, fn) {
    results.total += 1;
    try {
      await fn();
      results.passed += 1;
      console.log(`TEST_PASS ${name}`);
    } catch (error) {
      results.failed += 1;
      console.log(`TEST_FAIL ${name}: ${error?.stack || error}`);
    }
  }

  try {
    novelDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mana-character-canonical-id-'));
    const np = novelPaths(novelDir);
    await novelData.writeCharacter(novelDir, {
      id: 'shiratsuyu-rion',
      name: '调月莉音',
      originalName: '白露里音',
      aliases: ['莉音', '小调月'],
      role: '主角',
      personality: '谨慎。',
    });

    await check('CCID1_patch_by_name_preserves_canonical_id_and_file', async () => {
      const patched = await novelData.patchCharacter(novelDir, '调月莉音', {
        id: 'invented-name-derived-id',
        personality: '谨慎，但会主动核对证据。',
      });

      assert.equal(patched.id, 'shiratsuyu-rion');
      assert.equal(patched.personality, '谨慎，但会主动核对证据。');
      const files = (await fs.readdir(np.characters)).filter((file) => file.endsWith('.json')).sort();
      assert.deepEqual(files, ['shiratsuyu-rion.json']);
      await assert.rejects(fs.access(path.join(np.characters, '调月莉音.json')));
      await assert.rejects(fs.access(path.join(np.characters, 'invented-name-derived-id.json')));
    });

    await check('CCID2_patch_by_alias_reuses_same_canonical_record', async () => {
      const patched = await novelData.patchCharacter(novelDir, '莉音', {
        role: '视角主角',
      });

      assert.equal(patched.id, 'shiratsuyu-rion');
      assert.equal(patched.role, '视角主角');
      const listed = await novelData.listCharacters(novelDir);
      assert.equal(listed.length, 1);
      assert.equal(listed[0].id, 'shiratsuyu-rion');
      assert.equal((await novelData.readCharacter(novelDir, '莉音'))?.id, 'shiratsuyu-rion');
      assert.deepEqual(
        (await fs.readdir(np.characters)).filter((file) => file.endsWith('.json')).sort(),
        ['shiratsuyu-rion.json']
      );
    });

    await check('CCID3_name_and_alias_updates_do_not_duplicate_character_index', async () => {
      const index = await novelData.listCharacterIndex(novelDir);
      assert.equal(index.length, 1);
      assert.equal(index[0].id, 'shiratsuyu-rion');
      assert.equal(index[0].name, '调月莉音');
    });
  } catch (error) {
    results.total += 1;
    results.failed += 1;
    console.log(`TEST_FAIL CCID_harness: ${error?.stack || error}`);
  } finally {
    if (novelDir) await fs.rm(novelDir, { recursive: true, force: true }).catch(() => {});
  }

  console.log('');
  console.log(`TEST_SUMMARY ${results.passed}/${results.total} passed, ${results.failed} failed`);
  console.log('TEST_DONE');
  if (results.failed > 0) process.exitCode = 1;
  return results;
}

module.exports = { runCharacterCanonicalIdRegressionTest };

if (require.main === module) {
  runCharacterCanonicalIdRegressionTest().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
