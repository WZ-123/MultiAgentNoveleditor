'use strict';

/**
 * File Parser — parse external novel files (.md, .txt, .epub) into chapters.
 *
 * Chapter detection confidence levels:
 *   HIGH (split)   — 2+ `# ` headings OR 2+ chapter patterns on different lines
 *   MEDIUM (split) — 1 `# ` heading + 1+ chapter patterns
 *   LOW (no split) — only 1 marker found, or just pattern matches on adjacent lines
 *   NONE (no split)— no markers at all
 *
 * When confidence is LOW or NONE, the entire file is returned as a single chapter.
 * NO arbitrary chunk splitting — if we can't identify chapters, we don't pretend.
 */

const fs = require('node:fs').promises;
const path = require('node:path');
const chatboxParser = require('./chatboxParser');
const chatboxDraftExtractor = require('./chatboxDraftExtractor');

const CHAPTER_PATTERNS = [
  /^第[一二三四五六七八九十百千万零\d]+章/,
  /^第[一二三四五六七八九十百千万零\d]+话/,
  /^第[一二三四五六七八九十百千万零\d]+节/,
  /^Chapter\s+\d+/i,
  /^Chapter\s+[IVXLCDM]+/i,
  /^Chapitre\s+\d+/i,
  /^Kapitel\s+\d+/i,
  /^Глава\s+\d+/i,
  /^Episode\s+\w+/i,
  /^Part\s+\d+/i,
  /^Part\s+\w+/i,
  /^Act\s+\d+/i,
  /^Scene\s+\d+/i,
  /^Book\s+\w+/i,
  /^Volume\s+\w+/i,
  /^Section\s+\d+/i,
  /^第\s*[一二三四五六七八九十\d]+\s*卷/,
  /^卷\s*[一二三四五六七八九十\d]/,
  /^序章/,
  /^终章/,
  /^尾声/,
  /^楔子/,
  /^幕\s*[一二三四五六七八九十\d]/,
];

function isChapterStart(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.length > 120) return false;
  for (const re of CHAPTER_PATTERNS) {
    if (re.test(trimmed)) return true;
  }
  if (/^[A-Z][A-Z\s]+\d*\s*$/.test(trimmed) && trimmed.length > 3 && trimmed.length < 80) return true;
  if (/^[IVXLCDM]+\.$/.test(trimmed) && trimmed.length > 1) return true;
  return false;
}

/**
 * Split text into chapters, but only when we can identify boundaries confidently.
 * Returns [{ title, content, confident }] where confident=false → UI shows warning.
 */
function splitIntoChapters(text) {
  const lines = text.split('\n');
  const headings = [];    // `# ` markers
  const patterns = [];    // chapter keyword markers

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const hMatch = line.match(/^#\s+(.+)$/);
    if (hMatch) {
      headings.push({ title: hMatch[1].trim(), startLine: i });
      continue;
    }
    if (isChapterStart(line)) {
      patterns.push({ title: line.trim(), startLine: i });
    }
  }

  // Decide whether to split based on confidence
  const splitSources = [];

  // Priority 1: `# ` headings (strongest signal)
  if (headings.length >= 2) {
    splitSources.push(...headings);
  }
  // Priority 2: chapter patterns on >= 2 non-adjacent lines
  else if (patterns.length >= 2) {
    // Two patterns with at least 1 line of content between them = confident
    const spaced = [];
    for (let i = 0; i < patterns.length; i++) {
      const next = patterns[i + 1];
      if (!next || (next.startLine - patterns[i].startLine) >= 2) {
        spaced.push(patterns[i]);
      }
    }
    if (spaced.length >= 2) {
      splitSources.push(...patterns);
    } else if (headings.length === 1) {
      // 1 heading + 1 pattern = medium confidence
      splitSources.push(...headings, ...patterns);
    } else {
      // Not confident — return as single chapter
      return [{ title: '', content: text.trim(), confident: false }];
    }
  }
  // Priority 3: multiple markers, but are any of them spaced?
  else if (headings.length + patterns.length >= 2) {
    // Only split if not ALL patterns are adjacent (consecutive lines are likely a list, not chapters)
    const allAdjacent = patterns.length >= 2 && patterns.every((p, i) => {
      if (i === 0) return true;
      return p.startLine - patterns[i - 1].startLine < 2;
    });
    if (headings.length > 0 || !allAdjacent) {
      splitSources.push(...headings, ...patterns);
    } else {
      return [{ title: '', content: text.trim(), confident: false }];
    }
  }
  // Priority 4: a single marker = low confidence, split anyway
  else if (headings.length === 1 || patterns.length === 1) {
    splitSources.push(...headings, ...patterns);
  }
  // No markers at all — single chapter
  else {
    return [{ title: '', content: text.trim(), confident: false }];
  }

  // Sort split sources by line
  splitSources.sort((a, b) => a.startLine - b.startLine);

  const chapters = [];
  for (let i = 0; i < splitSources.length; i++) {
    const c = splitSources[i];
    const nextLine = i + 1 < splitSources.length ? splitSources[i + 1].startLine : lines.length;
    const contentLines = lines.slice(c.startLine + 1, nextLine);
    chapters.push({ title: c.title, content: contentLines.join('\n').trim(), confident: true });
  }

  return chapters;
}

