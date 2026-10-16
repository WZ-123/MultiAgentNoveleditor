'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');

async function runChatFeedbackUiRegressionTest(win) {
  const store = require('../src/main/store/feedbackOutbox');
  const backend = require('../src/main/index');
  const { FeedbackSyncWorker } = require('../src/main/sync/feedbackSyncWorker');
  const evidence = path.join(__dirname, '../artifacts/chat-chain-audit');
  await fs.mkdir(evidence, { recursive: true });
  let checks = 0;
  let failSave = false;
  let failList = false;
  let submissions = 0;
  let captures = 0;
  let relayRequests = 0;
  let rejectRemote = false;
  const relay = http.createServer((req, res) => {
    relayRequests++;
    req.resume();
    req.on('end', () => {
      assert.equal(req.headers.authorization, 'Bearer fixture-token');
      res.writeHead(rejectRemote ? 503 : 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(rejectRemote ? { code: 'relay_unavailable' } : req.url.endsWith('/upload') ? { fileToken: 'fixture-file' } : { recordId: 'fixture-remote', status: 'sent' }));
    });
  });
  await new Promise(resolve => relay.listen(0, '127.0.0.1', resolve));
  const worker = new FeedbackSyncWorker({ sessionManager: {
    getRelayBaseUrl: async () => `http://127.0.0.1:${relay.address().port}`,
    getAccessToken: async () => 'fixture-token',
  } });
  const originalGetWorker = backend.getFeedbackSyncWorker;
  const originalSubmit = store.submitFeedback;
  const originalList = store.listAllRecords;
  const originalCapture = win.webContents.capturePage.bind(win.webContents);
  backend.getFeedbackSyncWorker()?.stop();
  // Real IPC/store/worker; only the session points at a local HTTP relay fixture.
  backend.getFeedbackSyncWorker = () => worker;
  store.submitFeedback = async (...args) => {
    submissions++;
    await new Promise(resolve => setTimeout(resolve, 150));
    if (failSave) throw new Error('fixture disk unavailable');
    return originalSubmit(...args);
  };
  store.listAllRecords = async (...args) => {
    if (failList) throw new Error('fixture query unavailable');
    return originalList(...args);
  };
  win.webContents.capturePage = async (...args) => {
    captures++;
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('[data-testid="feedback-dialog"]').style.visibility`), 'hidden');
    return originalCapture(...args);
  };
  const captureWithConsent = win.webContents.capturePage;
  const js = (fn, ...args) => win.webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`);
  const shot = async name => {
    // DOM geometry can update before Chromium has painted the new scroll position.
    await win.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 150))))');
    await fs.writeFile(path.join(evidence, name), (await originalCapture()).toPNG());
  };
  const pass = name => { checks++; console.log(`TEST_PASS ${name}`); };
  try {
    await js(async () => {
      const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
      const wait = async (predicate, message) => {
        const until = Date.now() + 16000;
        while (Date.now() < until) { const value = predicate(); if (value) return value; await sleep(60); }
        throw new Error(message);
      };
      const q = id => document.querySelector(`[data-testid="${id}"]`);
      const click = async id => { (await wait(() => q(id), `missing ${id}`)).click(); await sleep(50); };
      const text = () => q('feedback-dialog')?.innerText || '';
      const waitText = value => wait(() => text().includes(value), `missing text ${value}`);
      const value = (id, text) => {
        const element = q(id);
        Object.getOwnPropertyDescriptor(element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value').set.call(element, text);
        element.dispatchEvent(new Event('input', { bubbles: true }));
      };
      const close = async label => { Array.from(q('feedback-dialog').querySelectorAll('button')).find(b => b.textContent === label).click(); await wait(() => !q('feedback-dialog'), 'dialog still open'); };
      const open = async (chat = false) => { await click(chat ? 'chat-feedback-open' : 'feedback-open'); await wait(() => q('feedback-dialog')?.open, 'dialog did not open'); };
      window.__feedbackUi = { q, wait, sleep, click, text, waitText, value, close, open };
      await wait(() => q('feedback-open'), 'global entry missing');
      const chapter = await wait(() => document.querySelector('[data-testid="chapter-tree-item"]'), 'chapter missing');
      chapter.click();
      await wait(() => q('chat-feedback-open'), 'chat entry missing');
      await wait(() => document.body.innerText.includes('PRIVATE_ANSWER'), 'seeded chat missing');
    });
    await js(async () => {
      const t = window.__feedbackUi;
      await t.open();
      if (t.q('feedback-logs').checked || t.q('feedback-screenshot').checked) throw new Error('attachments default on');
      if (document.activeElement !== t.q('feedback-description')) throw new Error('description not focused');
      t.value('feedback-description', '   '); await t.click('feedback-submit'); await t.waitText('请填写问题描述');
      await t.close('取消');
      await t.open();
      if (t.q('feedback-description').value || t.q('feedback-logs').checked) throw new Error('cancel retained report');
    });
    assert.equal(submissions, 0);
    assert.equal((await originalList()).length, 0);
    await shot('feedback-form.png');
    await win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    await js(async () => window.__feedbackUi.wait(() => !window.__feedbackUi.q('feedback-dialog'), 'escape did not close'));
    pass('feedback_buttons_open_form_cancel_escape_and_empty_validation_without_submit');

    // All four independent consent combinations; submit via actual React controls.
    const ids = [];
    for (const [logs, screenshot] of [[false, false], [true, false], [false, true], [true, true]]) {
      await js(async (logs, screenshot) => {
        const t = window.__feedbackUi; await t.open(true);
        t.value('feedback-title', `选项 ${logs}/${screenshot}`); t.value('feedback-description', '隔离表单反馈');
        if (logs) await t.click('feedback-logs'); if (screenshot) await t.click('feedback-screenshot');
        await t.sleep(30); t.q('feedback-submit').click(); t.q('feedback-submit').click();
        await t.waitText('本地保存成功'); await t.waitText('等待同步');
        if (t.text().includes('远端已收到')) throw new Error('local write claimed remote success');
      }, logs, screenshot);
      const records = await originalList();
      assert.equal(records.length, ids.length + 1);
      const record = records.find(item => !ids.includes(item.feedbackId)); ids.push(record.feedbackId);
      assert.equal(record.payload.userInput.feedbackMode, logs ? 'context-with-logs' : 'opinion-only');
      assert.equal(record.payload.attachments.length, screenshot ? 1 : 0);
      if (screenshot) assert.ok((await store.readAttachment(record.feedbackId, record.payload.attachments[0])).length > 0);
      if (logs) {
        assert.ok(JSON.stringify(record.payload).includes('PRIVATE_CHAT'));
        assert.ok(JSON.stringify(record.payload).includes('PRIVATE_TOOL'));
        assert.ok(record.payload.editorContext.contentExcerpt.includes('PRIVATE_BODY'));
      } else { assert.ok(!JSON.stringify(record.payload).includes('PRIVATE_')); }
      await js(async () => window.__feedbackUi.close('关闭'));
      pass(`feedback_form_consent_logs_${logs}_screenshot_${screenshot}_persisted_without_duplicate`);
    }
    assert.equal(submissions, 4);
    assert.equal(captures, 2);
    pass('feedback_screenshot_only_on_consent_and_form_hidden_during_capture');

    failSave = true;
    await js(async () => {
      const t = window.__feedbackUi; await t.open(); t.value('feedback-description', '保存失败时保留输入');
      await t.click('feedback-submit'); await t.waitText('fixture disk unavailable');
      if (t.q('feedback-description').value !== '保存失败时保留输入' || t.q('feedback-submit').disabled) throw new Error('failed submission cannot recover');
    });
    assert.equal((await originalList()).length, 4);
    failSave = false;
    await js(async () => { const t = window.__feedbackUi; await t.click('feedback-submit'); await t.waitText('本地保存成功'); await t.close('关闭'); });
    assert.equal((await originalList()).length, 5);
    pass('feedback_save_error_visible_draft_retained_and_retry_saves_once');

    win.webContents.capturePage = async () => { throw new Error('fixture screenshot unavailable'); };
    await js(async () => {
      const t = window.__feedbackUi; await t.open(); t.value('feedback-description', '截图失败反馈');
      await t.click('feedback-screenshot'); await t.click('feedback-submit'); await t.waitText('截图未能附加');
    });
    win.webContents.capturePage = captureWithConsent;
    const screenshotFailed = (await originalList()).find(item => item.payload.userInput.actualBehavior === '截图失败反馈');
    assert.ok(screenshotFailed.payload.errors.screenshotCaptureError);
    assert.equal(screenshotFailed.payload.attachments.length, 0);
    await js(async () => window.__feedbackUi.close('关闭'));
    pass('feedback_screenshot_failure_warns_without_claiming_attachment');

    await store.updateSyncMeta(ids[0], { syncStatus: 'syncing' });
    await js(async id => {
      const t = window.__feedbackUi; await t.open();
      await t.wait(() => document.querySelector(`[data-feedback-id="${id}"]`)?.innerText.includes('正在同步'), 'syncing not displayed');
    }, ids[0]);
    await store.updateSyncMeta(ids[0], { syncStatus: 'retryable_failed', lastError: 'fixture offline' });
    await js(async id => {
      const t = window.__feedbackUi; await t.wait(() => document.querySelector(`[data-feedback-id="${id}"]`)?.innerText.includes('fixture offline'), 'failed sync missing');
    }, ids[0]);
    await js(async id => {
      const row = document.querySelector(`[data-feedback-id="${id}"]`);
      row.scrollIntoView({ block: 'center', behavior: 'instant' });
      await window.__feedbackUi.wait(() => {
        const bounds = row.getBoundingClientRect();
        const dialog = window.__feedbackUi.q('feedback-dialog').getBoundingClientRect();
        return bounds.top >= dialog.top && bounds.bottom <= dialog.bottom;
      }, 'sync evidence row is outside the visible dialog');
    }, ids[0]);
    await shot('feedback-sync-failed.png');
    rejectRemote = true;
    await js(async id => {
      const t = window.__feedbackUi; document.querySelector(`[data-feedback-id="${id}"] button`).click();
      await t.sleep(200);
      await t.wait(() => !document.querySelector(`[data-feedback-id="${id}"] button`)?.disabled && document.querySelector(`[data-feedback-id="${id}"]`)?.innerText.includes('同步失败'), 'remote failure missing');
    }, ids[0]);
    assert.equal((await store.getRecord(ids[0])).syncStatus, 'retryable_failed');
    rejectRemote = false;
    await js(async id => {
      const t = window.__feedbackUi; await t.wait(() => !document.querySelector(`[data-feedback-id="${id}"] button`)?.disabled, 'retry stayed disabled');
      document.querySelector(`[data-feedback-id="${id}"] button`).click();
      await t.wait(() => document.querySelector(`[data-feedback-id="${id}"]`)?.innerText.includes('远端已收到'), 'remote success missing');
    }, ids[0]);
    assert.equal((await store.getRecord(ids[0])).remoteRecordId, 'fixture-remote');
    assert.ok(relayRequests >= 2);
    await js(async id => {
      const row = document.querySelector(`[data-feedback-id="${id}"]`);
      row.scrollIntoView({ block: 'center', behavior: 'instant' });
      await window.__feedbackUi.wait(() => {
        const bounds = row.getBoundingClientRect();
        const dialog = window.__feedbackUi.q('feedback-dialog').getBoundingClientRect();
        return bounds.top >= dialog.top && bounds.bottom <= dialog.bottom;
      }, 'sync evidence row is outside the visible dialog');
    }, ids[0]);
    await shot('feedback-sync-sent.png');
    await js(async () => { const t = window.__feedbackUi; await t.close('取消'); await t.open(); await t.waitText('远端已收到'); });
    pass('feedback_syncing_offline_retry_http_failure_remote_receipt_and_reopen');

    await store.updateSyncMeta(ids[1], { syncStatus: 'sent', remoteRecordId: null });
    await store.updateSyncMeta(ids[2], { syncStatus: 'failed_terminal', lastError: 'fixture terminal failure' });
    await js(async (unknownId, failedId) => {
      const t = window.__feedbackUi;
      await t.wait(() => document.querySelector(`[data-feedback-id="${failedId}"]`)?.innerText.includes('需要处理'), 'terminal state missing');
      const row = document.querySelector(`[data-feedback-id="${unknownId}"]`);
      if (row.innerText.includes('远端已收到')) throw new Error('missing remote receipt treated as success');
    }, ids[1], ids[2]);
    const retryRecord = worker.retryRecord;
    worker.retryRecord = async () => { throw new Error('fixture retry unavailable'); };
    await js(async id => {
      const t = window.__feedbackUi;
      document.querySelector(`[data-feedback-id="${id}"] button`).click();
      await t.waitText('重试同步失败：fixture retry unavailable');
    }, ids[2]);
    worker.retryRecord = retryRecord;
    pass('feedback_terminal_unknown_receipt_and_retry_ipc_error');

    failList = true;
    await js(async () => window.__feedbackUi.waitText('fixture query unavailable'));
    await shot('feedback-status-error.png');
    failList = false;
    await js(async () => { const t = window.__feedbackUi; await t.wait(() => !t.text().includes('fixture query unavailable'), 'query did not recover'); await t.close('取消'); });
    pass('feedback_status_query_failure_visible_and_recovers');
    console.log(`TEST_SUMMARY ${checks}/${checks} passed, 0 failed\nTEST_DONE`);
    return { failed: 0 };
  } catch (error) {
    await shot('feedback-ui-failure.png').catch(() => {});
    console.error('TEST_FAIL feedback_ui:', error.stack || error);
    return { failed: 1 };
  } finally {
    store.submitFeedback = originalSubmit; store.listAllRecords = originalList;
    backend.getFeedbackSyncWorker = originalGetWorker; win.webContents.capturePage = originalCapture;
    worker.stop(); await new Promise(resolve => relay.close(resolve));
  }
}
module.exports = { runChatFeedbackUiRegressionTest };
