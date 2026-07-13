'use strict';

function safeString(value) {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  try { return JSON.stringify(value); } catch { return String(value); }
}

function serializeConversationForDriver(messages) {
  const lines = [];
  const bounded = (value, max = 4000) => {
    const source = safeString(value);
    return source.length > max ? `${source.slice(0, max)}\n[history block trimmed]` : source;
  };
  for (const message of Array.isArray(messages) ? messages : []) {
    const role = message?.role === 'user' ? 'User' : 'Assistant';
    const parts = [];
    for (const block of Array.isArray(message?.content) ? message.content : []) {
      if (block?.type === 'text' && block.text) parts.push(bounded(block.text, 8000));
      else if (block?.type === 'tool_use') parts.push(`[ToolCall ${block.name || 'unknown'}#${block.id || ''}] ${bounded(block.input, 2000)}`);
      else if (block?.type === 'tool_result') parts.push(`[ToolResult #${block.tool_use_id || ''}${block.is_error ? ' ERROR' : ''}] ${bounded(block.content, 4000)}`);
      else if (block?.type === 'redacted_thinking') parts.push('[Redacted model thinking omitted from driver history]');
    }
    if (parts.length) lines.push(`${role}: ${parts.join('\n')}`);
  }
  return lines.join('\n');
}

module.exports = { serializeConversationForDriver };
