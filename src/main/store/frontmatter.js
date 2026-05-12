'use strict';

/**
 * Frontmatter utilities: parse, serialize, and read from file (partial read).
 *
 * Format:
 *   ---
 *   title: 苟利国家生死以
 *   volume: 1
 *   section: 1
 *   ---
 *
 *   # 苟利国家生死以
 *   body...
 */

const fs = require('node:fs');
const fsp = require('node:fs').promises;

const FM_RE = /^---\n([\s\S]*?)\n---\n*/;

/**
 * Parse YAML-like frontmatter from a string.
 * Supports simple key: value (no nesting, no arrays).
 * @param {string} text
 * @returns {{ metadata: object|null, body: string }}
 */
function parseFrontmatter(text) {
  const m = FM_RE.exec(text);
  if (!m) return { metadata: null, body: text };

  const raw = m[1];
  const metadata = {};
  for (const line of raw.split('\n')) {
    const kv = line.match(/^\s*(\w+)\s*:\s*(.*?)\s*$/);
    if (kv) {
      let val = kv[2].trim();
      // Try numeric
      if (/^\d+$/.test(val)) metadata[kv[1]] = Number(val);
      else metadata[kv[1]] = val;
    }
  }
  const body = text.slice(m[0].length);
  return { metadata, body };
}

/**
 * Serialize metadata into frontmatter string.
 * @param {object} metadata
 * @param {string} body
 * @returns {string}
 */
function serializeFrontmatter(metadata, body) {
  if (!metadata || Object.keys(metadata).length === 0) return body;
  const lines = ['---'];
  for (const [k, v] of Object.entries(metadata)) {
    if (v != null) lines.push(`${k}: ${v}`);
  }
  lines.push('---');
  let fm = lines.join('\n') + '\n';
  // Ensure exactly one blank line between frontmatter and body
  if (body && !body.startsWith('\n')) fm += '\n';
  return fm + (body || '');
}

/**
 * Read only the frontmatter from a file (reads first 2KB).
 * Returns null if file doesn't exist or has no frontmatter.
 * @param {string} filePath
 * @returns {{ metadata: object|null, bodyStart: number }|null}
 */
function readFrontmatterFromFileSync(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(2048);
    const bytesRead = fs.readSync(fd, buf, 0, 2048, 0);
    fs.closeSync(fd);
    const head = buf.toString('utf8', 0, bytesRead);
    const result = parseFrontmatter(head);
    if (!result.metadata) return null;
    // bodyStart = length of the frontmatter block (including ---\n)
    const m = FM_RE.exec(head);
    const bodyStart = m ? m[0].length : 0;
    return { metadata: result.metadata, bodyStart };
  } catch {
    return null;
  }
}

/**
 * Async version: read frontmatter from file.
 * @param {string} filePath
 * @returns {Promise<{metadata: object|null, bodyStart: number}|null>}
 */
async function readFrontmatterFromFile(filePath) {
  try {
    const fd = await fsp.open(filePath, 'r');
    const buf = Buffer.alloc(2048);
    const { bytesRead } = await fd.read(buf, 0, 2048, 0);
    await fd.close();
    const head = buf.toString('utf8', 0, bytesRead);
    const result = parseFrontmatter(head);
    if (!result.metadata) return null;
    const m = FM_RE.exec(head);
    const bodyStart = m ? m[0].length : 0;
    return { metadata: result.metadata, bodyStart };
  } catch {
    return null;
  }
}

/**
 * Compute the next available insertion filename between two existing files.
 * Example: between "chapter-001.md" and "chapter-002.md" → "chapter-001a.md"
 *          between "chapter-001a.md" and "chapter-002.md" → "chapter-001b.md"
 * @param {string[]} existingFiles - sorted list of filenames
 * @param {number} insertAfterIndex - index in the sorted list to insert after
 * @returns {string}
 */
function computeNextInsertName(existingFiles, insertAfterIndex) {
  const sorted = [...existingFiles].sort((a, b) => a.localeCompare(b));
  const after = sorted[insertAfterIndex] || sorted[sorted.length - 1] || 'chapter-000.md';
  const base = after.replace(/\.md$/i, '');
  const existingSet = new Set(sorted);

  // Try single letter a-z, then double aa, ab, ...
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  for (const ch of letters) {
    const candidate = `${base}${ch}.md`;
    if (!existingSet.has(candidate)) return candidate;
  }
  // Double letters
  for (const a of letters) {
    for (const b of letters) {
      const candidate = `${base}${a}${b}.md`;
      if (!existingSet.has(candidate)) return candidate;
    }
  }
  // Fallback: timestamp
  return `${base}-${Date.now().toString(36)}.md`;
}

module.exports = {
  parseFrontmatter,
  serializeFrontmatter,
  readFrontmatterFromFile,
  readFrontmatterFromFileSync,
  computeNextInsertName,
};
