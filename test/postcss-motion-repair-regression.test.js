'use strict';

const assert = require('node:assert/strict');
const postcss = require('postcss');
const repair = require('../scripts/postcss-fix-tailwind-nested-motion.cjs');

async function run() {
  const input = [
    '.thumb:after:is(){transition-property:none}',
    '@media (prefers-reduced-motion: reduce){.thumb:after:not(:is()){transition-property:none}}',
    '@media (width > 1px){.unrelated:not(:is()){color:red}}',
  ].join('');
  const result = await postcss([repair()]).process(input, { from: undefined });

  assert.doesNotMatch(result.css, /\.thumb:after:is\(\)/u);
  assert.match(result.css, /prefers-reduced-motion:\s*reduce\)\s*\{\.thumb:after\s*\{/u);
  assert.match(result.css, /\.unrelated:not\(:is\(\)\)/u, 'non-motion selectors must not be rewritten');
  process.stdout.write('POSTCSS_MOTION_REPAIR_REGRESSION_PASS\n');
}

run().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
