'use strict';

function pad2(value) {
  return String(value).padStart(2, '0');
}

function formatOffset(offsetMinutes) {
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMinutes);
  const hours = Math.floor(abs / 60);
  const minutes = abs % 60;
  return `${sign}${pad2(hours)}:${pad2(minutes)}`;
}

function toLocalIso(date = new Date()) {
  const offsetMinutes = -date.getTimezoneOffset();
  return [
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`,
    `T${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}${formatOffset(offsetMinutes)}`,
  ].join('');
}

function getSystemTimeInfo(now = new Date()) {
  let timezone = 'system';
  try {
    timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || timezone;
  } catch {
    // ignore timezone detection failures
  }
  return {
    epochMs: now.getTime(),
    isoUtc: now.toISOString(),
    isoLocal: toLocalIso(now),
    timezone,
    offsetMinutes: -now.getTimezoneOffset(),
    display: now.toString(),
  };
}

function buildSystemTimePromptBlock() {
  const info = getSystemTimeInfo();
  return [
    '## Current System Time',
    `- Local system time: ${info.isoLocal}`,
    `- Time zone: ${info.timezone} (offset ${formatOffset(info.offsetMinutes)})`,
    '- When date/time matters, use this local system time baseline. Do not assume GMT/UTC unless the user explicitly asks for it.',
  ].join('\n');
}

module.exports = {
  getSystemTimeInfo,
  buildSystemTimePromptBlock,
  toLocalIso,
};
