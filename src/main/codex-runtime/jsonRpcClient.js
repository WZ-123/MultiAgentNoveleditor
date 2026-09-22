'use strict';

const { EventEmitter } = require('node:events');
const { contractError } = require('./contracts');

class JsonRpcClient extends EventEmitter {
  constructor({ readable, writable, maxFrameBytes = 16 * 1024 * 1024, requestTimeoutMs = 30_000, requestHandler } = {}) {
    super();
    if (!readable || !writable) throw contractError('JSON-RPC readable and writable streams are required');
    this.readable = readable;
    this.writable = writable;
    this.maxFrameBytes = maxFrameBytes;
    this.requestTimeoutMs = requestTimeoutMs;
    this.requestHandler = requestHandler;
    this.nextId = 1;
    this.buffer = '';
    this.pending = new Map();
    this.closed = false;
    this.seenResponseIds = new Set();
    readable.setEncoding?.('utf8');
    readable.on('data', (chunk) => this._consume(String(chunk || '')));
    readable.on('end', () => this.close(contractError('Codex App Server stdout ended', 'runtime_interrupted')));
    readable.on('error', (error) => this.close(error));
    writable.on?.('error', (error) => this.close(error));
  }

  _write(message) {
    if (this.closed || !this.writable.writable) throw contractError('Codex App Server transport is not writable', 'runtime_unavailable');
    this.writable.write(`${JSON.stringify(message)}\n`);
  }

  _consume(chunk) {
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer, 'utf8') > this.maxFrameBytes) {
      this.close(contractError('Codex App Server JSONL frame exceeds the configured limit'));
      return;
    }
    while (true) {
      const newline = this.buffer.indexOf('\n');
      if (newline < 0) break;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); }
      catch (error) {
        this.close(contractError(`invalid Codex App Server JSONL frame: ${error.message}`));
        return;
      }
      this._dispatch(message);
    }
  }

  _dispatch(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      this.close(contractError('Codex App Server emitted a non-object frame'));
      return;
    }
    if (message.method && message.id != null) {
      this._handleServerRequest(message);
      return;
    }
    if (message.method) {
      this.emit('notification', message);
      return;
    }
    if (message.id == null) {
      this.close(contractError('Codex App Server response has no id or method'));
      return;
    }
    if (this.seenResponseIds.has(message.id)) {
      this.emit('protocolError', contractError(`duplicate Codex App Server response id: ${message.id}`));
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) {
      this.emit('protocolError', contractError(`unknown Codex App Server response id: ${message.id}`));
      return;
    }
    this.seenResponseIds.add(message.id);
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) {
      const error = contractError(message.error.message || 'Codex App Server request failed');
      error.rpcCode = message.error.code;
      error.details = message.error.data;
      pending.reject(error);
    } else pending.resolve(message.result);
  }

  async _handleServerRequest(message) {
    if (typeof this.requestHandler !== 'function') {
      this._write({ id: message.id, error: { code: -32601, message: `unsupported server request: ${message.method}` } });
      this.emit('serverRequestRejected', { method: message.method, id: message.id });
      return;
    }
    try {
      const result = await this.requestHandler(message.method, message.params, message);
      this._write({ id: message.id, result: result == null ? {} : result });
    } catch (error) {
      this._write({ id: message.id, error: { code: Number(error?.rpcCode) || -32000, message: error?.message || 'server request rejected' } });
    }
  }

  request(method, params = {}, options = {}) {
    if (!String(method || '').trim()) return Promise.reject(contractError('JSON-RPC method is required'));
    const id = this.nextId++;
    const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : this.requestTimeoutMs;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(contractError(`Codex App Server request timed out: ${method}`, 'runtime_unavailable'));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { method, resolve, reject, timer });
      try { this._write({ id, method, params }); }
      catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  notify(method, params = {}) {
    this._write({ method, params });
  }

  close(cause = contractError('Codex App Server transport closed', 'runtime_interrupted')) {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(cause);
    }
    this.pending.clear();
    this.emit('close', cause);
  }
}

module.exports = { JsonRpcClient };
