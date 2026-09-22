'use strict';

const crypto = require('node:crypto');

const LEGACY_CODES = Object.freeze({
  network_error: 'relay_unreachable',
  timeout: 'relay_timeout',
  missing_relay_config: 'relay_config_missing',
  release_config_missing: 'relay_config_missing',
  release_config_invalid: 'relay_config_invalid',
  invalid_code: 'auth_invalid',
  expired: 'auth_expired',
  license_revoked: 'auth_revoked',
  device_limit_reached: 'auth_device_limit',
  rate_limited: 'auth_rate_limited',
  auth_failed: 'auth_invalid',
});

const DEFINITIONS = Object.freeze({
  no_auth_code: ['auth', false, 'reauthenticate', '未配置授权码，请输入有效授权码后重试。'],
  auth_invalid: ['auth', false, 'reauthenticate', '授权码或设备授权无效，请重新验证。'],
  auth_expired: ['auth', false, 'reauthenticate', '授权已过期，请重新验证。'],
  auth_revoked: ['auth', false, 'reauthenticate', '授权已被吊销，请联系管理员。'],
  auth_device_limit: ['auth', false, 'reauthenticate', '授权设备数量已达上限。'],
  auth_rate_limited: ['auth', true, 'retry', '验证请求过于频繁，请稍后重试。'],
  secure_storage_unavailable: ['auth', false, 'report', '本地凭据存储不可用，无法保存授权信息。'],
  relay_config_missing: ['relay', false, 'configure_relay', '认证服务配置缺失，请安装完整的正式版本。'],
  relay_config_invalid: ['relay', false, 'configure_relay', '认证服务配置无效，请更新应用。'],
  relay_timeout: ['relay', true, 'retry', '服务响应超时，请稍后重试。'],
  relay_unreachable: ['relay', true, 'retry', '无法连接服务，请检查网络后重试。'],
  relay_response_invalid: ['relay', true, 'retry', '服务返回了无法识别的响应，请稍后重试。'],
  relay_unavailable: ['relay', true, 'retry', '反馈服务暂时不可用，请稍后重试。'],
  relay_rate_limited: ['relay', true, 'retry', '反馈提交过于频繁，请稍后重试。'],
  upgrade_required: ['auth', false, 'report', '当前版本已停止服务，请更新应用。'],
  provider_protocol_mismatch: ['provider', false, 'switch_model', '模型返回了不兼容的工具调用格式。'],
  provider_state_lost: ['provider', true, 'resume', '模型续轮状态已丢失，可从检查点继续。'],
  generation_incomplete: ['provider', true, 'resume', '模型输出未完成，可从检查点继续。'],
});

function diagnosticId(value) {
  return String(value || `diag-${crypto.randomUUID()}`);
}

function reasonKind(error) {
  const code = String(error?.code || '');
  const message = String(error?.message || '');
  if (/ETIMEDOUT|timeout|AbortError/iu.test(`${code} ${error?.name || ''} ${message}`)) return 'timeout';
  if (/ENOTFOUND|EAI_AGAIN/iu.test(`${code} ${message}`)) return 'dns';
  if (/ECONNREFUSED/iu.test(`${code} ${message}`)) return 'refused';
  if (/ECONNRESET|socket hang up/iu.test(`${code} ${message}`)) return 'reset';
  if (/CERT|TLS|SSL/iu.test(`${code} ${message}`)) return 'tls';
  return '';
}

function canonicalCode(error, context = {}) {
  const raw = String(error?.code || context.code || '').trim();
  if (raw === 'rate_limited' && context.domain === 'relay') return 'relay_rate_limited';
  if (LEGACY_CODES[raw]) return LEGACY_CODES[raw];
  if (DEFINITIONS[raw]) return raw;
  if (context.domain === 'relay' || context.phase === 'relay') return reasonKind(error) === 'timeout' ? 'relay_timeout' : 'relay_unreachable';
  if (context.domain === 'auth' || context.phase === 'auth_exchange') return reasonKind(error) === 'timeout' ? 'relay_timeout' : 'relay_unreachable';
  return raw || 'relay_response_invalid';
}

function normalizeAppError(error, context = {}) {
  const code = canonicalCode(error, context);
  const definition = DEFINITIONS[code] || [context.domain || 'runtime', context.retryable === true, context.userAction || 'report', '操作未能完成。'];
  const [defaultDomain, defaultRetryable, defaultAction, defaultMessage] = definition;
  return {
    schemaVersion: 1,
    domain: context.domain || defaultDomain,
    code,
    phase: String(context.phase || ''),
    retryable: context.retryable == null ? defaultRetryable : context.retryable === true,
    userAction: context.userAction || defaultAction,
    message: context.message || defaultMessage,
    diagnosticId: diagnosticId(context.diagnosticId || error?.diagnosticId),
    ...(Number.isInteger(context.httpStatus || error?.httpStatus) ? { httpStatus: Number(context.httpStatus || error.httpStatus) } : {}),
    ...(Number.isInteger(context.providerStatus || error?.providerStatus) ? { providerStatus: Number(context.providerStatus || error.providerStatus) } : {}),
    ...(context.reasonKind || reasonKind(error) ? { reasonKind: context.reasonKind || reasonKind(error) } : {}),
    ...(error?.causeCode ? { causeCode: String(error.causeCode) } : {}),
  };
}

function appError(error, context = {}) {
  const normalized = normalizeAppError(error, context);
  return Object.assign(new Error(normalized.message), normalized, { appError: normalized });
}

function userMessage(code, details = {}) {
  return normalizeAppError({ code }, details).message;
}

module.exports = { LEGACY_CODES, appError, canonicalCode, normalizeAppError, userMessage };
