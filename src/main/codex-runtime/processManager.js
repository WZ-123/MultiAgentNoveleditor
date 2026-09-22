'use strict';

const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { paths } = require('../store/paths');
const { contractError } = require('./contracts');
const { JsonRpcClient } = require('./jsonRpcClient');
const { executablePath, readManifest, targetFor } = require('./runtimeManifest');

const DISABLED_FEATURES = Object.freeze([
  'apps', 'browser_use',
  'computer_use', 'connectors', 'goals', 'image_generation', 'in_app_browser',
  'memories', 'memory_tool', 'plugins', 'recommended_plugins',
  'remote_plugin', 'search_tool', 'shell_tool', 'skill_search', 'standalone_web_search',
  'tool_call_mcp_elicitation', 'view_image', 'web_search', 'web_search_cached', 'web_search_request',
]);

function tomlString(value) {
  return JSON.stringify(String(value));
}

function isolatedConfigToml({ modelCatalogPath = '' } = {}) {
  return [
    'approval_policy = "never"',
    'sandbox_mode = "read-only"',
    'web_search = "disabled"',
    'show_raw_agent_reasoning = false',
    'hide_agent_reasoning = true',
    'model_reasoning_summary = "none"',
    'include_apps_instructions = false',
    'include_environment_context = false',
    'include_permissions_instructions = false',
    'suppress_unstable_features_warning = true',
    ...(modelCatalogPath ? [`model_catalog_json = ${tomlString(modelCatalogPath)}`] : []),
    '',
    '[history]',
    'persistence = "save-all"',
    '',
    '[features]',
    'apply_patch_freeform = true',
    'apply_patch_streaming_events = true',
    'code_mode = true',
    ...DISABLED_FEATURES.map((name) => `${name} = false`),
    '',
    '[tools.experimental_request_user_input]',
    'enabled = false',
    '',
    '[tools.update_plan]',
    'enabled = false',
    '',
    '[skills]',
    'include_instructions = false',
    '',
    '[skills.bundled]',
    'enabled = false',
    '',
    '[plugins]',
    '',
  ].join('\n');
}

