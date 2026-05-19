'use strict';

function getActiveNovelContext(mcpClient) {
  let ctx = null;
  try {
    ctx = mcpClient?.getActiveNovelContext?.() || null;
  } catch {
    return undefined;
  }
  if (!ctx || (!ctx.id && !ctx.dir)) return undefined;
  return {
    novelId: ctx.id || null,
    novelDir: ctx.dir || null,
  };
}

function withActiveNovelContext(payload = {}, mcpClient) {
  if (payload?.novelContext && (payload.novelContext.novelId || payload.novelContext.novelDir)) {
    return payload;
  }
  const novelContext = getActiveNovelContext(mcpClient);
  return novelContext ? { ...payload, novelContext } : payload;
}

module.exports = {
  getActiveNovelContext,
  withActiveNovelContext,
};