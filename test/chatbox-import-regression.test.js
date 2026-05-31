#!/usr/bin/env node
'use strict';

const fs = require('node:fs').promises;
const path = require('node:path');

let total = 0;
let failed = 0;

function pass(message) {
  total++;
  console.log('  PASS', message);
}

function fail(message, detail) {
  total++;
  failed++;
  console.log('  FAIL', message, detail || '');
}

const ROOT = path.join(__dirname, '..');
const TMP = path.join(ROOT, 'tmp-test-chatbox-import');
process.env.MANA_USER_DATA_ROOT = TMP;
let mockScenario = 'normal';
let mockCalls = [];
let mockActiveCalls = 0;
let mockMaxActiveCalls = 0;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const HTML = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>galgame创作辅助</title></head>
<body>
<div class="prose-sm">
<h2>1. 轻小说委托</h2>
<div class="mb-4"><p><b>SYSTEM: </b></p><div class="break-words "><p>You are helpful.</p></div></div>
<div class="mb-4"><p><b>USER: </b></p><div class="break-words "><p>人设：主角叫家豪。</p></div></div>
<div class="mb-4"><p><b>ASSISTANT: </b></p><div class="break-words "><p>好的，请提供大纲。</p></div></div>
<div class="mb-4"><p><b>USER: </b></p><div class="break-words "><p>第一章的大纲是：家豪发现人机大姐姐。</p></div></div>
<div class="mb-4"><p><b>ASSISTANT: </b></p><div class="break-words "><p>“你等一下，”家豪说道，“我可能……找到和你‘对话’的方法了。”</p></div></div>
<div class="mb-4"><p><b>USER: </b></p><div class="break-words "><p>把“对话的方法”这句话换掉，本来就可以语言对话，家豪只是在找帮她摘下显示器头套的方法</p></div></div>
<div class="mb-4"><p><b>ASSISTANT: </b></p><div class="break-words "><p>“你等一下，”他对依旧安静趴着的“人机姐姐”说道，声音里带着一丝不确定的兴奋，“我可能……找到帮你取下这个头套的方法了。”</p><p>屏幕显示：╮(￣▽￣&quot;&quot;)╭</p></div></div>
<hr /></div>
</body>
</html>`;

async function setupMockProvider() {
  const providerManager = require('../src/main/providerManager');
  const modelAliases = require('../src/main/modelAliases');
  providerManager.getActiveProvider = async () => ({
    type: 'anthropic',
    apiKey: 'mock-key',
    models: [{ id: 'mock-model' }],
  });
  providerManager.getProvider = async () => providerManager.getActiveProvider();
  modelAliases.getAlias = async () => ({ providerId: null, modelId: 'mock-model' });

  const anthropicPath = require.resolve('../src/main/runtime/providers/anthropic');
  require.cache[anthropicPath] = {
    id: anthropicPath,
    filename: anthropicPath,
    loaded: true,
    exports: {
      async sendMessage({ messages }) {
        const prompt = messages?.[0]?.content?.[0]?.text || '';
        mockCalls.push(prompt);
        if (mockScenario === 'repair-once') {
          if (prompt.includes('不是合法 JSON')) {
            return {
              content: [{ type: 'text', text: '```json\n{"title":"修复测试","chapters":[{"title":"第一章","content":"修复后的正文。"}],"notes":"已修复"}' }],
            };
          }
          return {
            content: [{ type: 'text', text: '{"title": "修复测试", "chapters": [ {"title": "第一章", "content": "坏 JSON"' }],
          };
        }
        if (mockScenario === 'unrepairable-batch') {
          return {
            content: [{ type: 'text', text: prompt.includes('不是合法 JSON') ? 'still not json' : '{"title": "坏批次", "chapters": [' }],
          };
        }
        if (mockScenario === 'unrepairable-long-batch') {
          if (prompt.includes('不是合法 JSON')) {
            return { content: [{ type: 'text', text: 'still not json' }] };
          }
          if (prompt.includes('坏批次甲')) {
            return { content: [{ type: 'text', text: '{"title":"多批次坏 JSON","chapters":[],"notes":""}' }] };
          }
          return { content: [{ type: 'text', text: '{"title": "多批次坏 JSON", "chapters": [' }] };
        }
        if (mockScenario === 'real-sample-mixed-json' && prompt.includes('森林大美食家')) {
          const titleMatch = prompt.match(/当前片段标题：([^\n]+)/);
          const title = titleMatch?.[1]?.trim() || '森林大美食家';
          const count = mockCalls.filter((p) => p.includes('森林大美食家') && !p.includes('不是合法 JSON')).length;
          const variants = [
            `当然，以下是整理结果：\n{\n  title: '森林大美食家',\n  chapters: [{ title: '${title}', content: '第${count}段最终正文。', }],\n  notes: '',\n}`,
            `\`\`\`json\n{"title":"森林大美食家","chapters":[{"title":"${title}","content":"第${count}段第一行\n第${count}段第二行"}],"notes":""}\n\`\`\``,
            `{"title":"森林大美食家","chapters":[{"title":"${title}","content":"第${count}段最终正文。",}],"notes":"",}`,
          ];
          return {
            content: [{ type: 'text', text: variants[count % variants.length] }],
          };
        }
        if (mockScenario === 'concurrency-order') {
          mockActiveCalls++;
          mockMaxActiveCalls = Math.max(mockMaxActiveCalls, mockActiveCalls);
          try {
            const titleMatch = prompt.match(/当前片段标题：([^\n]+)/);
            const title = titleMatch?.[1]?.trim() || '并发片段';
            const delayMs = title.includes('一') ? 80 : title.includes('二') ? 20 : 50;
            await delay(delayMs);
            return {
              content: [{ type: 'text', text: JSON.stringify({
                title: '并发顺序测试',
                chapters: [{ title, content: `${title}正文` }],
                notes: title,
              }) }],
            };
          } finally {
            mockActiveCalls--;
          }
        }
        if (mockScenario === 'empty-batch-object') {
          if (prompt.includes('空批次一')) {
            return {
              content: [{ type: 'text', text: JSON.stringify({
                title: '空批次容错',
                chapters: [{ title: '空批次一', content: '' }],
                notes: '无正文',
              }) }],
            };
          }
          return {
            content: [{ type: 'text', text: JSON.stringify({
              title: '空批次容错',
              chapters: [{ title: '有效批次二', content: '有效正文。' }],
              notes: '',
            }) }],
          };
        }
        if (prompt.includes('长篇片段一')) {
          return {
            content: [{ type: 'text', text: JSON.stringify({
              title: '正经小说',
              chapters: [{ title: '从 Chatbox 整理的正文', content: '第一段最终正文。' }],
              notes: '',
            }) }],
          };
        }
        if (prompt.includes('长篇片段二')) {
          return {
            content: [{ type: 'text', text: JSON.stringify({
              title: '正经小说',
              chapters: [{ title: '从 Chatbox 整理的正文', content: '# 子章甲\n\n第二段最终正文。\n\n# 子章乙\n\n第三段最终正文。' }],
              notes: '',
            }) }],
          };
        }
        if (prompt.includes('短篇分段一')) {
          return {
            content: [{ type: 'text', text: JSON.stringify({
              title: '短篇',
              chapters: [{ title: '从 Chatbox 整理的正文', content: '短篇第一段。' }],
              notes: '',
            }) }],
          };
        }
        if (prompt.includes('短篇分段二')) {
          return {
            content: [{ type: 'text', text: JSON.stringify({
              title: '短篇',
              chapters: [{ title: '从 Chatbox 整理的正文', content: '短篇第二段。' }],
              notes: '',
            }) }],
          };
        }
        if (!prompt.includes('把“对话的方法”这句话换掉')) {
          throw new Error('prompt missing revision instruction');
        }
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              title: 'galgame创作辅助',
              chapters: [{
                title: '第一章',
                content: '“你等一下，”他对依旧安静趴着的“人机姐姐”说道，声音里带着一丝不确定的兴奋，“我可能……找到帮你取下这个头套的方法了。”\n\n屏幕显示：╮(￣▽￣"")╭',
              }],
              notes: '采用用户纠错后的修正版。',
            }),
          }],
        };
      },
    },
  };
}

