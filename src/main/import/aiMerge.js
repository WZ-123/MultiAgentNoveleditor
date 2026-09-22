'use strict';

/**
 * AI Merge — calls the sa-import-merge subagent to produce a merged version
 * of two conflicting content versions.
 */

const { getCodexSessionService } = require('../codex-runtime');

/**
 * @param {string} leftContent  - imported version
 * @param {string} rightContent - existing novel version
 * @param {string} conflictType - 'character' | 'world' | 'outline' | 'style'
 * @param {string} userNote     - user instructions for the merge
 * @returns {string} merged content
 */
async function aiMerge(leftContent, rightContent, conflictType, userNote) {
  const input = [
    {
      role: 'user',
      content: [{
        type: 'text',
        text: [
          `冲突类型: ${conflictType}`,
          userNote ? `用户批注: ${userNote}` : '',
          '',
          '--- 导入版本 (Left) ---',
          leftContent || '(空)',
          '',
          '--- 现有版本 (Right) ---',
          rightContent || '(空)',
          '',
          '请输出合并后的完整内容，不要额外说明文字。',
        ].filter(Boolean).join('\n'),
      }],
    },
  ];

  const result = await getCodexSessionService().runOneShot({
    text: input[0].content[0].text,
    skillName: 'mana-import-enrichment',
  });

  return result?.text || leftContent || rightContent || '';
}

module.exports = { aiMerge };
