'use strict';

const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SOURCE_USER_DATA = path.join(ROOT, 'artifacts', 'deepseek-live-acceptance', 'provider-user-data');
const OUTPUT_ROOT = path.join(ROOT, 'artifacts', 'live-continuous-writing-acceptance');
const USER_DATA = path.join(os.tmpdir(), `mana-live-continuous-writing-${process.pid}`);
const NOVEL_DIR = path.join(OUTPUT_ROOT, 'novel');
process.env.MANA_USER_DATA_ROOT = USER_DATA;

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

async function waitForTerminal(service, runId, timeoutMs = 600_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      service.off('event', listener);
      reject(new Error(`live turn timed out: ${runId}`));
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

async function chatTurn({ service, chatHistory, novelId, title, text, skillName, taskConstraints }) {
  const thread = await chatHistory.createThread({ title, novelId });
  const user = { id: `user-${crypto.randomUUID()}`, role: 'user', text, timestamp: Date.now() };
  await chatHistory.appendMessage(thread.id, user);
  const runId = `run-${crypto.randomUUID()}`;
  const terminal = waitForTerminal(service, runId);
  await service.startTurn({
    runId, conversationId: thread.id, persistence: 'chat', novelId, userMessageId: user.id,
    text, skillName, taskConstraints,
  });
  const completed = await terminal;
  const branch = chatHistory.getBranch(await chatHistory.getThread(thread.id));
  return { runId, threadId: thread.id, completed, reply: branch.filter((message) => message.role === 'assistant').at(-1)?.text || '' };
}

async function run() {
  await fsp.rm(NOVEL_DIR, { recursive: true, force: true });
  await fsp.rm(path.join(OUTPUT_ROOT, 'failure.txt'), { force: true });
  await fsp.mkdir(USER_DATA, { recursive: true, mode: 0o700 });
  await fsp.mkdir(NOVEL_DIR, { recursive: true });
  for (const name of ['model-config.json', 'secrets.json']) {
    await fsp.copyFile(path.join(SOURCE_USER_DATA, name), path.join(USER_DATA, name));
  }
  const novels = require('../src/main/store/novels');
  const novelData = require('../src/main/store/novelData');
  const chatHistory = require('../src/main/store/chatHistory');
  const { CodexSessionService } = require('../src/main/codex-runtime/codexSessionService');
  const { bodyChineseCharacterCount } = require('../src/main/mcp/novelResources');
  const novel = await novels.createNovel({ title: '连续创作真实模型验收', dir: NOVEL_DIR });
  const service = new CodexSessionService();
  const events = [];
  const confirmations = [];
  service.on('event', (event) => {
    events.push({ type: event.type, runId: event.runId, itemType: event.item?.type, itemStatus: event.item?.status, resources: event.committedResources?.map((item) => item.resourceRef) || [] });
    if (event.type === 'confirmation_requested') {
      confirmations.push({ runId: event.runId, confirmationId: event.confirmationId, resources: event.arguments?.nativeChanges?.map((item) => item.resourceRef) || [] });
      service.resolveConfirmation({ confirmationId: event.confirmationId, accept: false, reason: '真实模型验收不扩大项目新增正文授权' }).catch(() => {});
    }
  });
  try {
    await service.setWritingAuthorization({ novelId: novel.id, mode: 'append-prose' });
    const writing = await chatTurn({
      service, chatHistory, novelId: novel.id, title: '一次消息连续写三章', skillName: 'mana-fiction-writing', taskConstraints: { operation: 'write' },
      text: '创作一篇悬疑短篇的连续三章，分别保存到 chapter:chapter-001.md、chapter:chapter-002.md、chapter:chapter-003.md。保持第三人称限知、过去时、克制的叙述声线和紧凑节奏。每章是一个完整连续场景，要有动作因果、有效对白、情绪变化和自然落点；后一章从前一章的后果继续。每个完整场景写完后立即用原生 apply_patch 新建对应章节，确认保存成功后在同一个原生回合继续下一章。不要按固定字数切分，不要询问，不要写创作说明。',
    });
    const chapterNames = ['chapter-001.md', 'chapter-002.md', 'chapter-003.md'];
    const chapters = [];
    for (const fileName of chapterNames) {
      const content = await novelData.readChapter(novel.dir, fileName);
      chapters.push({ fileName, content, bodyCjk: bodyChineseCharacterCount(content), hash: sha256(content) });
    }
    const writerCommits = events.filter((event) => event.runId === writing.runId && event.type === 'item_completed' && event.resources.length);
    const protocol = {
      status: writerCommits.length >= 3 && confirmations.filter((item) => item.runId === writing.runId).length === 0 ? 'passed' : 'failed',
      oneUserMessage: chatHistory.getBranch(await chatHistory.getThread(writing.threadId)).filter((message) => message.role === 'user').length === 1,
      nativeTurnId: writing.completed.turnId,
      commitCount: writerCommits.length,
      committedResources: writerCommits.flatMap((event) => event.resources),
      confirmationCount: confirmations.filter((item) => item.runId === writing.runId).length,
      chapters: chapters.map(({ fileName, bodyCjk, hash }) => ({ fileName, bodyCjk, hash })),
    };
    if (protocol.status !== 'passed') throw new Error(`live continuous-writing protocol failed: ${JSON.stringify(protocol)}`);

    const review = await chatTurn({
      service, chatHistory, novelId: novel.id, title: '独立内容审查', skillName: 'mana-consistency-review', taskConstraints: { operation: 'review' },
      text: '独立审查 chapter:chapter-001.md、chapter:chapter-002.md、chapter:chapter-003.md。分别判断：（1）每章场景是否在动作、对白和情绪上形成自然落点；（2）第二、三章是否明确承接上一章造成的事实或选择；（3）叙述视角、时态、人物声线和节奏是否稳定。每项引用章节和具体句子作为证据。结尾另起一行，只写“内容审查结论：通过”或“内容审查结论：需修订”。重复率不能代替这些判断。只审查，不修改正文。',
    });
    const contentReview = {
      status: /内容审查结论：通过/u.test(review.reply) ? 'passed' : /内容审查结论：需修订/u.test(review.reply) ? 'needs_revision' : 'unparsed',
      reviewerTurnId: review.completed.turnId,
      evidenceReport: review.reply,
    };
    const result = { completedAt: new Date().toISOString(), modelId: 'deepseek-v4-flash', reasoningEffort: 'none', protocol, contentReview };
    await fsp.mkdir(OUTPUT_ROOT, { recursive: true });
    await fsp.writeFile(path.join(OUTPUT_ROOT, 'result.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    console.log(`live-continuous-writing-acceptance: ${protocol.status}; content-review=${contentReview.status}; commits=${protocol.commitCount}`);
  } finally {
    await service.dispose();
    await fsp.rm(USER_DATA, { recursive: true, force: true });
  }
}

run().catch(async (error) => {
  await fsp.mkdir(OUTPUT_ROOT, { recursive: true }).catch(() => {});
  await fsp.writeFile(path.join(OUTPUT_ROOT, 'failure.txt'), `${error.stack || error}\n`, 'utf8').catch(() => {});
  console.error(error);
  process.exitCode = 1;
});
