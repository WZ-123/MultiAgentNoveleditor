export function appendToolUseMessage(messages, data, now = Date.now()) {
  const next = [...(messages || [])];
  next.push({
    id: `tool-${now}`,
    toolUseId: data?.id || null,
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
      timestamp: now,
    });
  }

  return next;
}