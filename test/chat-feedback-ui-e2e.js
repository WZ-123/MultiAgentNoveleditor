'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runChatFeedbackUiRegressionTest(mainWindow) {
  const ROOT = path.resolve(__dirname, '..');
  const { paths } = require(path.join(ROOT, 'src/main/store/paths'));
  const outbox = paths().feedbackOutbox;

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
    await fs.rm(outbox, { recursive: true, force: true });
    await fs.mkdir(outbox, { recursive: true });
    await delay(1200);

    const uiResult = await mainWindow.webContents.executeJavaScript(`
      (async () => {
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

        async function waitFor(predicate, message, timeout = 15000) {
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

        const feedbackButton = await waitFor(() => findButtonByText('一键反馈问题'), 'feedback button not found', 20000);
        feedbackButton.click();

        const dialog = await waitFor(() => document.querySelector('[role="dialog"]'), 'feedback dialog not opened');
        const titleInput = await waitFor(() => dialog.querySelector('input[type="text"]'), 'feedback title input not found');
        const descriptionBox = await waitFor(() => dialog.querySelector('textarea'), 'feedback description box not found');
        const screenshotToggle = await waitFor(() => dialog.querySelector('input[type="checkbox"]'), 'screenshot toggle not found');
        setControlValue(titleInput, '反馈截图回归');
        setControlValue(descriptionBox, '用于验证反馈是否附带窗口截图和日志摘要。');
        screenshotToggle.click();

        const submitButton = await waitFor(() => findButtonByText('提交一键反馈'), 'feedback submit button not found');
        submitButton.click();

        const noticeText = await waitFor(() => {
          const bodyText = document.body.innerText || '';
          return bodyText.includes('反馈已保存') ? bodyText : null;
        }, 'feedback success notice not found', 15000);

        return {
          noticeText,
          modalClosed: !document.querySelector('[role="dialog"]'),
        };
      })()
    `);

    if (uiResult?.modalClosed && String(uiResult.noticeText || '').includes('截图')) {
      pass('CHAT_FEEDBACK_UI_modal_submits_with_screenshot_option', 'feedback modal saved with screenshot mode enabled');
    } else {
      fail('CHAT_FEEDBACK_UI_modal_submits_with_screenshot_option', JSON.stringify(uiResult));
    }

    await delay(1200);
    const files = await fs.readdir(outbox);
    const jsonFiles = files.filter((file) => file.endsWith('.json') && file !== 'index.json');
    const pngFiles = files.filter((file) => file.endsWith('.png'));
    if (jsonFiles.length === 1 && pngFiles.length === 1) {
      pass('CHAT_FEEDBACK_UI_outbox_contains_json_and_png', `${jsonFiles[0]}, ${pngFiles[0]}`);
    } else {
      fail('CHAT_FEEDBACK_UI_outbox_contains_json_and_png', JSON.stringify({ files, jsonFiles, pngFiles }));
    }

    if (jsonFiles.length === 1) {
      const record = JSON.parse(await fs.readFile(path.join(outbox, jsonFiles[0]), 'utf8'));
      const attachment = record?.payload?.attachments?.[0] || null;
      const rendererLogs = record?.payload?.recentLogs?.renderer || [];
      if (
        attachment?.kind === 'window-screenshot'
        && attachment?.mimeType === 'image/png'
        && attachment?.size > 0
        && Array.isArray(rendererLogs)
      ) {
        pass('CHAT_FEEDBACK_UI_payload_persists_attachment_and_logs', 'record includes screenshot metadata and renderer log bundle');
      } else {
        fail('CHAT_FEEDBACK_UI_payload_persists_attachment_and_logs', JSON.stringify(record?.payload || {}));
      }
    }
  } catch (err) {
    fail('CHAT_FEEDBACK_UI_harness', err.message || String(err));
  }

  console.log('');
  console.log(`TEST_SUMMARY ${results.passed}/${results.total} passed, ${results.failed} failed`);
  console.log('TEST_DONE');
  return results;
}

module.exports = { runChatFeedbackUiRegressionTest };