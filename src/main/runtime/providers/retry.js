'use strict';

const RETRY_MAX = 3;
const RETRY_BASE_MS = 1000;
const REQUEST_TIMEOUT_MS = 120_000; // 2 min per-attempt timeout

function isRetryableHttpStatus(status) {
  return status === 429 || status >= 500;
}

function sleepWithAbort(ms, abortSignal) {
  if (abortSignal?.aborted) throw new DOMException('aborted', 'AbortError');
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (abortSignal) {
      abortSignal.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new DOMException('aborted', 'AbortError'));
      }, { once: true });
    }
  });
}

function raceAbortSignal(ms, callerSignal) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new DOMException('timeout', 'TimeoutError')), ms);
  if (callerSignal) {
    if (callerSignal.aborted) {
      clearTimeout(timer);
      ac.abort(callerSignal.reason || new DOMException('aborted', 'AbortError'));
    } else {
      callerSignal.addEventListener('abort', () => {
        clearTimeout(timer);
        ac.abort(callerSignal.reason || new DOMException('aborted', 'AbortError'));
      }, { once: true });
    }
  }
  return { signal: ac.signal, cleanup: () => { clearTimeout(timer); } };
}

async function fetchWithRetry(url, fetchOpts, label, abortSignal) {
  let lastErr;
  for (let attempt = 0; attempt <= RETRY_MAX; attempt++) {
    if (abortSignal?.aborted) throw new DOMException('aborted', 'AbortError');
    const { signal: effectiveSignal, cleanup } = raceAbortSignal(REQUEST_TIMEOUT_MS, abortSignal);
    try {
      const res = await fetch(url, { ...fetchOpts, signal: effectiveSignal });
      cleanup();
      if (res.ok) return res;
      const text = await res.text().catch(() => '');
      const err = new Error(`${label} ${res.status}: ${text.slice(0, 500)}`);
      err.httpStatus = res.status;
      throw err;
    } catch (err) {
      cleanup();
      lastErr = err;
      // Don't retry on user-initiated abort
      if (err.name === 'AbortError') throw err;
      // Timeout is retryable
      if (err.name === 'TimeoutError') {
        if (attempt < RETRY_MAX) {
          console.warn(`[provider:retry] ${label} attempt ${attempt + 1} timed out after ${REQUEST_TIMEOUT_MS}ms, retrying...`);
          await sleepWithAbort(RETRY_BASE_MS * Math.pow(2, attempt), abortSignal);
          continue;
        }
        throw err;
      }
      // Don't retry non-retryable HTTP errors
      if (err.httpStatus && !isRetryableHttpStatus(err.httpStatus)) throw err;
      // Retry with backoff if attempts remain
      if (attempt < RETRY_MAX) {
        const delay = RETRY_BASE_MS * Math.pow(2, attempt);
        console.warn(`[provider:retry] ${label} attempt ${attempt + 1} failed, retrying in ${delay}ms:`, err.message);
        await sleepWithAbort(delay, abortSignal);
        continue;
      }
    }
  }
  throw lastErr;
}

module.exports = { fetchWithRetry, isRetryableHttpStatus };
