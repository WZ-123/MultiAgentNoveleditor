'use strict';

const mode = process.argv[2] || 'pass';
if (mode === 'pass') {
  console.log('TEST_PASS fixture-pass');
  console.error('fixture stderr captured');
  console.log('TEST_DONE');
} else if (mode === 'fail-marker') {
  console.log('TEST_FAIL fixture-failure: synthetic assertion');
  console.log('TEST_DONE');
} else if (mode === 'no-terminal') {
  console.log('TEST_PASS fixture-no-terminal');
} else if (mode === 'hang') {
  setInterval(() => {}, 1_000);
}
