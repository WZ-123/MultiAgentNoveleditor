'use strict';

const nodeGlobals = {
  AbortController: 'readonly',
  Blob: 'readonly',
  Buffer: 'readonly',
  DOMException: 'readonly',
  FormData: 'readonly',
  TextDecoder: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  __dirname: 'readonly',
  __filename: 'readonly',
  clearInterval: 'readonly',
  clearTimeout: 'readonly',
  console: 'readonly',
  fetch: 'readonly',
  global: 'readonly',
  module: 'readonly',
  process: 'readonly',
  queueMicrotask: 'readonly',
  require: 'readonly',
  setImmediate: 'readonly',
  setInterval: 'readonly',
  setTimeout: 'readonly',
  structuredClone: 'readonly',
};

module.exports = [
  {
    files: [
      'src/main/runtime/**/*.js',
      'src/main/harness-v3/**/*.js',
      'src/main/codex-runtime/**/*.js',
      'src/main/responses-gateway/**/*.js',
      'src/main/codex-mcp/**/*.js',
    ],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: nodeGlobals,
    },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    rules: { 'no-undef': 'error' },
  },
];
