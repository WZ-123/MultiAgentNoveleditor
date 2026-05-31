'use strict';

/**
 * Chatbox HTML export parser.
 *
 * The exported file is a static HTML transcript where every message appears as
 * a `.mb-4` block, with role labels such as `USER:` and body text under
 * `.break-words`. We keep this parser dependency-free because the app does not
 * currently ship an HTML DOM parser in the main process.
 */

function decodeHtmlEntities(text) {
  return String(text || '')
    .replace(/&#(\d+);/g, (_m, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function stripHtmlToText(html) {
  return decodeHtmlEntities(String(html || '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p\s*>/gi, '\n')
    .replace(/<\/div\s*>/gi, '\n')
    .replace(/<\/h[1-6]\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim());
}

function firstMatch(html, re) {
  const match = String(html || '').match(re);
  return match ? stripHtmlToText(match[1]) : '';
}

function parseChatboxHtml(html) {
  const source = String(html || '');
  const title = firstMatch(source, /<title\b[^>]*>([\s\S]*?)<\/title>/i);
  const sessionTitles = [];
  const messages = [];
  const sections = [];
  let currentSection = null;
  const itemRe = /<h2\b[^>]*>([\s\S]*?)<\/h2>|<div\s+class=["'][^"']*\bmb-4\b[^"']*["'][^>]*>([\s\S]*?)(?=<h2\b|<div\s+class=["'][^"']*\bmb-4\b|<hr\s*\/?>\s*<\/div>|<\/body>)/gi;
  let itemMatch;
  while ((itemMatch = itemRe.exec(source))) {
    if (itemMatch[1] != null) {
      const sectionTitle = stripHtmlToText(itemMatch[1]);
      if (!sectionTitle) continue;
      sessionTitles.push(sectionTitle);
      currentSection = { title: sectionTitle, messages: [] };
      sections.push(currentSection);
      continue;
    }

    const block = itemMatch[2] || '';
    const roleMatch = block.match(/<b>\s*(SYSTEM|USER|ASSISTANT)\s*:\s*<\/b>/i);
    if (!roleMatch) continue;

    const bodyMatch = block.match(/<div\s+class=["'][^"']*\bbreak-words\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
    const content = stripHtmlToText(bodyMatch ? bodyMatch[1] : block);
    if (!content) continue;

    if (!currentSection) {
      currentSection = { title: '', messages: [] };
      sections.push(currentSection);
    }

    const message = {
      role: roleMatch[1].toLowerCase(),
      content,
      sectionTitle: currentSection.title || '',
    };
    messages.push(message);
    currentSection.messages.push(message);
  }

  return {
    title,
    sessionTitles,
    sections,
    messages,
    sourceType: 'chatbox-html',
  };
}

function isLikelyChatboxHtml(html) {
  const source = String(html || '');
  if (!/<html\b/i.test(source)) return false;
  if (/chatboxai\.app/i.test(source) && /<b>\s*(?:USER|ASSISTANT)\s*:\s*<\/b>/i.test(source)) return true;
  return /<div\s+class=["'][^"']*\bmb-4\b/i.test(source)
    && /<b>\s*USER\s*:\s*<\/b>/i.test(source)
    && /<b>\s*ASSISTANT\s*:\s*<\/b>/i.test(source);
}

function buildAnalysisHints(transcript, maxChars = 30000) {
  const lines = [];
  if (transcript?.title) lines.push(`# ${transcript.title}`);
  const sectionTitles = (transcript?.sessionTitles || []).filter(Boolean);
  if (sectionTitles.length > 0) {
    lines.push(`\n## 对话分段标题\n${sectionTitles.map((title) => `- ${title}`).join('\n')}`);
  }
  lines.push('\n## 用户提供的设定、大纲和修改意见');
  for (const message of transcript?.messages || []) {
    if (message.role !== 'user') continue;
    const content = String(message.content || '').trim();
    if (!content) continue;
    lines.push(`\n### ${message.sectionTitle || '未分段'}\n${content}`);
    if (lines.join('\n').length > maxChars) break;
  }
  return lines.join('\n').slice(0, maxChars).trim();
}

module.exports = {
  decodeHtmlEntities,
  stripHtmlToText,
  parseChatboxHtml,
  isLikelyChatboxHtml,
  buildAnalysisHints,
};