// ---------- EPUB parser ----------

async function parseEpub(filePath) {
  const Epub = require('epub');
  return new Promise((resolve, reject) => {
    const epub = new Epub(filePath);
    const chapters = [];

    epub.on('end', () => {
      const items = epub.flow || [];
      let pending = items.length;
      if (pending === 0) {
        resolve({ chapters, metadata: { title: epub.metadata?.title, author: epub.metadata?.creator } });
        return;
      }

      for (const item of items) {
        epub.getChapter(item.id, (err, text) => {
          if (!err && text) {
            const plain = text
              .replace(/<[^>]+>/g, '')
              .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
              .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
              .replace(/\s+/g, ' ').trim();
            if (plain.length > 50) {
              chapters.push({
                title: item.title || `章节 ${chapters.length + 1}`,
                content: plain,
              });
            }
          }
          pending--;
          if (pending === 0) {
            resolve({
              chapters,
              metadata: { title: epub.metadata?.title, author: epub.metadata?.creator },
            });
          }
        });
      }
    });

    epub.on('error', reject);
    epub.parse();
  });
}

// ---------- Public API ----------

async function parseNovelFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.epub') return parseEpub(filePath);

  const text = await fs.readFile(filePath, 'utf8');
  if ((ext === '.html' || ext === '.htm') && chatboxParser.isLikelyChatboxHtml(text)) {
    const transcript = chatboxParser.parseChatboxHtml(text);
    if (!transcript.messages.some((msg) => msg.role === 'assistant')) {
      throw new Error('Chatbox HTML 中没有可整理的 assistant 回复');
    }
    const extracted = await chatboxDraftExtractor.extractFinalDraftFromChatbox(transcript);
    const analysisHints = chatboxParser.buildAnalysisHints(transcript);
    return {
      chapters: extracted.chapters,
      metadata: {
        title: extracted.title || transcript.title || transcript.sessionTitles?.[0] || path.basename(filePath, ext),
        analysisHints,
        importMeta: {
          sourceType: transcript.sourceType,
          messageCount: transcript.messages.length,
          sessionTitles: transcript.sessionTitles,
          extractedAt: new Date().toISOString(),
          notes: extracted.notes || '',
          analysisHintChars: analysisHints.length,
        },
      },
    };
  }

  const chapters = splitIntoChapters(text);
  return { chapters, metadata: {} };
}

async function parseNovelFiles(filePaths) {
  const allChapters = [];
  let metadata = {};
  const mergedImportMeta = {};
  const sorted = [...filePaths].sort((a, b) => a.localeCompare(b));

  for (const fp of sorted) {
    const result = await parseNovelFile(fp);
    if (result.metadata?.title && !metadata.title) metadata = result.metadata;
    if (result.metadata?.analysisHints) {
      metadata.analysisHints = [metadata.analysisHints, result.metadata.analysisHints].filter(Boolean).join('\n\n---\n\n');
    }
    if (result.metadata?.importMeta) {
      mergedImportMeta.sourceType = mergedImportMeta.sourceType || result.metadata.importMeta.sourceType;
      mergedImportMeta.messageCount = (mergedImportMeta.messageCount || 0) + (result.metadata.importMeta.messageCount || 0);
      mergedImportMeta.extractedAt = mergedImportMeta.extractedAt || result.metadata.importMeta.extractedAt;
      mergedImportMeta.notes = [mergedImportMeta.notes, result.metadata.importMeta.notes].filter(Boolean).join('\n');
      mergedImportMeta.sessionTitles = [
        ...(mergedImportMeta.sessionTitles || []),
        ...(result.metadata.importMeta.sessionTitles || []),
      ];
    }
    allChapters.push(...result.chapters);
  }

  if (mergedImportMeta.sourceType) metadata.importMeta = mergedImportMeta;
  return { chapters: allChapters, metadata };
}

module.exports = { parseNovelFile, parseNovelFiles, splitIntoChapters };
