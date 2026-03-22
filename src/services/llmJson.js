/**
 * 从模型返回文本中解析 JSON（兼容 markdown 代码块与前后废话）。
 * @param {string} text
 * @returns {unknown}
 */
export function parseJsonFromModelText(text) {
  const t = text.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)```\s*$/m.exec(t);
  const body = fence ? fence[1].trim() : t;
  try {
    return JSON.parse(body);
  } catch {
    const start = body.indexOf('{');
    const end = body.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return JSON.parse(body.slice(start, end + 1));
    }
    throw new Error('无法解析模型返回的 JSON');
  }
}
