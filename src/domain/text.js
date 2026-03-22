/**
 * Split plain text into paragraph blocks (blank-line separated).
 * @param {string} text
 * @returns {import('./types.js').ParagraphRef[]}
 */
export function splitIntoParagraphs(text) {
  const raw = text.replace(/\r\n/g, '\n').trim();
  if (!raw) return [];
  const parts = raw.split(/\n\s*\n/);
  return parts.map((p, index) => ({
    id: `p-${index}`,
    index,
    text: p.trim(),
  }));
}

/**
 * Apply replacement for a single paragraph by id.
 * @param {import('./types.js').ParagraphRef[]} paragraphs
 * @param {string} paragraphId
 * @param {string} newText
 */
export function replaceParagraph(paragraphs, paragraphId, newText) {
  return paragraphs.map((p) =>
    p.id === paragraphId ? { ...p, text: newText } : p
  );
}

/**
 * Join paragraphs back to document text.
 * @param {import('./types.js').ParagraphRef[]} paragraphs
 */
export function joinParagraphs(paragraphs) {
  return paragraphs.map((p) => p.text).join('\n\n');
}
