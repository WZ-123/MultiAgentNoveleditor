export function appendToolUseMessage(messages, data, now = Date.now()) {
  const next = [...(messages || [])];
  const toolUseId = data?.id || null;
  if (toolUseId) {
    for (let index = next.length - 1; index >= 0; index -= 1) {
      if (next[index]?.role === 'tool' && next[index]?.toolUseId === toolUseId) {
        next[index] = {
          ...next[index],
          name: data?.name || next[index].name,
          input: data?.input !== undefined ? data.input : next[index].input,
          finalizedInput: data?.finalized === true || next[index].finalizedInput === true,
        };
        return next;
      }
    }
  }
  next.push({
    id: `tool-${toolUseId || now}`,
    toolUseId,
    role: 'tool',
    name: data?.name,
    input: data?.input,
    status: 'running',
    timestamp: now,
  });
  return next;
}

export function applyToolResultMessage(messages, data, now = Date.now()) {
  const next = [...(messages || [])];
  const targetToolUseId = data?.id || null;
  let updated = false;

  if (targetToolUseId) {
    for (let i = next.length - 1; i >= 0; i--) {
      if (next[i].role === 'tool' && next[i].toolUseId === targetToolUseId) {
        next[i] = {
          ...next[i],
          status: 'done',
          result: data?.text,
          isError: data?.isError,
          cached: data?.cached === true,
          cacheKey: data?.cacheKey || next[i].cacheKey || '',
          sourceRef: data?.sourceRef || next[i].sourceRef || '',
          modelContentTrimmed: data?.modelContentTrimmed === true,
          originalLength: Number(data?.originalLength) || 0,
          modelLength: Number(data?.modelLength) || 0,
        };
        updated = true;
        break;
      }
    }
  }

  if (!updated) {
    for (let i = next.length - 1; i >= 0; i--) {
      if (next[i].role === 'tool' && next[i].status === 'running') {
        next[i] = {
          ...next[i],
          status: 'done',
          result: data?.text,
          isError: data?.isError,
          cached: data?.cached === true,
          cacheKey: data?.cacheKey || next[i].cacheKey || '',
          sourceRef: data?.sourceRef || next[i].sourceRef || '',
          modelContentTrimmed: data?.modelContentTrimmed === true,
          originalLength: Number(data?.originalLength) || 0,
          modelLength: Number(data?.modelLength) || 0,
        };
        updated = true;
        break;
      }
    }
  }

  if (!updated) {
    next.push({
      id: `tool-${now}`,
      toolUseId: targetToolUseId,
      role: 'tool',
      name: data?.name,
      input: data?.input,
      status: 'done',
      result: data?.text,
      isError: data?.isError,
      cached: data?.cached === true,
      cacheKey: data?.cacheKey || '',
      sourceRef: data?.sourceRef || '',
      modelContentTrimmed: data?.modelContentTrimmed === true,
      originalLength: Number(data?.originalLength) || 0,
      modelLength: Number(data?.modelLength) || 0,
      timestamp: now,
    });
  }

  return next;
}

export function isToolMessageCoveredByExecutionTrace(messages, toolMessage, liveTrace = null) {
  const toolUseId = toolMessage?.toolUseId;
  if (!toolUseId) return false;

  const traceIncludesTool = (trace) => Array.isArray(trace?.tools)
    && trace.tools.some((tool) => tool?.id === toolUseId);

  if (traceIncludesTool(liveTrace)) return true;

  const timeline = Array.isArray(messages) ? messages : [];
  const toolIndex = timeline.indexOf(toolMessage);
  if (toolIndex < 0) return false;

  for (let cursor = toolIndex - 1; cursor >= 0; cursor -= 1) {
    const message = timeline[cursor];
    if (message?.role === 'user') break;
    if (message?.role === 'assistant' && traceIncludesTool(message.executionTrace)) return true;
  }

  for (let cursor = toolIndex + 1; cursor < timeline.length; cursor += 1) {
    const message = timeline[cursor];
    if (message?.role === 'user') break;
    if (message?.role === 'assistant' && traceIncludesTool(message.executionTrace)) return true;
  }

  return false;
}
