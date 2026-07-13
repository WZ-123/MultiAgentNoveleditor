'use strict';

/**
 * Parse JSON returned by an LLM without letting common formatting mistakes
 * abort the whole writing flow. The repair pass is deliberately conservative:
 * it only fixes syntax that is unambiguous in an object/array payload.
 */

function stripJsonEnvelope(text) {
  const raw = String(text || '').trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)```\s*$/iu.exec(raw);
  return (fence ? fence[1] : raw).trim();
}

function extractJsonCandidate(text) {
  const start = [...text].findIndex((char) => char === '{' || char === '[');
  if (start < 0) return text;

  const source = text.slice(start);
  const stack = [];
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{' || char === '[') stack.push(char);
    if (char === '}' || char === ']') {
      const expected = char === '}' ? '{' : '[';
      if (stack[stack.length - 1] !== expected) continue;
      stack.pop();
      if (!stack.length) return source.slice(0, index + 1);
    }
  }
  return source;
}

function repairJsonSyntax(text) {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        out += char;
        escaped = false;
        continue;
      }
      if (char === '\\') {
        out += char;
        escaped = true;
        continue;
      }
      if (char === '"') {
        const next = text.slice(index + 1).match(/^\s*(?:[:,}\]]|"[^"\n]+"\s*:)/u);
        if (next) {
          out += char;
          inString = false;
        } else {
          // A quote inside model-written prose is usually missing its escape.
          out += '\\"';
        }
        continue;
      }
      if (char === '\n') {
        out += '\\n';
        continue;
      }
      if (char === '\r') {
        out += '\\r';
        continue;
      }
      if (char === '\t') {
        out += '\\t';
        continue;
      }
      if (char.charCodeAt(0) < 0x20) {
        out += `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`;
        continue;
      }
      out += char;
      continue;
    }

    if (char === '"') {
      inString = true;
      out += char;
    } else {
      out += char;
    }
  }

  // LLMs frequently leave a trailing comma or omit the comma before the next
  // object property. Both repairs are safe because they only match structural
  // delimiters followed by a JSON property name.
  return out
    .replace(/,\s*([}\]])/gu, '$1')
    .replace(/([}\]])\s*(?="[^"\n]+"\s*:)/gu, '$1,')
    .replace(/("(?:\\.|[^"\\])*"|true|false|null|-?\d+(?:\.\d+)?)\s+(?="[^"\n]+"\s*:)/gu, '$1,');
}

function parseJsonText(text) {
  return parseJsonTextWithMeta(text).value;
}

function parseJsonTextWithMeta(text) {
  const body = stripJsonEnvelope(text);
  if (!body) throw new Error('模型未返回 JSON 内容');

  try {
    return { value: JSON.parse(body), repaired: false };
  } catch (firstError) {
    const candidate = extractJsonCandidate(body);
    try {
      return { value: JSON.parse(candidate), repaired: candidate !== body };
    } catch {
      try {
        return { value: JSON.parse(repairJsonSyntax(candidate)), repaired: true };
      } catch {
        const error = new Error('模型返回的 JSON 格式不完整，已无法安全修复');
        error.cause = firstError;
        throw error;
      }
    }
  }
}

module.exports = {
  parseJsonText,
  parseJsonTextWithMeta,
  _test: { extractJsonCandidate, repairJsonSyntax, stripJsonEnvelope },
};
