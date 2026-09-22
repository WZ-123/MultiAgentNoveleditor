'use strict';

const { CodexSessionService } = require('./codexSessionService');

let singleton = null;

function getCodexSessionService() {
  if (!singleton) singleton = new CodexSessionService();
  return singleton;
}

async function disposeCodexSessionService() {
  const current = singleton;
  singleton = null;
  await current?.dispose();
}

module.exports = { disposeCodexSessionService, getCodexSessionService };
