'use strict';

const DETECTOR_VERSION = 'de-ai-patterns-1.0.0';

const PATTERN_RULES = Object.freeze([
  {
    ruleId: 'not-but-contrast',
    sourceExampleRefs: ['src/main/store/skills.js#de-ai-ify-1-2', 'src/main/seeds/builtinSubagents.js#sa-de-ai-ifier'],
    expression: /不是[\s\S]{1,120}?(?:而是|更像是|反而是|反倒是|却是|只是)[\s\S]{1,80}?(?=[.!?\n]|$)/gu,
  },
  {
    ruleId: 'no-no-just',
    sourceExampleRefs: ['src/main/store/skills.js#de-ai-ify-2b', 'src/main/seeds/builtinSubagents.js#sa-de-ai-ifier'],
    expression: /没有[^.!?\n]{1,50},没有[^.!?\n]{1,50},?只是[^.!?\n]{1,80}/gu,
  },
  {
    ruleId: 'multi-negative-reveal',
    sourceExampleRefs: ['src/main/store/skills.js#de-ai-ify-2b', 'src/main/seeds/builtinSubagents.js#sa-prose-quality'],
    expression: /(?:不是[^.!?\n]{1,45},){2,}不是[^.!?\n]{1,45}[.]?\s*(?:那是|这是|他是|她是|是)[^.!?\n]{1,80}/gu,
  },
]);

module.exports = { DETECTOR_VERSION, PATTERN_RULES };
