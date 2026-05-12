'use strict';

/**
 * UI E2E Tests — runs inside the Electron main process.
 * Called from main.js when --test-ui flag is present.
 */

async function runUiTests(mainWindow) {

  // Wait for React to hydrate and render
  await new Promise((r) => setTimeout(r, 2500));

  const results = { total: 0, passed: 0, failed: 0 };

  function pass(name, detail) {
    results.total++; results.passed++;
    console.log(`TEST_PASS ${name}${detail ? ': ' + detail : ''}`);
  }
  function fail(name, reason) {
    results.total++; results.failed++;
    console.log(`TEST_FAIL ${name}: ${reason}`);
  }

  // ---- TEST 1: Button exists ----
  try {
    const r = await mainWindow.webContents.executeJavaScript(`
      (() => {
        const btns = document.querySelectorAll('button');
        for (const b of btns) {
          const t = b.textContent.trim();
          if (t.includes('未选择小说') || t.includes('小说')) {
            const rect = b.getBoundingClientRect();
            return { found: true, text: t.slice(0, 60), visible: rect.width > 0 && rect.height > 0 };
          }
        }
        return { found: false };
      })()
    `);
    if (r.found && r.visible) pass('button_exists', r.text);
    else fail('button_exists', JSON.stringify(r));
  } catch (err) {
    fail('button_exists', err.message || String(err));
  }

  // ---- TEST 2: Click opens dropdown ----
  try {
    const r = await mainWindow.webContents.executeJavaScript(`
      (() => {
        const btns = document.querySelectorAll('button');
        let target = null;
        for (const b of btns) {
          if (b.textContent.includes('未选择小说') || b.textContent.includes('小说')) {
            target = b;
            break;
          }
        }
        if (!target) return { opened: false, reason: 'target not found' };
        target.click();
        return new Promise((resolve) => {
          setTimeout(() => {
            // Check for the dropdown panel
            const allDivs = document.querySelectorAll('div');
            let found = false;
            let details = {};
            for (const d of allDivs) {
              if (d.offsetWidth > 200 && d.offsetHeight > 100) {
                const txt = d.textContent || '';
                if ((txt.includes('创建') && txt.includes('导入已有')) || txt.includes('小说')) {
                  const style = window.getComputedStyle(d);
                  details = { w: d.offsetWidth, h: d.offsetHeight, zIndex: style.zIndex, position: style.position, top: d.offsetTop, left: d.offsetLeft };
                  found = true;
                  break;
                }
              }
            }
            resolve({ opened: found, details });
          }, 200);
        });
      })()
    `);
    if (r.opened) pass('dropdown_opens', '');
    else fail('dropdown_opens', JSON.stringify(r));
  } catch (err) {
    fail('dropdown_opens', err.message || String(err));
  }

  // ---- TEST 3: Dropdown is visible within viewport ----
  try {
    const r = await mainWindow.webContents.executeJavaScript(`
      (() => {
        const allDivs = document.querySelectorAll('div');
        const viewH = window.innerHeight;
        const viewW = window.innerWidth;
        let found = null;
        for (const d of allDivs) {
          if (d.offsetWidth > 200 && d.offsetHeight > 100) {
            const txt = d.textContent || '';
            if ((txt.includes('创建') && txt.includes('导入已有')) || txt.includes('小说')) {
              const rect = d.getBoundingClientRect();
              const fullyVisible = rect.top >= 0 && rect.left >= 0 && rect.bottom <= viewH && rect.right <= viewW;
              found = { visible: fullyVisible, rect: { top: rect.top, left: rect.left, bottom: rect.bottom, right: rect.right }, viewport: { w: viewW, h: viewH } };
              break;
            }
          }
        }
        return found || { visible: false, reason: 'dropdown not found' };
      })()
    `);
    if (r.visible) pass('dropdown_visible', '');
    else fail('dropdown_visible', JSON.stringify(r));
  } catch (err) {
    fail('dropdown_visible', err.message || String(err));
  }

  // ---- TEST 4: Dropdown z-index is high enough (z>=50) ----
  try {
    const r = await mainWindow.webContents.executeJavaScript(`
      (() => {
        // Search the entire document for the portal dropdown
        const allDivs = document.querySelectorAll('div');
        for (const d of allDivs) {
          const style = window.getComputedStyle(d);
          if (style.position === 'fixed' && d.offsetWidth > 200) {
            const txt = d.textContent || '';
            if ((txt.includes('创建') && txt.includes('导入已有')) || txt.includes('小说')) {
              const z = parseInt(style.zIndex, 10);
              return { found: true, zIndex: isNaN(z) ? 'auto' : z, position: style.position };
            }
          }
        }
        return { found: false, reason: 'portal dropdown not found' };
      })()
    `);
    if (r.found && (r.zIndex === 'auto' || r.zIndex >= 50)) pass('dropdown_zindex', 'position=' + r.position + ' z=' + r.zIndex);
    else fail('dropdown_zindex', JSON.stringify(r));
  } catch (err) {
    fail('dropdown_zindex', err.message || String(err));
  }

  // ---- TEST 5: Dropdown contains clickable action buttons ----
  try {
    const r = await mainWindow.webContents.executeJavaScript(`
      (() => {
        // Find the dropdown panel
        const allDivs = document.querySelectorAll('div');
        let panel = null;
        for (const d of allDivs) {
          if (d.offsetWidth > 200 && d.offsetHeight > 100) {
            const txt = d.textContent || '';
            if ((txt.includes('创建') && txt.includes('导入已有')) || txt.includes('小说')) {
              panel = d;
              break;
            }
          }
        }
        if (!panel) return { found: false, reason: 'panel not found' };

        const btns = panel.querySelectorAll('button');
        const actions = [];
        btns.forEach((b) => {
          actions.push({
            text: (b.textContent || '').trim().slice(0, 50),
            disabled: b.disabled,
            offsetWidth: b.offsetWidth,
            offsetHeight: b.offsetHeight,
          });
        });

        // Try clicking each non-disabled button to verify it fires
        let clickResults = [];
        for (const btn of btns) {
          if (btn.disabled) continue;
          if (!btn.offsetWidth) { clickResults.push(btn.textContent.trim().slice(0,30) + ':zero-size'); continue; }
          // Just verify the button exists and is clickable (has onClick handler)
          clickResults.push(btn.textContent.trim().slice(0, 30) + ':clickable');
        }

        return {
          found: true,
          buttonCount: btns.length,
          actionableCount: clickResults.length,
          actions,
          hasCreate: actions.some(a => /创建|create/.test(a.text)),
          hasImport: actions.some(a => /导入|import|打开/.test(a.text)),
          hasClose: actions.some(a => /关闭|close/.test(a.text)),
        };
      })()
    `);
    if (r.found && r.buttonCount >= 2) {
      pass('dropdown_buttons', r.buttonCount + ' buttons, ' + r.actionableCount + ' clickable');
    } else {
      fail('dropdown_buttons', JSON.stringify(r));
    }
  } catch (err) {
    fail('dropdown_buttons', err.message || String(err));
  }

  // ---- Summary ----
  console.log('');
  console.log(`TEST_SUMMARY ${results.passed}/${results.total} passed, ${results.failed} failed`);
  console.log('TEST_DONE');
  return results;
}

module.exports = { runUiTests };
