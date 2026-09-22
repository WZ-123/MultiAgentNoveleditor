'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(process.argv[2] || 'artifacts/deepseek-max-100k-2026-09-05');
const metrics = JSON.parse(fs.readFileSync(path.join(root, 'analysis-metrics.json'), 'utf8'));
const contents = metrics.chapters.map(chapter => {
  const raw = fs.readFileSync(path.join(root, 'novel/chapters', chapter.file), 'utf8');
  if (crypto.createHash('sha256').update(raw).digest('hex') !== chapter.sha256) throw new Error(`Stale metrics: ${chapter.file}`);
  return raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/u, '').trim();
});
const name = '逆光档案-未完稿.md';
const manuscript = `# 逆光档案（未完稿）\n\n> 验证中断记录：真实 DeepSeek 接口返回 HTTP 402 Insufficient Balance。现有 ${metrics.chapters.length} 个章节文件，净正文 ${metrics.bodyCjk} 汉字，第 10 章尚未达到目标篇幅；十万字验证与全书验收均未完成。以下仅汇编模型已保存的原文，不含总纲、角色卡、推理或失败工作区草稿。\n\n${contents.join('\n\n---\n\n')}\n`;
fs.writeFileSync(path.join(root, name), manuscript);
fs.writeFileSync(path.join(root, 'manuscript-provenance.json'), JSON.stringify({
  generatedAt: new Date().toISOString(), status: 'incomplete-provider-insufficient-balance',
  artifact: name, targetBodyCjk: 100000, actualBodyCjk: metrics.bodyCjk,
  countDefinition: 'CJK U+3400–U+9FFF, excluding YAML frontmatter, Markdown headings and 时间/雨情 metadata lines',
  modelEfforts: metrics.modelEfforts, sources: metrics.chapters,
  sha256: crypto.createHash('sha256').update(manuscript).digest('hex'),
}, null, 2) + '\n');
console.log(JSON.stringify({ artifact: path.join(root, name), chapters: contents.length, bodyCjk: metrics.bodyCjk }));
