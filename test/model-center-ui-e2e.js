'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function runModelCenterUiRegressionTest(mainWindow) {
  const ROOT = path.resolve(__dirname, '..');
  const results = { total: 0, passed: 0, failed: 0, screenshots: [] };
  const pass = (name, detail) => { results.total += 1; results.passed += 1; console.log(`TEST_PASS ${name}${detail ? `: ${detail}` : ''}`); };
  const fail = (name, reason) => { results.total += 1; results.failed += 1; console.log(`TEST_FAIL ${name}: ${reason}`); };

  const evaluate = (source) => mainWindow.webContents.executeJavaScript(source, true);
  const screenshot = async (name) => {
    const dir = path.join(ROOT, 'qa-screenshots');
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, name);
    const image = await mainWindow.webContents.capturePage();
    await fs.writeFile(file, image.toPNG());
    results.screenshots.push(file);
    console.log(`TEST_SCREENSHOT ${file}`);
    return file;
  };

  try {
    mainWindow.setMinimumSize(900, 700);
    mainWindow.setSize(1280, 860);
    mainWindow.show();
    await delay(500);

    const opened = await evaluate(`
      (async () => {
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const wait = async (fn, timeout = 10000) => { const start = Date.now(); while (Date.now() - start < timeout) { const value = fn(); if (value) return value; await sleep(100); } return null; };
        localStorage.removeItem('mana-model-config-v4-local-migrated');
        localStorage.setItem('mana-agent-api-config-v2', JSON.stringify({ agent1: { useMock: true } }));
        const button = await wait(() => document.querySelector('[title="模型配置"]'));
        if (!button) return { ok: false, step: 'activity_button' };
        button.click();
        const title = await wait(() => Array.from(document.querySelectorAll('*')).find((el) => el.textContent === '模型中心'));
        const migrated = await wait(() => localStorage.getItem('mana-agent-api-config-v2') === null && localStorage.getItem('mana-model-config-v4-local-migrated') === '1');
        return { ok: !!title, migrated: !!migrated, body: (document.body.innerText || '').slice(0, 800) };
      })()
    `);
    if (opened.ok && opened.migrated) pass('MCUI_T1_open_model_center', '模型中心可打开，且 imported=0 的旧明文配置也会在成功检查后删除');
    else throw new Error(`模型中心未打开：${JSON.stringify(opened)}`);

    const overview = await evaluate(`
      (async () => {
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const center = document.querySelector('[data-testid="model-center"]');
        const cases = [
          ['总览', '当前用途分配'],
          ['API 连接', 'Provider 连接'],
          ['写作档案', '写作模型档案'],
          ['用途分配', '为聊天、写作和审查选择档案'],
        ];
        const states = {};
        let directMarker = false;
        let forbiddenDriverOption = false;
        for (const [label, marker] of cases) {
          const button = Array.from(center.querySelectorAll('button')).find((item) => item.textContent.trim() === label);
          const visible = !!button && button.offsetParent !== null;
          button?.click();
          await sleep(120);
          const text = center.innerText || '';
          states[label] = { visible, marker: text.includes(marker) };
          directMarker ||= text.includes('Direct API');
          const selectableOptions = Array.from(center.querySelectorAll('select option')).map((option) => option.textContent.trim());
          forbiddenDriverOption ||= text.includes('当前 Driver')
            || selectableOptions.some((option) => /claude-code|claude-code-vscode|claude-code-cli|^codex$/i.test(option));
        }
        Array.from(center.querySelectorAll('button')).find((item) => item.textContent.trim() === '总览')?.click();
        await sleep(120);
        const text = center.innerText || '';
        const overviewCardLabels = ['默认档案', 'API 连接', '写作档案'];
        return {
          noInternalSchema: !/Schema v\d+/i.test(text),
          tabs: cases.every(([label]) => states[label]?.visible && states[label]?.marker),
          states,
          overviewCards: overviewCardLabels.every((label) => Array.from(center.querySelectorAll('div')).some((item) => item.children.length === 0 && item.textContent.trim() === label)),
          noInternalLocation: !text.includes('配置环境') && !text.includes('配置位置'),
          directOnly: directMarker && !forbiddenDriverOption,
          error: text.includes('模型配置 IPC 不可用'),
        };
      })()
    `);
    if (overview.noInternalSchema && overview.tabs && overview.overviewCards && overview.noInternalLocation && overview.directOnly && !overview.error) pass('MCUI_T2_overview_complete', JSON.stringify(overview));
    else fail('MCUI_T2_overview_complete', JSON.stringify(overview));

    const codexMockCard = await evaluate(`(() => {
      const card = document.querySelector('[data-testid="codex-mock-test-card"]');
      const toggle = card?.querySelector('[data-testid="codex-mock-test-toggle"]');
      const text = card?.innerText || '';
      return {
        visible: !!card && card.offsetParent !== null,
        toggle: !!toggle,
        checked: !!toggle?.checked,
        disabled: !!toggle?.disabled,
        explainsRealLogin: text.includes('真实 Codex 登录'),
        explainsNextTurn: text.includes('下一轮模型请求'),
        explainsUnavailable: text.includes('仅在允许的本机开发/测试环境中可开启')
          || /不可用|未登录|未找到|不支持|unavailable|not found|not logged in/i.test(text),
        text,
      };
    })()`);
    if (codexMockCard.visible && codexMockCard.toggle && !codexMockCard.checked && codexMockCard.explainsRealLogin && codexMockCard.explainsNextTurn) {
      pass('MCUI_T2C_codex_mock_card_defaults_off', JSON.stringify(codexMockCard));
    } else {
      fail('MCUI_T2C_codex_mock_card_defaults_off', JSON.stringify(codexMockCard));
    }

    if (!codexMockCard.disabled) {
      const enabled = await evaluate(`(async () => {
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const wait = async (fn, timeout = 10000) => { const start = Date.now(); while (Date.now() - start < timeout) { const value = fn(); if (value) return value; await sleep(80); } return null; };
        const toggle = document.querySelector('[data-testid="codex-mock-test-toggle"]');
        toggle?.click();
        const checked = await wait(() => document.querySelector('[data-testid="codex-mock-test-toggle"]')?.checked === true);
        return { checked: !!checked, notice: document.body.innerText.includes('从下一轮模型请求开始生效') };
      })()`);
      const enabledDisk = JSON.parse(await fs.readFile(path.join(process.env.MANA_USER_DATA_ROOT, 'app-config.json'), 'utf8'));
      if (enabled.checked && enabled.notice && enabledDisk.testing?.codexMock?.enabled === true) {
        pass('MCUI_T2D_codex_mock_toggle_persists_on', JSON.stringify({ enabled, persisted: enabledDisk.testing.codexMock }));
      } else {
        fail('MCUI_T2D_codex_mock_toggle_persists_on', JSON.stringify({ enabled, persisted: enabledDisk.testing?.codexMock }));
      }

      const disabled = await evaluate(`(async () => {
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const wait = async (fn, timeout = 10000) => { const start = Date.now(); while (Date.now() - start < timeout) { const value = fn(); if (value) return value; await sleep(80); } return null; };
        document.querySelector('[data-testid="codex-mock-test-toggle"]')?.click();
        const unchecked = await wait(() => document.querySelector('[data-testid="codex-mock-test-toggle"]')?.checked === false);
        return { unchecked: !!unchecked, notice: document.body.innerText.includes('恢复 Direct API') };
      })()`);
      const disabledDisk = JSON.parse(await fs.readFile(path.join(process.env.MANA_USER_DATA_ROOT, 'app-config.json'), 'utf8'));
      if (disabled.unchecked && disabled.notice && disabledDisk.testing?.codexMock?.enabled === false) {
        pass('MCUI_T2E_codex_mock_toggle_persists_off', JSON.stringify({ disabled, persisted: disabledDisk.testing.codexMock }));
      } else {
        fail('MCUI_T2E_codex_mock_toggle_persists_off', JSON.stringify({ disabled, persisted: disabledDisk.testing?.codexMock }));
      }
    } else if (codexMockCard.explainsUnavailable) {
      pass('MCUI_T2D_codex_mock_unavailable_is_fail_closed', codexMockCard.text.replace(/\s+/g, ' ').slice(0, 300));
    } else {
      fail('MCUI_T2D_codex_mock_unavailable_is_fail_closed', JSON.stringify(codexMockCard));
    }

    const malformedLegacy = await evaluate(`
      (async () => {
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const wait = async (fn, timeout = 8000) => { const start = Date.now(); while (Date.now() - start < timeout) { const value = fn(); if (value) return value; await sleep(80); } return null; };
        localStorage.removeItem('mana-model-config-v4-local-migrated');
        localStorage.setItem('mana-agent-api-config-v2', '{malformed');
        document.querySelector('[data-testid="model-center"] svg.lucide-refresh-cw')?.closest('button')?.click();
        const visible = await wait(() => document.body.innerText.includes('旧 Agent API 配置无法解析'));
        const result = {
          visible: !!visible,
          rawPreserved: localStorage.getItem('mana-agent-api-config-v2') === '{malformed',
          markerAbsent: localStorage.getItem('mana-model-config-v4-local-migrated') === null,
        };
        localStorage.removeItem('mana-agent-api-config-v2');
        localStorage.setItem('mana-model-config-v4-local-migrated', '1');
        document.querySelector('[data-testid="model-center"] svg.lucide-refresh-cw')?.closest('button')?.click();
        await wait(() => !document.body.innerText.includes('旧 Agent API 配置无法解析'));
        return result;
      })()
    `);
    if (malformedLegacy.visible && malformedLegacy.rawPreserved && malformedLegacy.markerAbsent) pass('MCUI_T2B_malformed_legacy_is_preserved', JSON.stringify(malformedLegacy));
    else fail('MCUI_T2B_malformed_legacy_is_preserved', JSON.stringify(malformedLegacy));
    await screenshot('model-center-v5-overview.png');

    const originalFetch = global.fetch;
    const discoveryRequests = [];
    global.fetch = async (url, options) => {
      discoveryRequests.push({ url: String(url), authorization: options?.headers?.Authorization || '' });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: [{
            id: 'ui-test-model',
            display_name: 'UI Test Model',
            context_window: 256000,
            max_output_tokens: 16384,
            supported_parameters: ['tools', 'reasoning', 'response_format'],
            architecture: { input_modalities: ['text', 'image'] },
          }],
        }),
      };
    };
    const providerDetected = await evaluate(`
      (async () => {
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const wait = async (fn, timeout = 8000) => { const start = Date.now(); while (Date.now() - start < timeout) { const value = fn(); if (value) return value; await sleep(80); } return null; };
        const clickText = (text) => { const button = Array.from(document.querySelectorAll('button')).find((item) => item.textContent.trim() === text); if (button) button.click(); return !!button; };
        clickText('API 连接'); await sleep(100); clickText('新增 Provider');
        const editor = await wait(() => document.querySelector('[data-testid="provider-editor"]'));
        const inputs = Array.from(editor?.querySelectorAll('input') || []);
        const byPlaceholder = (placeholder) => inputs.find((input) => input.placeholder === placeholder);
        const set = (input, value) => { if (!input) return false; const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); return true; };
        const named = set(inputs.find((input) => input.type === 'text' && !input.placeholder), 'UI Test Provider');
        const base = set(byPlaceholder('https://api.example.com/v1'), 'https://ui-test.invalid/v1/chat/completions');
        const password = set(document.querySelector('input[type="password"]'), 'ui-test-secret');
        await sleep(50);
        const detected = clickText('自动检测');
        const preview = await wait(() => document.body.innerText.includes('发现 1 个模型') && document.body.innerText.includes('上下文 256,000'));
        const capabilityBadges = ['推理', '工具', '视觉', '结构化输出'].every((label) => document.body.innerText.includes(label));
        return { ok: !!preview && capabilityBadges, named, base, password, detected, preview: !!preview, capabilityBadges, body: (document.body.innerText || '').slice(-1000) };
      })()
    `);
    await screenshot('model-center-v5-provider-discovery.png');
    const providerCreated = await evaluate(`
      (async () => {
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const wait = async (fn, timeout = 8000) => { const start = Date.now(); while (Date.now() - start < timeout) { const value = fn(); if (value) return value; await sleep(80); } return null; };
        const clickText = (text) => { const button = Array.from(document.querySelectorAll('button')).find((item) => item.textContent.trim() === text); if (button) button.click(); return !!button; };
        const applied = clickText('应用发现结果');
        await sleep(80);
        const saved = clickText('保存 Provider');
        const visible = await wait(() => document.body.innerText.includes('Provider 已保存') && document.body.innerText.includes('UI Test Provider'));
        return { ok: !!visible, applied, saved, body: (document.body.innerText || '').slice(-1000) };
      })()
    `);
    global.fetch = originalFetch;
    if (providerDetected.ok && providerCreated.ok && discoveryRequests[0]?.url === 'https://ui-test.invalid/v1/models' && discoveryRequests[0]?.authorization === 'Bearer ui-test-secret') pass('MCUI_T3_provider_create_flow', '草稿 URL/Key→自动检测→能力预览→回填→保存完整可见');
    else fail('MCUI_T3_provider_create_flow', JSON.stringify({ providerDetected, providerCreated, discoveryRequests }));
    await screenshot('model-center-v5-providers.png');

    const configRaw = await fs.readFile(path.join(process.env.MANA_USER_DATA_ROOT, 'model-config.json'), 'utf8');
    const secretRaw = await fs.readFile(path.join(process.env.MANA_USER_DATA_ROOT, 'secrets.json'), 'utf8');
    // The desktop product deliberately keeps provider keys in the local
    // private secrets file.  Do not use macOS Keychain/safeStorage here: the
    // user explicitly chose local plaintext storage.  The public model
    // configuration must still never contain the key.
    if (!configRaw.includes('ui-test-secret') && secretRaw.includes('ui-test-secret')) pass('MCUI_T4_secret_stays_out_of_public_config', '密钥仅存在本地私有 secrets.json，未进入公开模型配置');
    else fail('MCUI_T4_secret_stays_out_of_public_config', '密钥未按本地私有存储契约保存');

    const profileAndAssignment = await evaluate(`
      (async () => {
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const wait = async (fn, timeout = 8000) => { const start = Date.now(); while (Date.now() - start < timeout) { const value = fn(); if (value) return value; await sleep(80); } return null; };
        const button = (text) => Array.from(document.querySelectorAll('button')).find((item) => item.textContent.trim() === text);
        button('写作档案')?.click(); await sleep(100); button('新增档案')?.click();
        const editor = await wait(() => document.querySelector('[data-testid="profile-editor"]'));
        const inputs = Array.from(editor?.querySelectorAll('input') || []);
        const set = (input, value) => { if (!input) return false; const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); return true; };
        const firstText = inputs.find((input) => input.type === 'text' && !input.placeholder);
        set(firstText, 'UI 长篇写作');
        const temperatureInput = editor?.querySelector('input[aria-label="主模型 Temperature"]');
        const temperatureVisible = !!temperatureInput;
        set(temperatureInput, '0.35');
        const selects = Array.from(document.querySelectorAll('select'));
        const providerSelect = selects.find((select) => Array.from(select.options).some((option) => option.textContent === 'UI Test Provider'));
        if (providerSelect) { providerSelect.value = 'ui-test-provider'; providerSelect.dispatchEvent(new Event('change', { bubbles: true })); }
        await sleep(80);
        const modelSelect = Array.from(document.querySelectorAll('select')).find((select) => Array.from(select.options).some((option) => option.value === 'ui-test-model'));
        if (modelSelect) { modelSelect.value = 'ui-test-model'; modelSelect.dispatchEvent(new Event('change', { bubbles: true })); }
        await sleep(80);
        const thinkingToggle = editor?.querySelector('input[aria-label="主模型启用思考"]');
        const effortSelect = editor?.querySelector('select[aria-label="主模型思考强度"]');
        if (effortSelect) { effortSelect.value = 'max'; effortSelect.dispatchEvent(new Event('change', { bubbles: true })); }
        button('保存档案')?.click();
        const profileSaved = await wait(() => document.body.innerText.includes('模型档案已保存') && document.body.innerText.includes('UI 长篇写作'));
        button('用途分配')?.click(); await sleep(100);
        const assign = (label) => {
          const row = Array.from(document.querySelectorAll('div')).find((div) => div.textContent.trim().startsWith(label) && div.querySelector('select'));
          const select = row?.querySelector('select');
          const option = select && Array.from(select.options).find((item) => item.textContent === 'UI 长篇写作');
          if (select && option) { select.value = option.value; select.dispatchEvent(new Event('change', { bubbles: true })); }
          return option?.value || '';
        };
        const profileOption = assign('主聊天');
        const orchestrationOption = assign('聊天编排（Agent）');
        button('保存分配')?.click();
        const routingSaved = await wait(() => document.body.innerText.includes('模型分配已保存'));
        return { ok: !!profileSaved && !!routingSaved && temperatureVisible && !!thinkingToggle?.checked && effortSelect?.value === 'max' && !!profileOption && !!orchestrationOption, temperatureVisible, thinking: !!thinkingToggle?.checked, effort: effortSelect?.value || '', profile: profileOption, orchestrationProfile: orchestrationOption, body: (document.body.innerText || '').slice(0, 1000) };
      })()
    `);
    if (profileAndAssignment.ok) pass('MCUI_T5_profile_assignment_flow', profileAndAssignment.profile);
    else fail('MCUI_T5_profile_assignment_flow', JSON.stringify(profileAndAssignment));

    const modelConfig = require(path.join(ROOT, 'src/main/modelConfig'));
    const preview = await modelConfig.resolvePreview({ driverId: 'direct-api', systemTask: 'chat-orchestration' });
    if (preview[0]?.modelId === 'ui-test-model' && preview[0]?.params?.temperature === 0.35 && preview[0]?.params?.thinking === true && preview[0]?.params?.effortLevel === 'max') pass('MCUI_T6_runtime_preview_matches_ui', JSON.stringify(preview[0]));
    else fail('MCUI_T6_runtime_preview_matches_ui', JSON.stringify(preview));

    const assignmentShot = await screenshot('model-center-v5-assignments.png');
    const dom = await evaluate(`(() => ({
      hasHorizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 2,
      hasError: /IPC 不可用|Cannot read|undefined is not/.test(document.body.innerText),
      visibleButtons: Array.from(document.querySelectorAll('button')).filter((button) => button.offsetParent !== null).map((button) => button.textContent.trim()).filter(Boolean).slice(0, 30),
    }))()`);
    if (!dom.hasHorizontalOverflow && !dom.hasError) pass('MCUI_B1_layout_and_error_state', JSON.stringify(dom));
    else fail('MCUI_B1_layout_and_error_state', JSON.stringify(dom));
    console.log(`TEST_SCREENSHOT ${assignmentShot}`);
  } catch (err) {
    fail('MCUI_HARNESS', err.stack || err.message || String(err));
  }

  console.log(`TEST_SUMMARY ${results.passed}/${results.total} passed, ${results.failed} failed`);
  console.log('TEST_DONE');
  return results;
}

module.exports = { runModelCenterUiRegressionTest };
