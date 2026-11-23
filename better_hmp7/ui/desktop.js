'use strict';

// All display, charting and report code lives in this window. Only named
// serial, preference and user-selected file operations cross the native bridge.
(() => {
  const ready = new Promise(resolve => {
    const attach = () => resolve(window.pywebview.api);
    if (window.pywebview?.api) attach();
    else window.addEventListener('pywebviewready', attach, {once: true});
  });
  const byId = id => document.getElementById(id);
  const listeners = new Set();
  let connected = false;
  let pendingPort = null;
  let portRequest = 0;
  let prefsWrite = Promise.resolve();
  const cancelled = () => new DOMException('已取消', 'AbortError');

  async function refreshPorts() {
    const request = ++portRequest;
    const select = byId('local-port');
    const previous = select.value;
    byId('confirm-port').disabled = true;
    byId('refresh-ports').disabled = true;
    try {
      const ports = await (await ready).ports();
      if (!pendingPort || request !== portRequest) return;
      select.replaceChildren(...ports.map(port => {
        const option = document.createElement('option');
        option.value = port.device;
        option.textContent = [port.device, port.description].filter(Boolean).join(' · ');
        return option;
      }));
      if (ports.some(port => port.device === previous)) select.value = previous;
      byId('port-message').textContent = ports.length ? '请选择探头的 USB 转接线。' : '没有发现串口。接好探头、安装驱动后点刷新。';
      byId('confirm-port').disabled = !ports.length;
    } catch (error) {
      if (pendingPort) byId('port-message').textContent = error.message;
    } finally {
      if (request === portRequest) byId('refresh-ports').disabled = false;
    }
  }

  function choosePort() {
    if (pendingPort) return Promise.reject(new Error('串口列表已打开'));
    const result = new Promise((resolve, reject) => { pendingPort = {resolve, reject}; });
    byId('port-dialog').showModal();
    refreshPorts();
    return result;
  }

  byId('refresh-ports').addEventListener('click', refreshPorts);
  byId('cancel-port').addEventListener('click', () => byId('port-dialog').close());
  byId('confirm-port').addEventListener('click', () => {
    if (!pendingPort || !byId('local-port').value) return;
    pendingPort.resolve(byId('local-port').value);
    pendingPort = null;
    byId('port-dialog').close();
  });
  byId('port-dialog').addEventListener('close', () => {
    if (pendingPort) pendingPort.reject(cancelled());
    pendingPort = null;
  });

  async function disconnect(reason = 'manual', message = '已断开本机探头') {
    if (!connected) return;
    connected = false;
    try { await (await ready).disconnect_port(); }
    finally { listeners.forEach(fn => fn({reason, message})); }
  }

  window.HMP7Serial = Object.freeze({
    get connected() { return connected; },
    async connect() {
      const port = await choosePort();
      const info = await (await ready).connect_port(port);
      connected = true;
      return info;
    },
    async sample() {
      try { return await (await ready).read_sample(); }
      catch (error) { await disconnect('device', error.message); throw error; }
    },
    disconnect: () => disconnect(),
    onDisconnect(fn) { listeners.add(fn); },
  });

  window.HMP7Desktop = Object.freeze({
    ready,
    savePreferences(curves, interval) {
      const selected = [...curves];
      prefsWrite = prefsWrite.catch(() => {}).then(async () => (await ready).set_preferences(selected, interval / 1000));
      return prefsWrite;
    },
    async chooseFile(kind, options) {
      const result = await (await ready).choose_file(kind, options.suggestedName);
      if (!result) throw cancelled();
      return result;
    },
    async writeFile(handle, content) {
      const api = await ready;
      if (handle.kind === 'recording-file') {
        await api.begin_csv(handle.token, content);
        return;
      }
      const blob = content instanceof Blob ? content : new Blob([content]);
      await api.begin_export(handle.kind, handle.token);
      try {
        const chunkSize = 96 * 1024;
        for (let offset = 0; offset < blob.size; offset += chunkSize) {
          const bytes = new Uint8Array(await blob.slice(offset, offset + chunkSize).arrayBuffer());
          let binary = '';
          for (let i = 0; i < bytes.length; i += 8192) {
            binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
          }
          await api.export_chunk(handle.token, btoa(binary));
        }
        await api.end_export(handle.token, true);
      } catch (error) {
        await api.end_export(handle.token, false);
        throw error;
      }
    },
  });
  byId('driver-page').addEventListener('click', async () => (await ready).open_driver_page());
})();
