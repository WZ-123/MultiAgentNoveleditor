'use strict';

const path = require('node:path');

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runChatFeedbackFeishuE2E(mainWindow) {
  const ROOT = path.resolve(__dirname, '..');
  const feedbackOutbox = require(path.join(ROOT, 'src/main/store/feedbackOutbox'));

  const results = { total: 0, passed: 0, failed: 0 };
  function pass(name, detail) {
    results.total += 1;
    results.passed += 1;
    console.log(`TEST_PASS ${name}${detail ? ': ' + detail : ''}`);
  }
  function fail(name, reason) {
    results.total += 1;
    results.failed += 1;
    console.log(`TEST_FAIL ${name}: ${reason}`);
  }

  try {
    const uniqueTitle = `真实飞书反馈回归-${Date.now().toString(36)}`;
    const uiResult = await mainWindow.webContents.executeJavaScript(`
      (async () => {
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

        async function waitFor(predicate, message, timeout = 20000) {
          const startedAt = Date.now();
          while (Date.now() - startedAt < timeout) {
            const value = await predicate();
            if (value) return value;
            await sleep(100);
          }
          throw new Error(message);
        }

        function setControlValue(control, value) {
          const proto = control.tagName === 'TEXTAREA'
            ? HTMLTextAreaElement.prototype
            : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
          if (setter) setter.call(control, value);
          else control.value = value;
          control.dispatchEvent(new Event('input', { bubbles: true }));
        }

        function findButtonByText(text) {
          return Array.from(document.querySelectorAll('button')).find((button) => (button.textContent || '').includes(text)) || null;
        }

        const feedbackButton = await waitFor(() => findButtonByText('一键反馈问题'), 'feedback button not found');
        feedbackButton.click();

        const dialog = await waitFor(() => document.querySelector('[role="dialog"]'), 'feedback dialog not opened');
        const titleInput = await waitFor(() => dialog.querySelector('input[type="text"]'), 'feedback title input not found');
        const descriptionBox = await waitFor(() => dialog.querySelector('textarea'), 'feedback description box not found');
        const screenshotToggle = await waitFor(() => dialog.querySelector('input[type="checkbox"]'), 'screenshot toggle not found');
        setControlValue(titleInput, ${JSON.stringify(uniqueTitle)});
        setControlValue(descriptionBox, '真实飞书 UI 回归：验证一键反馈会自动同步到飞书多维表。');
        if (!screenshotToggle.checked) screenshotToggle.click();

        const submitButton = await waitFor(() => findButtonByText('提交一键反馈'), 'feedback submit button not found');
        submitButton.click();

        const noticeText = await waitFor(() => {
          const bodyText = document.body.innerText || '';
          return bodyText.includes('反馈已保存') ? bodyText : null;
        }, 'feedback success notice not found', 20000);

        const idMatch = noticeText.match(/ID:\\s*(fb-[a-z0-9-]+)/i);
        return {
          noticeText,
          feedbackId: idMatch ? idMatch[1] : '',
          modalClosed: !document.querySelector('[role="dialog"]'),
        };
      })()
    `);

    if (!uiResult?.feedbackId) {
      fail('CHAT_FEEDBACK_FEISHU_UI_notice_contains_feedback_id', JSON.stringify(uiResult));
      console.log('');
      console.log(`TEST_SUMMARY ${results.passed}/${results.total} passed, ${results.failed} failed`);
      console.log('TEST_DONE');
      return results;
    }

    if (uiResult.modalClosed && String(uiResult.noticeText || '').includes(uiResult.feedbackId)) {
      pass('CHAT_FEEDBACK_FEISHU_UI_submit_returns_feedback_id', uiResult.feedbackId);
    } else {
      fail('CHAT_FEEDBACK_FEISHU_UI_submit_returns_feedback_id', JSON.stringify(uiResult));
    }

    const startedAt = Date.now();
    let syncedRecord = null;
    while (Date.now() - startedAt < 60000) {
      const current = await feedbackOutbox.getRecord(uiResult.feedbackId);
      if (current?.syncStatus === 'sent' && current.remoteRecordId) {
        syncedRecord = current;
        break;
      }
      if (current?.syncStatus === 'failed_terminal') {
        syncedRecord = current;
        break;
      }
      await delay(1000);
    }

    if (syncedRecord?.syncStatus === 'sent' && syncedRecord.remoteRecordId) {
      pass(
        'CHAT_FEEDBACK_FEISHU_UI_record_sent_to_feishu',
        `${syncedRecord.feedbackId} -> ${syncedRecord.remoteRecordId}`
      );
    } else {
      fail(
        'CHAT_FEEDBACK_FEISHU_UI_record_sent_to_feishu',
        JSON.stringify({
          feedbackId: uiResult.feedbackId,
          syncStatus: syncedRecord?.syncStatus || 'timeout',
          lastError: syncedRecord?.lastError || '',
          remoteRecordId: syncedRecord?.remoteRecordId || '',
        })
      );
    }
  } catch (err) {
    fail('CHAT_FEEDBACK_FEISHU_UI_harness', err.message || String(err));
  }

  console.log('');
  console.log(`TEST_SUMMARY ${results.passed}/${results.total} passed, ${results.failed} failed`);
  console.log('TEST_DONE');
  return results;
}

module.exports = { runChatFeedbackFeishuE2E };