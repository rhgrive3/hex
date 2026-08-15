/*
 * Untrusted Script/Plugin runner.
 *
 * The browser page never evaluates user code. An opaque-origin sandboxed iframe
 * owns a Dedicated Worker, and the Worker is the only place where untrusted
 * JavaScript runs. Data crosses the boundary only through an explicit bounded
 * MessagePort RPC API.
 */

const MAX_RPC_TOTAL = 1000;
const MAX_RPC_CONCURRENT = 8;
const MAX_RPC_INPUT_BYTES = 4 * 1024 * 1024;
const MAX_RPC_OUTPUT_BYTES = 16 * 1024 * 1024;

const WORKER_PRELUDE = String.raw`
(() => {
  "use strict";
  for (const name of [
    'fetch', 'WebSocket', 'EventSource', 'XMLHttpRequest', 'Worker',
    'SharedWorker', 'importScripts', 'WebTransport', 'BroadcastChannel'
  ]) {
    try { Object.defineProperty(globalThis, name, { value: undefined, writable: false, configurable: false }); }
    catch { try { globalThis[name] = undefined; } catch {} }
  }

  const MAX_OUTSTANDING_RPC = 16;
  const MAX_TOTAL_RPC = 1000;
  const MAX_ARGUMENT_UNITS = 4 * 1024 * 1024;
  let seq = 1;
  let totalRpc = 0;
  let argumentUnits = 0;
  const waiting = new Map();

  const send = (message) => {
    try { postMessage(message); }
    catch (err) {
      try { postMessage({ t: 'error', error: (err && err.message) || String(err) }); } catch {}
    }
  };

  const measure = (value, seen = new Set(), limit = MAX_ARGUMENT_UNITS + 1) => {
    if (limit <= 0 || value == null) return 0;
    const type = typeof value;
    if (type === 'string') return Math.min(limit, value.length * 2);
    if (type === 'number' || type === 'bigint' || type === 'boolean') return 16;
    if (type !== 'object' || seen.has(value)) return 0;
    seen.add(value);
    let n = 16;
    const values = Array.isArray(value) ? value : Object.values(value);
    for (const item of values) {
      n += measure(item, seen, limit - n);
      if (n >= limit) break;
    }
    seen.delete(value);
    return n;
  };

  const rpc = (method, args) => new Promise((resolve, reject) => {
    if (waiting.size >= MAX_OUTSTANDING_RPC) {
      send({ t: 'budgetExceeded', error: 'RPC同時実行数の上限を超えました。' });
      reject(new Error('RPC同時実行数の上限を超えました。'));
      return;
    }
    if (++totalRpc > MAX_TOTAL_RPC) {
      send({ t: 'budgetExceeded', error: 'RPC総数の上限を超えました。' });
      reject(new Error('RPC総数の上限を超えました。'));
      return;
    }
    argumentUnits += measure(args);
    if (argumentUnits > MAX_ARGUMENT_UNITS) {
      send({ t: 'budgetExceeded', error: 'RPC引数サイズの上限を超えました。' });
      reject(new Error('RPC引数サイズの上限を超えました。'));
      return;
    }
    const id = seq++;
    waiting.set(id, { resolve, reject });
    send({ t: 'rpc', id, method, args });
  });

  const emulatorProxy = (id) => Object.freeze({
    id,
    setup: (addr, args = []) => rpc('emulatorSetup', [id, addr, args]),
    step: () => rpc('emulatorStep', [id]),
    run: (maxSteps = 20000) => rpc('emulatorRun', [id, maxSteps]),
    state: () => rpc('emulatorState', [id]),
    get: (reg) => rpc('emulatorGetRegister', [id, reg]),
    set: (reg, value) => rpc('emulatorSetRegister', [id, reg, value]),
    dump: (addr, len = 64) => rpc('emulatorDump', [id, addr, len]),
    store: (addr, size, value) => rpc('emulatorStore', [id, addr, size, value]),
    addBreakpoint: (addr) => rpc('emulatorAddBreakpoint', [id, addr]),
    removeBreakpoint: (addr) => rpc('emulatorRemoveBreakpoint', [id, addr]),
    breakpoints: () => rpc('emulatorBreakpoints', [id]),
    reset: () => rpc('emulatorReset', [id]),
    destroy: () => rpc('emulatorDestroy', [id]),
  });

  const makeHex = () => new Proxy(Object.create(null), {
    get(_target, prop) {
      if (typeof prop !== 'string' || prop === 'then' || prop === '__proto__' || prop === 'constructor') return undefined;
      if (prop === 'hex') return (value, pad = 8) => '0x' + BigInt(value).toString(16).toUpperCase().padStart(pad, '0');
      if (prop === 'emulator') {
        return async (addr = null, args = []) => {
          const created = await rpc('emulatorCreate', [addr, args]);
          if (!created || !created.id) throw new Error('エミュレータを作れませんでした。');
          return emulatorProxy(created.id);
        };
      }
      return (...args) => rpc(prop, args);
    },
  });

  const hex = makeHex();
  const print = (...args) => send({ t: 'print', args });
  const defs = [];
  const registrar = Object.freeze({ plugin(def) {
    if (!def || typeof def.run !== 'function') throw new Error('run（実行する処理）がありません。');
    defs.push(def);
  } });

  self.onmessage = (e) => {
    const m = e.data || {};
    if (m.t !== 'rpcResult') return;
    const p = waiting.get(m.id);
    if (!p) return;
    waiting.delete(m.id);
    m.error ? p.reject(new Error(m.error)) : p.resolve(m.value);
  };
`;

