/*
 * Untrusted Script/Plugin runner.
 *
 * The browser page never evaluates user code. An opaque-origin sandboxed iframe
 * owns a Dedicated Worker, and the Worker is the only place where untrusted
 * JavaScript runs. The iframe itself is only a tiny relay/controller so the
 * page can always terminate a runaway worker (for example `while (true) {}`).
 *
 * Data crosses the boundary only through an explicit MessagePort RPC API.
 * Network/resource channels are blocked by CSP and common worker networking
 * globals are removed before user code starts.
 */

const WORKER_PRELUDE = String.raw`
(() => {
  "use strict";

  // Defense in depth. The opaque sandbox also has connect-src 'none', but make
  // the common network/sub-worker entrypoints unavailable to user code itself.
  for (const name of [
    'fetch', 'WebSocket', 'EventSource', 'XMLHttpRequest', 'Worker',
    'SharedWorker', 'importScripts', 'WebTransport', 'BroadcastChannel'
  ]) {
    try {
      Object.defineProperty(globalThis, name, {
        value: undefined, writable: false, configurable: false,
      });
    } catch {
      try { globalThis[name] = undefined; } catch { /* ignore */ }
    }
  }

  let seq = 1;
  const waiting = new Map();
  const nativePostMessage = globalThis.postMessage.bind(globalThis);
  const OUTPUT_MAX_MESSAGES = 256;
  const OUTPUT_MAX_BYTES = 256 * 1024;
  const OUTPUT_MAX_PER_SECOND = 96;
  let outputMessages = 0, outputBytes = 0, outputWindow = Date.now(), outputWindowCount = 0;
  const outputSize = (value) => {
    const seen = new Set(); const stack=[value]; let bytes=0, nodes=0;
    while (stack.length && bytes <= OUTPUT_MAX_BYTES) {
      const x=stack.pop(); if (++nodes > 4096) return OUTPUT_MAX_BYTES + 1;
      if (x == null) { bytes+=4; continue; }
      if (typeof x === 'string') { bytes += x.length * 2; continue; }
      if (typeof x === 'number' || typeof x === 'bigint') { bytes+=16; continue; }
      if (typeof x === 'boolean') { bytes+=4; continue; }
      if (x instanceof ArrayBuffer) { bytes+=x.byteLength; continue; }
      if (ArrayBuffer.isView(x)) { bytes+=x.byteLength; continue; }
      if (typeof x === 'object') {
        if (seen.has(x)) continue; seen.add(x);
        const keys=Object.keys(x); bytes += keys.length * 8;
        for (let i=0;i<keys.length && i<2048;i++) { bytes += keys[i].length*2; stack.push(x[keys[i]]); }
      } else bytes+=32;
    }
    return bytes;
  };
  const outputLimit = (message) => {
    const now=Date.now(); if (now-outputWindow >= 1000) { outputWindow=now; outputWindowCount=0; }
    const bytes=outputSize(message);
    outputMessages++; outputWindowCount++; outputBytes+=bytes;
    return bytes > OUTPUT_MAX_BYTES || outputMessages > OUTPUT_MAX_MESSAGES || outputBytes > OUTPUT_MAX_BYTES || outputWindowCount > OUTPUT_MAX_PER_SECOND;
  };
  const sendOutput = (message) => {
    if (outputLimit(message)) {
      try { nativePostMessage({t:'outputLimit', error:'sandbox output budget exceeded'}); } catch {}
      try { close(); } catch {}
      return;
    }
    try { nativePostMessage(message); } catch {}
  };
  // Direct user postMessage is fire-and-forget output too; route it through the
  // same budget instead of letting it bypass print().
  try { Object.defineProperty(globalThis,'postMessage',{value:sendOutput,writable:false,configurable:false}); } catch {}

  const send = (message) => {
    try { nativePostMessage(message); }
    catch (err) {
      try { postMessage({ t: 'error', error: (err && err.message) || String(err) }); }
      catch { /* host timeout/termination is the final fallback */ }
    }
  };

  const rpc = (method, args) => new Promise((resolve, reject) => {
    const id = seq++;
    waiting.set(id, { resolve, reject });
    send({ t: 'rpc', id, method, args });
  });

  // Keep the stateful Emulator instance on the trusted page. Only a small
  // clone-safe id crosses this boundary; scripts still get an object-like API.
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
      if (prop === 'hex') {
        return (value, pad = 8) => '0x' + BigInt(value).toString(16).toUpperCase().padStart(pad, '0');
      }
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
  const print = (...args) => sendOutput({ t: 'print', args });
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
    if (worker) {
      try { worker.terminate(); } catch {}
      worker = null;
    }
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
    worker.onmessage = (e) => {
      const data=e.data || {};
      if (data.t === 'outputLimit') { port.postMessage({t:'error',error:'出力が安全上限を超えたため停止しました。'}); stop(); return; }
      port.postMessage(data);
    };
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

export function runInSandbox({ source, mode = 'script', index = 0, api, out, timeout = 30000 }) {
  return new Promise((resolve) => {
    const frame = document.createElement('iframe');
    frame.hidden = true;
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.referrerPolicy = 'no-referrer';
    const channel = new MessageChannel();
    let settled = false;

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
      clearTimeout(timer);
      window.removeEventListener('message', onFrameReady);
      terminate();
      channel.port1.close();
      frame.remove();
      resolve(value);
    };

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
      } else if (m.t === 'rpc') {
        let value, error;
        try {
          const allowed = api && typeof m.method === 'string' &&
            Object.prototype.hasOwnProperty.call(api, m.method);
          const fn = allowed ? api[m.method] : null;
          if (typeof fn !== 'function') throw new Error('許可されていないAPIです: ' + m.method);
          value = await fn(...(m.args || []));
        } catch (err) {
          error = (err && err.message) || String(err);
        }
        if (settled) return;
        try { channel.port1.postMessage({ t: 'rpcResult', id: m.id, value, error }); }
        catch { channel.port1.postMessage({ t: 'rpcResult', id: m.id, error: '結果を受け渡せませんでした。' }); }
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
