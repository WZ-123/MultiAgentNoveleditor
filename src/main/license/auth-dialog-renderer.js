'use strict';

const input = document.getElementById('auth-code');
const verifyButton = document.getElementById('verify');
const quitButton = document.getElementById('quit');
const errorBox = document.getElementById('error');

function setBusy(busy) {
  input.disabled = busy;
  verifyButton.disabled = busy;
  quitButton.disabled = busy;
  verifyButton.textContent = busy ? '验证中…' : '验证';
}

async function submit() {
  const authCode = input.value.trim();
  if (!authCode) { errorBox.textContent = '请输入授权码。'; return; }
  errorBox.textContent = '';
  setBusy(true);
  try {
    const result = await window.authBridge.verify(authCode);
    if (!result?.valid) errorBox.textContent = result?.message || '授权验证未能完成。';
  } catch {
    errorBox.textContent = '授权验证未能完成，请稍后重试。';
  } finally {
    setBusy(false);
  }
}

verifyButton.addEventListener('click', submit);
quitButton.addEventListener('click', () => window.authBridge.quit());
input.addEventListener('keydown', (event) => { if (event.key === 'Enter') void submit(); });
