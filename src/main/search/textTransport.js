'use strict';

function safeString(value) {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

function fitTextForModel(value, options = {}) {
  const text = safeString(value);
  const maxChars = Math.max(256, Number(options.maxChars) || 12000);
  if (text.length <= maxChars) return { text, wasTrimmed: false, originalLength: text.length, modelLength: text.length };
  const head = Math.floor(maxChars * 0.7);
  const tail = Math.max(0, maxChars - head - 80);
  const output = `${text.slice(0, head)}\n[传输分页截断；请按资源游标继续读取]\n${text.slice(-tail)}`;
  return { text: output, wasTrimmed: true, originalLength: text.length, modelLength: output.length };
}

module.exports = { fitTextForModel, safeString };