const WORKER_POSTLUDE = String.raw`
  Promise.resolve(__hexRun()).catch((err) => {
    send({ t: 'error', error: err && err.message ? err.message : String(err) });
  });
})();
`;

function workerProgram(source, mode, index) {
  const user = String(source || '');
  const safeIndex = Math.max(0, Math.trunc(Number(index) || 0));
  let body;
  if (mode === 'discover' || mode === 'plugin') {
    body = `
  const __hexRun = async () => {
    const module = { exports: {} };
    const factory = (hex, module, exports) => { "use strict";\n${user}\n};
    factory(registrar, module, module.exports);
    if (module.exports && typeof module.exports.run === 'function') registrar.plugin(module.exports);
    if (${JSON.stringify(mode)} === 'discover') {
      send({ t: 'done', value: defs.map((d) => ({
        name: String(d.name || '名前のないプラグイン').slice(0, 80),
        description: String(d.description || '').slice(0, 200),
      })) });
      return;
    }
    const def = defs[${safeIndex}];
    if (!def) throw new Error('プラグイン定義が見つかりません。');
    const value = await def.run(hex, print);
    if (value !== undefined) print(value);
    send({ t: 'done', value: null });
  };
//# sourceURL=hex-user-plugin.js
`;
  } else {
    body = `
  const __hexRun = async () => {
    const body = async (hex, print) => { "use strict";\n${user}\n};
    const value = await body(hex, print);
    if (value !== undefined) print(value);
    send({ t: 'done', value: null });
  };
//# sourceURL=hex-user-script.js
`;
  }
  return WORKER_PRELUDE + body + WORKER_POSTLUDE;
}

const FRAME = `<!doctype html><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; connect-src 'none'; img-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; child-src 'none'; worker-src blob:; style-src 'none'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<script>
(() => {
  "use strict";
  const WORKER_PRELUDE = ${JSON.stringify(WORKER_PRELUDE)};
  const WORKER_POSTLUDE = ${JSON.stringify(WORKER_POSTLUDE)};
  const workerProgram = ${workerProgram.toString()};
  let worker = null;
  let port = null;
  const stop = () => {
    if (worker) { try { worker.terminate(); } catch {} worker = null; }
  };
  const start = (m) => {
    stop();
    try {
      const source = workerProgram(m.source, m.mode, m.index);
      const blob = new Blob([source], { type: 'text/javascript' });
      const url = URL.createObjectURL(blob);
      worker = new Worker(url);
      URL.revokeObjectURL(url);
    } catch (err) {
      port.postMessage({ t: 'error', error: '安全な実行用Workerを作れませんでした: ' + ((err && err.message) || err) });
      return;
    }
    worker.onmessage = (e) => port.postMessage(e.data || {});
    worker.onerror = (e) => {
      port.postMessage({ t: 'error', error: (e && e.message) || '実行用Workerでエラーが起きました。' });
      stop();
    };
  };
  addEventListener('message', (event) => {
    const p = event.ports && event.ports[0];
    if (!p || port) return;
    port = p;
    port.onmessage = (e) => {
      const m = e.data || {};
      if (m.t === 'terminate') { stop(); return; }
      if (m.t === 'start') { start(m); return; }
      if (worker) worker.postMessage(m);
    };
    port.start();
    port.postMessage({ t: 'ready' });
  }, { once: true });
  addEventListener('pagehide', stop, { once: true });
  parent.postMessage({ t: 'hexSandboxFrameReady' }, '*');
})();
</script>`;

function valueSize(value, seen = new Set(), limit = MAX_RPC_OUTPUT_BYTES + 1) {
  if (limit <= 0 || value == null) return 0;
  const type = typeof value;
  if (type === 'string') return Math.min(limit, value.length * 2);
  if (type === 'number' || type === 'bigint' || type === 'boolean') return 16;
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  if (type !== 'object' || seen.has(value)) return 0;
  seen.add(value);
  let n = 16;
  const values = Array.isArray(value) ? value : Object.values(value);
  for (const item of values) {
    n += valueSize(item, seen, limit - n);
    if (n >= limit) break;
  }
  seen.delete(value);
  return n;
}