async function run() {
  await fs.rm(TMP, { recursive: true, force: true });
  await fs.mkdir(TMP, { recursive: true });

  const chatboxParser = require('../src/main/import/chatboxParser');
  const parsedHtml = chatboxParser.parseChatboxHtml(HTML);
  if (parsedHtml.title === 'galgame创作辅助') pass('parses title');
  else fail('parses title', parsedHtml.title);
  if (parsedHtml.messages.length === 7) pass('parses all Chatbox messages');
  else fail('parses all Chatbox messages', String(parsedHtml.messages.length));
  if (parsedHtml.messages[6].content.includes('╮(￣▽￣"")╭')) pass('decodes entities and preserves emoticons');
  else fail('decodes entities and preserves emoticons', parsedHtml.messages[6].content);

  await setupMockProvider();
  const extractor = require('../src/main/import/chatboxDraftExtractor');
  const parsedPerfect = extractor.parseJsonFromText('{"title":"A","chapters":[{"title":"c","content":"line1\\nline2"}],"notes":""}');
  if (parsedPerfect.chapters[0].content.includes('line2')) pass('parses perfect Chatbox JSON');
  else fail('parses perfect Chatbox JSON', JSON.stringify(parsedPerfect));
  const parsedFenced = extractor.parseJsonFromText('说明文字\n```json\n{"title":"A","chapters":[{"title":"c","content":"正文"}],"notes":""}\n```\n结束');
  if (parsedFenced.title === 'A') pass('parses fenced JSON with surrounding text');
  else fail('parses fenced JSON with surrounding text', JSON.stringify(parsedFenced));
  const parsedBareNewline = extractor.parseJsonFromText('{"title":"A","chapters":[{"title":"c","content":"line1\nline2"}],"notes":""}');
  if (parsedBareNewline.chapters[0].content === 'line1\nline2') pass('repairs bare newlines inside JSON strings');
  else fail('repairs bare newlines inside JSON strings', JSON.stringify(parsedBareNewline));
  const parsedJson5 = extractor.parseJsonFromText("{title:'A',chapters:[{title:'c',content:'正文',}],notes:'',}");
  if (parsedJson5.chapters[0].content === '正文') pass('parses JSON5-style Chatbox output');
  else fail('parses JSON5-style Chatbox output', JSON.stringify(parsedJson5));
  const parsedDanglingFence = extractor.parseJsonFromText('```json\n{"title":"A","chapters":[{"title":"c","content":"正文"}],"notes":""}');
  if (parsedDanglingFence.title === 'A') pass('parses dangling fenced JSON without closing fence');
  else fail('parses dangling fenced JSON without closing fence', JSON.stringify(parsedDanglingFence));

  const htmlPath = path.join(TMP, 'chatbox.html');
  const txtPath = path.join(TMP, 'plain.txt');
  await fs.writeFile(htmlPath, HTML, 'utf8');
  await fs.writeFile(txtPath, '第1章 开始\n内容\n第2章 继续\n更多', 'utf8');

  const fileParser = require('../src/main/import/fileParser');
  const txt = await fileParser.parseNovelFile(txtPath);
  if (txt.chapters.length === 2) pass('keeps txt chapter splitting unchanged');
  else fail('keeps txt chapter splitting unchanged', String(txt.chapters.length));

  const html = await fileParser.parseNovelFile(htmlPath);
  if (html.metadata.importMeta?.sourceType === 'chatbox-html') pass('returns Chatbox source metadata');
  else fail('returns Chatbox source metadata', JSON.stringify(html.metadata));
  if (html.metadata.analysisHints?.includes('主角叫家豪') && html.metadata.importMeta.analysisHintChars > 0) pass('returns Chatbox analysis hints');
  else fail('returns Chatbox analysis hints', JSON.stringify(html.metadata));
  if (html.chapters[0].content.includes('帮你取下这个头套的方法')) pass('uses AI final draft content');
  else fail('uses AI final draft content', html.chapters[0].content);
  if (!html.chapters[0].content.includes('对话’的方法')) pass('does not keep superseded draft sentence');
  else fail('does not keep superseded draft sentence', html.chapters[0].content);

  const longHtml = `<!doctype html><html><head><title>正经小说</title></head><body>
<h2>长篇片段一</h2>
<div class="mb-4"><p><b>USER: </b></p><div class="break-words "><p>请续写第一段。</p></div></div>
<div class="mb-4"><p><b>ASSISTANT: </b></p><div class="break-words "><p>${'第一段正文。'.repeat(9000)}</p></div></div>
<h2>长篇片段二</h2>
<div class="mb-4"><p><b>USER: </b></p><div class="break-words "><p>请续写第二段。</p></div></div>
<div class="mb-4"><p><b>ASSISTANT: </b></p><div class="break-words "><p>${'第二段正文。'.repeat(9000)}</p></div></div>
</body></html>`;
  const longPath = path.join(TMP, 'long-chatbox.html');
  await fs.writeFile(longPath, longHtml, 'utf8');
  const longParsed = await fileParser.parseNovelFile(longPath);
  if (longParsed.chapters.length === 3) pass('long Chatbox import extracts multiple batches and heading chapters');
  else fail('long Chatbox import extracts multiple batches', String(longParsed.chapters.length));
  if (longParsed.chapters.some((ch) => ch.title === '长篇片段一' && ch.content.includes('第一段最终正文'))
    && longParsed.chapters.some((ch) => ch.title === '子章甲' && ch.content.includes('第二段最终正文'))
    && longParsed.chapters.some((ch) => ch.title === '子章乙' && ch.content.includes('第三段最终正文'))) {
    pass('long Chatbox import keeps later batch content');
  } else {
    fail('long Chatbox import keeps later batch content', JSON.stringify(longParsed.chapters));
  }

  const shortMultiSectionHtml = `<!doctype html><html><head><title>短篇</title></head><body>
<h2>短篇分段一</h2>
<div class="mb-4"><p><b>USER: </b></p><div class="break-words "><p>写第一段。</p></div></div>
<div class="mb-4"><p><b>ASSISTANT: </b></p><div class="break-words "><p>正文一。</p></div></div>
<h2>短篇分段二</h2>
<div class="mb-4"><p><b>USER: </b></p><div class="break-words "><p>写第二段。</p></div></div>
<div class="mb-4"><p><b>ASSISTANT: </b></p><div class="break-words "><p>正文二。</p></div></div>
</body></html>`;
  const shortMultiSectionPath = path.join(TMP, 'short-multi-section.html');
  await fs.writeFile(shortMultiSectionPath, shortMultiSectionHtml, 'utf8');
  const shortMulti = await fileParser.parseNovelFile(shortMultiSectionPath);
  if (shortMulti.chapters.length === 2 && shortMulti.chapters[0].title === '短篇分段一' && shortMulti.chapters[1].title === '短篇分段二') {
    pass('short multi-section Chatbox does not collapse into one chapter');
  } else {
    fail('short multi-section Chatbox does not collapse into one chapter', JSON.stringify(shortMulti.chapters));
  }

  mockScenario = 'repair-once';
  mockCalls = [];
  const repairPath = path.join(TMP, 'repair-once.html');
  await fs.writeFile(repairPath, HTML.replace('galgame创作辅助', '修复测试'), 'utf8');
  const repaired = await fileParser.parseNovelFile(repairPath);
  const repairCallCount = mockCalls.filter((p) => p.includes('不是合法 JSON')).length;
  if (repaired.chapters[0].content.includes('修复后的正文') && repairCallCount === 1) pass('retries once with AI JSON repair when local parsing fails');
  else fail('retries once with AI JSON repair when local parsing fails', JSON.stringify({ chapters: repaired.chapters, repairCallCount }));

  mockScenario = 'unrepairable-batch';
  mockCalls = [];
  const badBatchHtml = `<!doctype html><html><head><title>坏批次测试</title></head><body>
<h2>坏批次标题</h2>
<div class="mb-4"><p><b>USER: </b></p><div class="break-words "><p>写正文。</p></div></div>
<div class="mb-4"><p><b>ASSISTANT: </b></p><div class="break-words "><p>正文。</p></div></div>
</body></html>`;
  const badBatchPath = path.join(TMP, 'bad-batch.html');
  await fs.writeFile(badBatchPath, badBatchHtml, 'utf8');
  try {
    await fileParser.parseNovelFile(badBatchPath);
    fail('reports batch context when JSON repair fails');
  } catch (err) {
    if (/坏批次标题|详见主进程日志/.test(err.message) && !/原始输出片段|chapters/.test(err.message)) pass('reports concise batch context when JSON repair fails');
    else fail('reports batch context when JSON repair fails', err.message);
  }
  mockScenario = 'normal';

  mockScenario = 'unrepairable-long-batch';
  mockCalls = [];
  const badLongHtml = `<!doctype html><html><head><title>多批次坏 JSON</title></head><body>
<h2>坏批次甲</h2>
<div class="mb-4"><p><b>USER: </b></p><div class="break-words "><p>这里只是设定。</p></div></div>
<div class="mb-4"><p><b>ASSISTANT: </b></p><div class="break-words "><p>无正文。</p></div></div>
<h2>坏批次乙</h2>
<div class="mb-4"><p><b>USER: </b></p><div class="break-words "><p>写正文。</p></div></div>
<div class="mb-4"><p><b>ASSISTANT: </b></p><div class="break-words "><p>正文。</p></div></div>
</body></html>`;
  const badLongPath = path.join(TMP, 'bad-long-batch.html');
  await fs.writeFile(badLongPath, badLongHtml, 'utf8');
  try {
    await fileParser.parseNovelFile(badLongPath);
    fail('reports exact long Chatbox batch when JSON repair fails');
  } catch (err) {
    if (/第 2\/2 段「坏批次乙」|详见主进程日志/.test(err.message) && !/原始输出片段|chapters/.test(err.message)) pass('reports exact long Chatbox batch when JSON repair fails');
    else fail('reports exact long Chatbox batch when JSON repair fails', err.message);
  }
  mockScenario = 'normal';

  mockScenario = 'concurrency-order';
  mockCalls = [];
  mockActiveCalls = 0;
  mockMaxActiveCalls = 0;
  process.env.MANA_CHATBOX_IMPORT_CONCURRENCY = '3';
  const concurrencyHtml = `<!doctype html><html><head><title>并发顺序测试</title></head><body>
<h2>并发片段一</h2>
<div class="mb-4"><p><b>USER: </b></p><div class="break-words "><p>写第一段。</p></div></div>
<div class="mb-4"><p><b>ASSISTANT: </b></p><div class="break-words "><p>正文一。</p></div></div>
<h2>并发片段二</h2>
<div class="mb-4"><p><b>USER: </b></p><div class="break-words "><p>写第二段。</p></div></div>
<div class="mb-4"><p><b>ASSISTANT: </b></p><div class="break-words "><p>正文二。</p></div></div>
<h2>并发片段三</h2>
<div class="mb-4"><p><b>USER: </b></p><div class="break-words "><p>写第三段。</p></div></div>
<div class="mb-4"><p><b>ASSISTANT: </b></p><div class="break-words "><p>正文三。</p></div></div>
</body></html>`;
  const concurrencyPath = path.join(TMP, 'concurrency-order.html');
  await fs.writeFile(concurrencyPath, concurrencyHtml, 'utf8');
  const concurrentParsed = await fileParser.parseNovelFile(concurrencyPath);
  delete process.env.MANA_CHATBOX_IMPORT_CONCURRENCY;
  const concurrentTitles = concurrentParsed.chapters.map((ch) => ch.title);
  if (mockMaxActiveCalls > 1 && concurrentTitles.join('|') === '并发片段一|并发片段二|并发片段三') {
    pass('long Chatbox batches run concurrently while preserving output order');
  } else {
    fail('long Chatbox batches run concurrently while preserving output order', JSON.stringify({ mockMaxActiveCalls, concurrentTitles }));
  }
  mockScenario = 'normal';

  mockScenario = 'empty-batch-object';
  mockCalls = [];
  const emptyBatchHtml = `<!doctype html><html><head><title>空批次容错</title></head><body>
<h2>空批次一</h2>
<div class="mb-4"><p><b>USER: </b></p><div class="break-words "><p>这里只讨论设定。</p></div></div>
<div class="mb-4"><p><b>ASSISTANT: </b></p><div class="break-words "><p>没有正文。</p></div></div>
<h2>有效批次二</h2>
<div class="mb-4"><p><b>USER: </b></p><div class="break-words "><p>写正文。</p></div></div>
<div class="mb-4"><p><b>ASSISTANT: </b></p><div class="break-words "><p>正文。</p></div></div>
</body></html>`;
  const emptyBatchPath = path.join(TMP, 'empty-batch-object.html');
  await fs.writeFile(emptyBatchPath, emptyBatchHtml, 'utf8');
  const emptyBatchParsed = await fileParser.parseNovelFile(emptyBatchPath);
  if (emptyBatchParsed.chapters.length === 1 && emptyBatchParsed.chapters[0].content.includes('有效正文')) {
    pass('long Chatbox import tolerates an empty batch object');
  } else {
    fail('long Chatbox import tolerates an empty batch object', JSON.stringify(emptyBatchParsed.chapters));
  }
  mockScenario = 'normal';

  const stagingProject = require('../src/main/import/stagingProject');
  const staging = await stagingProject.createStagingProject({
    sourceFiles: [htmlPath],
    chapters: html.chapters,
    metadata: html.metadata,
  });
  const loaded = await stagingProject.getStagingProject(staging.importId);
  if (loaded.novelMeta.importMeta.sourceType === 'chatbox-html') pass('staging stores sourceType in importMeta');
  else fail('staging stores sourceType in importMeta', JSON.stringify(loaded.novelMeta.importMeta));
  const sourceJson = await fs.readFile(path.join(TMP, 'import-staging', staging.importId, 'sources', 'import-source.json'), 'utf8');
  if (sourceJson.includes('"messageCount": 7')) pass('staging writes lightweight source artifact');
  else fail('staging writes lightweight source artifact', sourceJson);
  const hints = await fs.readFile(path.join(TMP, 'import-staging', staging.importId, 'sources', 'analysis-hints.md'), 'utf8');
  if (hints.includes('主角叫家豪')) pass('staging writes Chatbox analysis hints');
  else fail('staging writes Chatbox analysis hints', hints);

  const targetDir = path.join(TMP, 'promoted-chatbox');
  const promoted = await stagingProject.promoteToNovel(staging.importId, { title: 'galgame创作辅助', dir: targetDir });
  const promotedMeta = JSON.parse(await fs.readFile(path.join(targetDir, 'novel.json'), 'utf8'));
  if (promotedMeta.id === promoted.id && promotedMeta.importMeta?.sourceType === 'chatbox-html') pass('promoted novel keeps Chatbox importMeta');
  else fail('promoted novel keeps Chatbox importMeta', JSON.stringify(promotedMeta.importMeta));
  const promotedSource = await fs.readFile(path.join(targetDir, 'sources', 'import-source.json'), 'utf8');
  if (promotedSource.includes('"sourceType": "chatbox-html"')) pass('promoted novel keeps source artifact');
  else fail('promoted novel keeps source artifact', promotedSource);

  const realSamplePath = '/Users/potablewater/Downloads/森林大美食家.html';
  try {
    const realHtml = await fs.readFile(realSamplePath, 'utf8');
    const realTranscript = chatboxParser.parseChatboxHtml(realHtml);
    const realBatches = extractor.splitTranscriptIntoBatches(realTranscript);
    if (realTranscript.messages.length === 143 && realBatches.length === 11) pass('real sample parses into expected Chatbox batches');
    else fail('real sample parses into expected Chatbox batches', JSON.stringify({ messages: realTranscript.messages.length, batches: realBatches.length }));

    mockScenario = 'real-sample-mixed-json';
    mockCalls = [];
    const realParsed = await fileParser.parseNovelFile(realSamplePath);
    if (realParsed.chapters.length >= 11 && realParsed.chapters.some((ch) => ch.content.includes('最终正文'))) pass('real sample mock import tolerates mixed malformed JSON');
    else fail('real sample mock import tolerates mixed malformed JSON', JSON.stringify({ chapterCount: realParsed.chapters.length, first: realParsed.chapters[0] }));
  } catch (err) {
    fail('real sample mock import tolerates mixed malformed JSON', err.message);
  } finally {
    mockScenario = 'normal';
  }

  if (failed > 0) {
    console.log(`\n${failed}/${total} failed`);
    process.exit(1);
  }
  console.log(`\n${total}/${total} passed`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
