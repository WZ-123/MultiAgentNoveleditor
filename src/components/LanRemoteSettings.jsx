import React, { useCallback, useEffect, useState } from 'react';
import { Copy, Power, RefreshCw, RotateCw, ShieldCheck, Wifi } from 'lucide-react';

const DEFAULT_PORT = 8788;

function statusPort(status) {
  return status?.configured?.port || status?.port || DEFAULT_PORT;
}

function statusEnabled(status) {
  return status?.configured?.enabled === true || status?.running === true;
}

export function LanRemoteSettings() {
  const mana = typeof window !== 'undefined' ? window.mana : null;
  const [status, setStatus] = useState(null);
  const [port, setPort] = useState(DEFAULT_PORT);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState('');

  const loadStatus = useCallback(async () => {
    if (!mana?.lanRemote?.getStatus) return;
    try {
      const next = await mana.lanRemote.getStatus();
      setStatus(next);
      setPort(statusPort(next));
      setError('');
    } catch (err) {
      setError(err?.message || String(err));
    }
  }, [mana]);

  useEffect(() => {
    loadStatus();
    const timer = window.setInterval(() => {
      loadStatus();
    }, 5000);
    return () => window.clearInterval(timer);
  }, [loadStatus]);

  const onToggle = useCallback(async () => {
    if (!mana?.lanRemote?.setEnabled) return;
    setBusy(true);
    setError('');
    try {
      const nextEnabled = !statusEnabled(status);
      const next = await mana.lanRemote.setEnabled(nextEnabled, port);
      setStatus(next);
      setPort(statusPort(next));
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setBusy(false);
    }
  }, [mana, port, status]);

  const onRotateCode = useCallback(async () => {
    if (!mana?.lanRemote?.rotateCode) return;
    setBusy(true);
    setError('');
    try {
      const next = await mana.lanRemote.rotateCode();
      setStatus(next);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setBusy(false);
    }
  }, [mana]);

  const onCopy = useCallback(async (text, key) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied(''), 1500);
    } catch {
      setCopied('');
    }
  }, []);

  const running = status?.running === true;
  const enabled = statusEnabled(status);
  const addresses = Array.isArray(status?.addresses) ? status.addresses : [];
  const hostnames = Array.isArray(status?.hostnames) ? status.hostnames : [];
  const accessCode = status?.accessCode || '';
  const isLanRemote = mana?.isLanRemote === true;
  const primaryUrl = status?.primaryUrl || hostnames[0]?.url || addresses[0]?.url || '';
  const ipv4Url = addresses[0]?.url || '';
  const lanTestUrl = addresses[0]?.testUrl || (primaryUrl ? `${primaryUrl}/api/lan/status` : '');

  const onCopyDiagnostics = useCallback(async () => {
    const lines = [
      'MultiAgentNovelAssistant LAN diagnostics',
      `running=${running}`,
      `port=${status?.port || port}`,
      `primaryUrl=${primaryUrl || ''}`,
      `ipv4Url=${ipv4Url || ''}`,
      `lanTestUrl=${lanTestUrl || ''}`,
      `loopbackUrl=${status?.loopbackUrl || ''}`,
      `updatedAt=${status?.updatedAt || ''}`,
      `hostnames=${hostnames.map((item) => item.url).join(', ')}`,
      `addresses=${addresses.map((item) => `${item.interfaceName || '?'} ${item.url}`).join(', ')}`,
      'status check should return 401 before login.',
      'If Mac can open the status URL but phone cannot, check Wi-Fi guest/client isolation or whether both devices are on the same LAN.',
    ];
    await onCopy(lines.join('\n'), 'diagnostics');
  }, [addresses, hostnames, ipv4Url, lanTestUrl, onCopy, port, primaryUrl, running, status]);

  return (
    <div className="text-xs space-y-4 max-w-2xl">
      <div className="flex items-start gap-2 text-blue-300 bg-blue-500/10 border border-blue-500/30 rounded p-3">
        <ShieldCheck size={15} className="shrink-0 mt-0.5" />
        <div className="leading-relaxed">
          <div className="font-semibold text-blue-200">Mac 本地执行，局域网设备遥控</div>
          <div className="text-blue-200/75 mt-0.5">
            远程浏览器需要访问码登录；原生文件选择器和项目目录导入仍需在 Mac 窗口完成。
          </div>
        </div>
      </div>

      <div className="border border-vscode-panel-border rounded p-3 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-gray-200 font-semibold">
            <Wifi size={15} />
            <span>局域网 Web 遥控</span>
          </div>
          <span className={running ? 'text-emerald-400' : enabled ? 'text-amber-400' : 'text-gray-500'}>
            {running ? '运行中' : enabled ? '未能启动' : '已关闭'}
          </span>
        </div>

        <label className="flex flex-col gap-1 max-w-[180px]">
          <span className="text-gray-500">监听端口</span>
          <input
            type="number"
            min={1024}
            max={65535}
            value={port}
            disabled={running || busy || isLanRemote}
            onChange={(event) => setPort(Number(event.target.value) || DEFAULT_PORT)}
            className="bg-vscode-sidebar border border-vscode-panel-border rounded px-2 py-1.5 text-gray-200 disabled:opacity-60"
          />
        </label>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={loadStatus}
            className="inline-flex items-center gap-1 px-3 py-1.5 rounded border border-vscode-panel-border text-gray-200 hover:bg-vscode-list-hoverBackground disabled:opacity-50"
          >
            <RotateCw size={13} />
            刷新状态
          </button>
          <button
            type="button"
            disabled={busy || isLanRemote}
            onClick={onToggle}
            className={`inline-flex items-center gap-1 px-3 py-1.5 rounded text-white disabled:opacity-60 ${
              running ? 'bg-rose-700 hover:bg-rose-600' : 'bg-blue-700 hover:bg-blue-600'
            }`}
          >
            <Power size={13} />
            {running ? '关闭遥控' : '开启遥控'}
          </button>
          <button
            type="button"
            disabled={busy || !running || isLanRemote}
            onClick={onRotateCode}
            className="inline-flex items-center gap-1 px-3 py-1.5 rounded border border-vscode-panel-border text-gray-200 hover:bg-vscode-list-hoverBackground disabled:opacity-50"
          >
            <RefreshCw size={13} />
            刷新访问码
          </button>
        </div>
        {isLanRemote ? (
          <div className="text-gray-500">
            远程端仅可查看连接状态；开启、关闭和刷新访问码请回到 Mac 桌面窗口操作。
          </div>
        ) : null}
        {status?.updatedAt ? (
          <div className="text-gray-600 text-[10px]">
            状态更新时间：{new Date(status.updatedAt).toLocaleTimeString()}
          </div>
        ) : null}
      </div>

      {running ? (
        <div className="border border-vscode-panel-border rounded p-3 space-y-3">
          <div>
            <div className="text-gray-500 mb-1">访问码</div>
            <div className="flex items-center gap-2">
              <code className="text-2xl tracking-[0.35em] text-gray-100 bg-vscode-sidebar border border-vscode-panel-border rounded px-3 py-2">
                {accessCode}
              </code>
              <button
                type="button"
                onClick={() => onCopy(accessCode, 'code')}
                className="inline-flex items-center gap-1 px-2 py-1 rounded border border-vscode-panel-border text-gray-300 hover:bg-vscode-list-hoverBackground"
              >
                <Copy size={12} />
                {copied === 'code' ? '已复制' : '复制'}
              </button>
            </div>
          </div>

          <div>
            <div className="text-gray-500 mb-1">推荐地址</div>
            {primaryUrl ? (
              <div className="flex flex-wrap items-center gap-2">
                <code className="text-emerald-200 bg-emerald-500/10 border border-emerald-500/30 rounded px-2 py-1">
                  {primaryUrl}
                </code>
                <button
                  type="button"
                  onClick={() => onCopy(primaryUrl, 'primary')}
                  className="inline-flex items-center gap-1 px-2 py-1 rounded border border-vscode-panel-border text-gray-300 hover:bg-vscode-list-hoverBackground"
                >
                  <Copy size={12} />
                  {copied === 'primary' ? '已复制' : '复制'}
                </button>
              </div>
            ) : (
              <div className="text-gray-500">未检测到可用地址</div>
            )}
            <div className="text-gray-500 text-[10px] mt-1">
              优先尝试 .local 地址；如果手机无法解析，再使用下面的 IPv4 地址。
            </div>
          </div>

          {hostnames.length ? (
            <div>
              <div className="text-gray-500 mb-1">本机名称地址</div>
              <div className="space-y-1">
                {hostnames.map((item) => (
                  <div key={item.url} className="flex flex-wrap items-center gap-2">
                    <code className="text-gray-200 bg-vscode-sidebar border border-vscode-panel-border rounded px-2 py-1">
                      {item.url}
                    </code>
                    <button
                      type="button"
                      onClick={() => onCopy(item.url, item.url)}
                      className="inline-flex items-center gap-1 px-2 py-1 rounded border border-vscode-panel-border text-gray-300 hover:bg-vscode-list-hoverBackground"
                    >
                      <Copy size={12} />
                      {copied === item.url ? '已复制' : '复制'}
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          <div>
            <div className="text-gray-500 mb-1">IPv4 备用地址</div>
            {addresses.length ? (
              <div className="space-y-1">
                {addresses.map((item) => (
                  <div key={item.url} className="flex flex-wrap items-center gap-2">
                    <code className="text-gray-200 bg-vscode-sidebar border border-vscode-panel-border rounded px-2 py-1">
                      {item.url}
                    </code>
                    <span className="text-gray-500 text-[10px]">
                      {item.interfaceName || 'network'}{item.private ? ' · 局域网' : ''}
                    </span>
                    <button
                      type="button"
                      onClick={() => onCopy(item.url, item.url)}
                      className="inline-flex items-center gap-1 px-2 py-1 rounded border border-vscode-panel-border text-gray-300 hover:bg-vscode-list-hoverBackground"
                    >
                      <Copy size={12} />
                      {copied === item.url ? '已复制' : '复制'}
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-gray-500">未检测到可用的局域网 IPv4 地址</div>
            )}
          </div>

          <div className="text-gray-500 text-[10px] bg-vscode-sidebar rounded p-2 leading-relaxed">
            测试连通性：手机浏览器打开 <code className="text-gray-300">{lanTestUrl || '/api/lan/status'}</code>，
            登录前看到 Unauthorized / 401 就代表网络已打通。
          </div>

          <div className="text-amber-200/90 text-[10px] bg-amber-500/10 border border-amber-500/30 rounded p-2 leading-relaxed space-y-1">
            <div className="font-semibold text-amber-200">手机仍无法连接时</div>
            <div>
              Mac 本机能打开测试地址但手机打不开，通常不是 App 端口问题，而是 Wi-Fi 开启了访客网络、客户端隔离、AP 隔离，或手机实际没有连到同一个局域网。
            </div>
            {ipv4Url ? (
              <div>
                请优先用 IPv4 地址测试：<code className="text-amber-100">{ipv4Url}</code>
              </div>
            ) : null}
          </div>

          <button
            type="button"
            onClick={onCopyDiagnostics}
            className="inline-flex items-center gap-1 px-2 py-1 rounded border border-vscode-panel-border text-gray-300 hover:bg-vscode-list-hoverBackground"
          >
            <Copy size={12} />
            {copied === 'diagnostics' ? '诊断信息已复制' : '复制诊断信息'}
          </button>
        </div>
      ) : null}

      {error ? (
        <div className="text-rose-300 bg-rose-500/10 border border-rose-500/30 rounded p-2">
          {error}
        </div>
      ) : null}
    </div>
  );
}
