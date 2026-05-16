'use strict';

/**
 * Maps a feedback payload to Feishu Bitable field objects.
 *
 * Design principle: flatten only fields useful for filtering/sorting;
 * keep the full payload as a JSON string attachment for deep debugging.
 */

function truncate(value, limit = 500) {
  const text = typeof value === 'string' ? value : value == null ? '' : String(value);
  if (!text || text.length <= limit) return text;
  return `${text.slice(0, limit)}...`;
}

function safeString(value) {
  if (value == null) return '';
  return String(value);
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function formatTimestampToUtcPlus8(value) {
  if (value == null || value === '') return '';
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return safeString(value);

  const utcPlus8 = new Date(timestamp + 8 * 60 * 60 * 1000);
  const year = utcPlus8.getUTCFullYear();
  const month = pad2(utcPlus8.getUTCMonth() + 1);
  const day = pad2(utcPlus8.getUTCDate());
  const hours = pad2(utcPlus8.getUTCHours());
  const minutes = pad2(utcPlus8.getUTCMinutes());
  const seconds = pad2(utcPlus8.getUTCSeconds());
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds} +08:00`;
}

function toBitableFields(record) {
  const payload = record?.payload;
  if (!payload || typeof payload !== 'object') {
    return {};
  }

  const userInput = payload.userInput || {};
  const environment = payload.environment || {};
  const novelContext = payload.novelContext || {};
  const editorContext = payload.editorContext || {};
  const chatContext = payload.chatContext || {};
  const errors = payload.errors || {};

  const fields = {
    feedbackId: safeString(payload.feedbackId),
    createdAt: formatTimestampToUtcPlus8(payload.createdAt),
    issueTitle: truncate(userInput.issueTitle, 200),
    actualBehavior: truncate(userInput.actualBehavior, 1000),
    feedbackMode: safeString(userInput.feedbackMode),
    severity: safeString(userInput.severity),
    appVersion: safeString(environment.appVersion),
    platform: safeString(environment.platform),
    activeRuntimeDriver: safeString(environment.activeRuntimeDriver),
    activeProviderType: safeString(environment.activeProviderType),
    activeModel: safeString(environment.activeModel),
    activeNovelId: safeString(novelContext.activeNovelId),
    activeChapterName: truncate(editorContext.activeChapterName, 200),
    activeChapterTitle: truncate(editorContext.activeChapterTitle, 200),
    activeThreadId: safeString(chatContext.activeThread?.id),
    currentSessionId: safeString(chatContext.currentSessionId),
    currentSessionStatus: safeString(chatContext.currentSessionStatus),
    latestUiError: truncate(errors.latestUiError, 500),
    latestMainProcessError: truncate(errors.latestMainProcessError?.message || errors.latestMainProcessError, 500),
    latestChatAgentError: truncate(errors.latestChatAgentError?.message || errors.latestChatAgentError, 500),
    syncStatus: safeString(record.syncStatus),
    payloadJson: JSON.stringify(payload),
  };

  // Omit empty strings to keep the table cleaner
  for (const key of Object.keys(fields)) {
    if (fields[key] === '') {
      delete fields[key];
    }
  }

  return fields;
}

/**
 * Build attachment field value for Bitable.
 * Bitable attachment fields accept: [{ file_token }]
 */
function toAttachmentField(fileTokens) {
  const tokens = Array.isArray(fileTokens) ? fileTokens : [];
  return tokens.map((t) => ({ file_token: t }));
}

module.exports = { toBitableFields, toAttachmentField };