function restrictedEnvironment(extraEnv = {}) {
  const allow = ['PATH', 'SystemRoot', 'WINDIR', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY'];
  const env = {};
  for (const key of allow) if (process.env[key]) env[key] = process.env[key];
  for (const [key, value] of Object.entries(extraEnv)) if (value != null) env[key] = String(value);
  return env;
}

class CodexProcessManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this.spawnImpl = options.spawnImpl || spawn;
    this.binary = options.binary || null;
    this.runtimeRoot = options.runtimeRoot || null;
    this.extraEnv = options.extraEnv || {};
    this.modelCatalog = options.modelCatalog || null;
    this.requestHandler = options.requestHandler || null;
    this.handshakeTimeoutMs = options.handshakeTimeoutMs || 15_000;
    this.child = null;
    this.client = null;
    this.starting = null;
    this.stopping = false;
    this.codexHome = null;
    this.runDirectory = null;
    this.workspacesDirectory = null;
    this.stderrTail = '';
    this.handledChildren = new WeakSet();
    this.childSessions = new WeakMap();
  }

  async _prepareIsolation() {
    this.codexHome = path.join(paths().root, 'codex-home');
    await fsp.mkdir(this.codexHome, { recursive: true, mode: 0o700 });
    await fsp.chmod(this.codexHome, 0o700).catch(() => {});
    const runtimeId = crypto.createHash('sha256').update(path.resolve(paths().root)).digest('hex').slice(0, 16);
    const runtimeDirectory = path.join(os.tmpdir(), 'mana-codex-runtime', runtimeId);
    await fsp.mkdir(path.dirname(runtimeDirectory), { recursive: true, mode: 0o700 });
    await fsp.mkdir(runtimeDirectory, { recursive: true, mode: 0o700 });
    await fsp.chmod(runtimeDirectory, 0o700).catch(() => {});
    this.runDirectory = path.join(runtimeDirectory, 'readonly-cwd');
    await fsp.rm(this.runDirectory, { recursive: true, force: true });
    await fsp.mkdir(this.runDirectory, { recursive: true, mode: 0o500 });
    this.workspacesDirectory = path.join(runtimeDirectory, 'novel-workspaces');
    await fsp.mkdir(this.workspacesDirectory, { recursive: true, mode: 0o700 });
    const modelCatalogPath = path.join(this.codexHome, 'models.json');
    if (this.modelCatalog) await fsp.writeFile(modelCatalogPath, `${JSON.stringify(this.modelCatalog, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await fsp.writeFile(path.join(this.codexHome, 'config.toml'), isolatedConfigToml({ modelCatalogPath: this.modelCatalog ? modelCatalogPath : '' }), { encoding: 'utf8', mode: 0o600 });
  }

  async start() {
    if (this.client && !this.client.closed) return this.client;
    if (this.starting) return this.starting;
    this.starting = this._start();
    try { return await this.starting; }
    finally { this.starting = null; }
  }

  async _start() {
    await this._prepareIsolation();
    const manifest = readManifest();
    const target = targetFor();
    const binary = this.binary || executablePath({ root: this.runtimeRoot || undefined, packaged: !this.runtimeRoot });
    if (!fs.existsSync(binary)) throw contractError('Codex App Server sidecar is not installed; run npm run prepare:codex-runtime', 'runtime_unavailable', { binary });
    for (const companion of target.companions || []) {
      const companionPath = path.join(path.dirname(binary), companion);
      if (!fs.existsSync(companionPath)) throw contractError(`Codex runtime companion is missing: ${companion}`, 'runtime_incomplete', { binary, companion: companionPath, runtimeVersion: manifest.runtimeVersion });
    }
    const env = restrictedEnvironment({
      ...this.extraEnv,
      CODEX_HOME: this.codexHome,
      XDG_CONFIG_HOME: path.join(this.codexHome, 'xdg-config'),
      XDG_DATA_HOME: path.join(this.codexHome, 'xdg-data'),
    });
    this.stopping = false;
    this.stderrTail = '';
    this.child = this.spawnImpl(binary, [...(target.appServerArgs || []), '--listen', 'stdio://', '--strict-config'], {
      cwd: this.runDirectory,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    });
    this.child.stderr?.setEncoding?.('utf8');
    this.child.stderr?.on('data', (chunk) => { this.stderrTail = `${this.stderrTail}${String(chunk || '')}`.slice(-16_384); });
    this.client = new JsonRpcClient({
      readable: this.child.stdout,
      writable: this.child.stdin,
      requestTimeoutMs: this.handshakeTimeoutMs,
      requestHandler: (method, params, message) => {
        if (typeof this.requestHandler === 'function') return this.requestHandler(method, params, message);
        const error = contractError(`Codex App Server request is not allowed: ${method}`, 'runtime_protocol_mismatch');
        error.rpcCode = -32601;
        throw error;
      },
    });
    this.client.on('notification', (message) => this.emit('notification', message));
    this.client.on('protocolError', (error) => this.emit('protocolError', error));
    this.client.on('serverRequestRejected', (event) => this.emit('serverRequestRejected', event));
    const child = this.child;
    child.once('error', (error) => this._handleExit(child, error));
    child.once('close', (code, signal) => this._handleExit(child, contractError(`Codex App Server exited (code=${code ?? 'null'}, signal=${signal || 'none'})`, 'runtime_interrupted', { stderr: this.stderrTail })));
    const initialized = await this.client.request('initialize', {
      clientInfo: { name: 'multi-agent-novel-assistant', title: 'Mana Novel Runtime', version: '0.0.9' },
      capabilities: { experimentalApi: true },
    }, { timeoutMs: this.handshakeTimeoutMs });
    this.client.notify('initialized', {});
    this.emit('ready', { runtimeVersion: manifest.runtimeVersion, initialized });
    return this.client;
  }

  _handleExit(child, error) {
    if (!child || this.handledChildren.has(child)) return;
    this.handledChildren.add(child);
    if (child !== this.child) return;
    const intentional = this.stopping;
    this.client?.close(error);
    this.client = null;
    this.child = null;
    if (!intentional) this.emit('exit', error);
  }

  request(method, params, options) {
    if (!this.client || this.client.closed) return Promise.reject(contractError('Codex App Server is not running', 'runtime_unavailable'));
    return this.client.request(method, params, options);
  }

  notify(method, params) {
    if (!this.client || this.client.closed) throw contractError('Codex App Server is not running', 'runtime_unavailable');
    this.client.notify(method, params);
  }

  async stop({ forceAfterMs = 2_000 } = {}) {
    this.stopping = true;
    const child = this.child;
    if (!child) return;
    await new Promise((resolve) => {
      let settled = false;
      let timer = null;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve();
      };
      child.once('close', finish);
      timer = setTimeout(() => {
        try {
          if (process.platform === 'win32') child.kill('SIGKILL');
          else process.kill(-child.pid, 'SIGKILL');
        } catch { /* already gone */ }
        finish();
      }, forceAfterMs);
      timer.unref?.();
      try {
        if (process.platform === 'win32') child.kill();
        else process.kill(-child.pid, 'SIGTERM');
      } catch { try { child.kill('SIGTERM'); } catch { finish(); } }
    });
    this.client = null;
    this.child = null;
  }
}

module.exports = { CodexProcessManager, DISABLED_FEATURES, isolatedConfigToml, restrictedEnvironment, tomlString };
