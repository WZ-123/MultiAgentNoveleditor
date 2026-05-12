'use strict';

/**
 * Custom MCP client transport that wraps an already-forked child process.
 *
 * Why not the SDK's built-in StdioClientTransport?
 *   StdioClientTransport spawns its own child via cross-spawn with
 *   `stdio: ['pipe', 'pipe', stderr]` — only 3 fds. We need a 4th IPC fd
 *   for the parent ↔ child control protocol (set-active-novel,
 *   confirm-request / confirm-response). So we fork separately with
 *   `stdio: ['pipe', 'pipe', 'pipe', 'ipc']` and feed the child's
 *   stdio[0]/stdio[1] streams into this transport.
 *
 * Implements the MCP Transport interface: start / send / close + onmessage /
 * onerror / onclose callbacks.
 */

const { ReadBuffer, serializeMessage } = require('@modelcontextprotocol/sdk/shared/stdio.js');

class ForkChildTransport {
  /**
   * @param {{ stdin: NodeJS.WritableStream, stdout: NodeJS.ReadableStream }} streams
   */
  constructor({ stdin, stdout }) {
    if (!stdin || !stdout) {
      throw new Error('ForkChildTransport: stdin and stdout are required');
    }
    this._stdin = stdin;
    this._stdout = stdout;
    this._readBuffer = new ReadBuffer();
    this._started = false;

    this._ondata = (chunk) => {
      this._readBuffer.append(chunk);
      this._processReadBuffer();
    };
    this._onerror = (err) => {
      this.onerror?.(err);
    };
    this._onstdoutClose = () => {
      this.onclose?.();
    };
  }

  async start() {
    if (this._started) {
      throw new Error('ForkChildTransport already started');
    }
    this._started = true;
    this._stdout.on('data', this._ondata);
    this._stdout.on('error', this._onerror);
    this._stdout.on('close', this._onstdoutClose);
  }

  _processReadBuffer() {
    while (true) {
      try {
        const message = this._readBuffer.readMessage();
        if (message === null) break;
        this.onmessage?.(message);
      } catch (err) {
        this.onerror?.(err);
      }
    }
  }

  async send(message) {
    return new Promise((resolve, reject) => {
      const json = serializeMessage(message);
      const ok = this._stdin.write(json, (err) => {
        if (err) reject(err);
      });
      if (ok) resolve();
      else this._stdin.once('drain', resolve);
    });
  }

  async close() {
    if (this._stdout) {
      this._stdout.off('data', this._ondata);
      this._stdout.off('error', this._onerror);
      this._stdout.off('close', this._onstdoutClose);
    }
    this._readBuffer.clear();
    this.onclose?.();
  }
}

module.exports = { ForkChildTransport };