export function runInSandbox({ source, mode = 'script', index = 0, api, out, timeout = 30000 }) {
  return new Promise((resolve) => {
    const frame = document.createElement('iframe');
    frame.hidden = true;
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.referrerPolicy = 'no-referrer';
    const channel = new MessageChannel();
    const runController = new AbortController();
    let settled = false;
    let rpcTotal = 0;
    let rpcConcurrent = 0;
    let rpcInputBytes = 0;
    let rpcOutputBytes = 0;

    const terminate = () => {
      try { channel.port1.postMessage({ t: 'terminate' }); } catch { /* ignore */ }
    };

    const onFrameReady = (event) => {
      if (event.source !== frame.contentWindow || !event.data || event.data.t !== 'hexSandboxFrameReady') return;
      window.removeEventListener('message', onFrameReady);
      frame.contentWindow.postMessage({ t: 'init' }, '*', [channel.port2]);
    };
    window.addEventListener('message', onFrameReady);

    const finish = (value) => {
      if (settled) return;
      settled = true;
      runController.abort(value?.error || 'sandbox-finished');
      clearTimeout(timer);
      window.removeEventListener('message', onFrameReady);
      window.removeEventListener('pagehide', onPageHide);
      terminate();
      channel.port1.close();
      frame.remove();
      resolve(value);
    };

    const failBudget = (message) => finish({ error: message });
    const onPageHide = () => finish({ error: 'ページが閉じられたため実行を停止しました。' });
    window.addEventListener('pagehide', onPageHide, { once: true });

    const timer = setTimeout(
      () => finish({ error: '実行が時間制限を超えたため、安全に停止しました。' }),
      Math.max(50, Number(timeout) || 30000)
    );

    channel.port1.onmessage = async (e) => {
      if (settled) return;
      const m = e.data || {};
      if (m.t === 'ready') {
        channel.port1.postMessage({ t: 'start', source: String(source || ''), mode, index });
      } else if (m.t === 'print') {
        try { out(...(m.args || [])); } catch { /* output must not stop the sandbox */ }
      } else if (m.t === 'budgetExceeded') {
        failBudget(m.error || 'sandbox RPC budget exceeded');
      } else if (m.t === 'rpc') {
        const inputBytes = valueSize(m.args, new Set(), MAX_RPC_INPUT_BYTES + 1);
        rpcTotal++;
        rpcInputBytes += inputBytes;
        if (rpcTotal > MAX_RPC_TOTAL) return failBudget('RPC総数の上限を超えたため停止しました。');
        if (rpcConcurrent >= MAX_RPC_CONCURRENT) return failBudget('RPC同時実行数の上限を超えたため停止しました。');
        if (rpcInputBytes > MAX_RPC_INPUT_BYTES) return failBudget('RPC引数サイズの上限を超えたため停止しました。');
        rpcConcurrent++;
        let value, error;
        try {
          const allowed = api && typeof m.method === 'string' && Object.prototype.hasOwnProperty.call(api, m.method);
          const fn = allowed ? api[m.method] : null;
          if (typeof fn !== 'function') throw new Error('許可されていないAPIです: ' + m.method);
          // All host APIs receive a final execution context. Existing JS APIs
          // harmlessly ignore the extra argument; long-running adapters can
          // observe signal and cancel backend/worker work immediately.
          value = await fn(...(m.args || []), { signal: runController.signal });
          if (runController.signal.aborted) return;
          rpcOutputBytes += valueSize(value, new Set(), MAX_RPC_OUTPUT_BYTES + 1);
          if (rpcOutputBytes > MAX_RPC_OUTPUT_BYTES) return failBudget('RPC返却データ量の上限を超えたため停止しました。');
        } catch (err) {
          error = (err && err.message) || String(err);
        } finally {
          rpcConcurrent = Math.max(0, rpcConcurrent - 1);
        }
        if (settled) return;
        try { channel.port1.postMessage({ t: 'rpcResult', id: m.id, value, error }); }
        catch {
          try { channel.port1.postMessage({ t: 'rpcResult', id: m.id, error: '結果を受け渡せませんでした。' }); }
          catch { failBudget('RPC結果を返せないため停止しました。'); }
        }
      } else if (m.t === 'done') {
        finish({ ok: true, value: m.value });
      } else if (m.t === 'error') {
        finish({ error: m.error || '実行できませんでした。' });
      }
    };

    frame.srcdoc = FRAME;
    document.body.append(frame);
  });
}
