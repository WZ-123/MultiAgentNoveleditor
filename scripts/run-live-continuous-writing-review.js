'use strict';

const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SOURCE_USER_DATA = path.join(ROOT, 'artifacts', 'deepseek-live-acceptance', 'provider-user-data');
const OUTPUT_ROOT = path.join(ROOT, 'artifacts', 'live-continuous-writing-acceptance');
const USER_DATA = path.join(os.tmpdir(), `mana-live-continuous-review-${process.pid}`);
process.env.MANA_USER_DATA_ROOT = USER_DATA;

async function waitForTerminal(service, runId, timeoutMs = 180_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      service.off('event', listener);
      reject(new Error('live content review timed out'));
    }, timeoutMs);
    const listener = (event) => {
      if (event.runId !== runId || !['turn_completed', 'turn_failed', 'turn_interrupted'].includes(event.type)) return;
      clearTimeout(timer);
      service.off('event', listener);
      event.type === 'turn_completed' ? resolve(event) : reject(new Error(event.error || event.type));
    };
    service.on('event', listener);
  });
}

async function run() {
  await fsp.mkdir(USER_DATA, { recursive: true, mode: 0o700 });
  for (const name of ['model-config.json', 'secrets.json']) await fsp.copyFile(path.join(SOURCE_USER_DATA, name), path.join(USER_DATA, name));
  const chapterNames = ['chapter-001.md', 'chapter-002.md', 'chapter-003.md'];
  const chapters = await Promise.all(chapterNames.map(async (fileName) => ({ fileName, content: await fsp.readFile(path.join(OUTPUT_ROOT, 'novel', 'chapters', fileName), 'utf8') })));
  const chatHistory = require('../src/main/store/chatHistory');
  const { CodexSessionService } = require('../src/main/codex-runtime/codexSessionService');
  const service = new CodexSessionService();
  try {
    const text = `你是独立小说审稿人。以下三章由另一个模型在一个连续写作回合中生成。只根据正文分别判断：\n1. 每章是否在动作、对白和情绪上形成自然落点；\n2. 第二、三章是否明确承接上一章造成的事实或选择；\n3. 叙述视角、时态、人物声线和节奏是否稳定。\n\n每项引用章节和具体短句作为证据；不要用重复率代替判断，不要调用工具，不要改写正文。最后必须另起一行，只写“内容审查结论：通过”或“内容审查结论：需修订”。\n\n${chapters.map((chapter) => `===== ${chapter.fileName} =====\n${chapter.content}`).join('\n\n')}`;
    const thread = await chatHistory.createThread({ title: '独立文本内容审查', novelId: null });
    const user = { id: `user-${crypto.randomUUID()}`, role: 'user', text, timestamp: Date.now() };
    await chatHistory.appendMessage(thread.id, user);
    const runId = `run-${crypto.randomUUID()}`;
    const terminal = waitForTerminal(service, runId);
    await service.startTurn({ runId, conversationId: thread.id, persistence: 'chat', userMessageId: user.id, text, taskConstraints: { operation: 'review' } });
    const completed = await terminal;
    const branch = chatHistory.getBranch(await chatHistory.getThread(thread.id));
    const report = branch.filter((message) => message.role === 'assistant').at(-1)?.text || '';
    const status = /内容审查结论\s*[：:]\s*通过/u.test(report)
      ? 'passed'
      : /内容审查结论\s*[：:]\s*需修订/u.test(report) ? 'needs_revision' : 'unparsed';
    const resultFile = path.join(OUTPUT_ROOT, 'result.json');
    const result = JSON.parse(await fsp.readFile(resultFile, 'utf8'));
    result.contentReview = { status, reviewerTurnId: completed.turnId, mode: 'independent-text-only-real-model', evidenceReport: report };
    result.completedAt = new Date().toISOString();
    await fsp.writeFile(resultFile, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    console.log(`live-continuous-writing-review: ${status}`);
    if (status === 'unparsed') throw new Error('real reviewer did not return the required conclusion');
  } finally {
    await service.dispose();
    await fsp.rm(USER_DATA, { recursive: true, force: true });
  }
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
