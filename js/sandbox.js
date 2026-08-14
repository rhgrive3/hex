/*
 * Untrusted Script/Plugin runner.
 *
 * Code is evaluated in an opaque-origin sandboxed iframe. The frame receives
 * only a MessagePort; every allowed operation is an explicit RPC call to the
 * public `hex` API. Its own CSP disables every network/resource channel.
 */

const FRAME = `<!doctype html><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; connect-src 'none'; img-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; style-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; base-uri 'none'; form-action 'none'">
<script>
addEventListener('message', (event) => {
  const port = event.ports && event.ports[0];
  if (!port) return;
  let seq = 1;
  const waiting = new Map();
  port.onmessage = async (e) => {
    const m = e.data || {};
    if (m.t === 'rpcResult') {
      const p = waiting.get(m.id);
      if (!p) return;
      waiting.delete(m.id);
      m.error ? p.reject(new Error(m.error)) : p.resolve(m.value);
      return;
    }
    if (m.t !== 'start') return;
    const rpc = (method, args) => new Promise((resolve, reject) => {
      const id = seq++;
      waiting.set(id, { resolve, reject });
      port.postMessage({ t: 'rpc', id, method, args });
    });
    const hex = new Proxy(Object.create(null), {
      get(_target, prop) {
        if (typeof prop !== 'string' || prop === 'then' || prop === '__proto__' || prop === 'constructor') return undefined;
        if (prop === 'hex') return (value, pad = 8) => '0x' + BigInt(value).toString(16).toUpperCase().padStart(pad, '0');
        return (...args) => rpc(prop, args);
      },
    });
    const print = (...args) => port.postMessage({ t: 'print', args });
    try {
      const defs = [];
      const registrar = { plugin(def) {
        if (!def || typeof def.run !== 'function') throw new Error('run（実行する処理）がありません。');
        defs.push(def);
      } };
      if (m.mode === 'discover' || m.mode === 'plugin') {
        const module = { exports: {} };
        const factory = new Function('hex', 'module', 'exports', '"use strict";\\n' + m.source + '\\n//# sourceURL=hex-user-code.js');
        factory(registrar, module, module.exports);
        if (module.exports && typeof module.exports.run === 'function') registrar.plugin(module.exports);
      }
      if (m.mode === 'discover') {
        port.postMessage({ t: 'done', value: defs.map((d) => ({
          name: String(d.name || '名前のないプラグイン').slice(0, 80),
          description: String(d.description || '').slice(0, 200),
        })) });
        return;
      } else if (m.mode === 'plugin') {
        const def = defs[m.index];
        if (!def) throw new Error('プラグイン定義が見つかりません。');
        const value = await def.run(hex, print);
        if (value !== undefined) print(value);
      } else {
        const body = new Function('hex', 'print', 'return (async () => { "use strict";\\n' + m.source + '\\n})()');
        const value = await body(hex, print);
        if (value !== undefined) print(value);
      }
      port.postMessage({ t: 'done', value: null });
    } catch (err) {
      port.postMessage({ t: 'error', error: err && err.message ? err.message : String(err) });
    }
  };
  port.start();
  port.postMessage({ t: 'ready' });
}, { once: true });
parent.postMessage({ t: 'hexSandboxFrameReady' }, '*');
</script>`;

export function runInSandbox({ source, mode = 'script', index = 0, api, out, timeout = 30000 }) {
  return new Promise((resolve) => {
    const frame = document.createElement('iframe');
    frame.hidden = true;
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.referrerPolicy = 'no-referrer';
    const channel = new MessageChannel();
    let settled = false;
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
      channel.port1.close();
      frame.remove();
      resolve(value);
    };
    const timer = setTimeout(() => finish({ error: '実行が30秒を超えたため停止しました。' }), timeout);
    channel.port1.onmessage = async (e) => {
      const m = e.data || {};
      if (m.t === 'ready') {
        channel.port1.postMessage({ t: 'start', source: String(source || ''), mode, index });
      } else if (m.t === 'print') {
        try { out(...(m.args || [])); } catch { /* output must not stop the sandbox */ }
      } else if (m.t === 'rpc') {
        let value, error;
        try {
          const fn = api && api[m.method];
          if (typeof fn !== 'function') throw new Error('許可されていないAPIです: ' + m.method);
          value = await fn(...(m.args || []));
        } catch (err) { error = (err && err.message) || String(err); }
        try { channel.port1.postMessage({ t: 'rpcResult', id: m.id, value, error }); }
        catch { channel.port1.postMessage({ t: 'rpcResult', id: m.id, error: '結果を受け渡せませんでした。' }); }
      } else if (m.t === 'done') finish({ ok: true, value: m.value });
      else if (m.t === 'error') finish({ error: m.error || '実行できませんでした。' });
    };
    frame.srcdoc = FRAME;
    document.body.append(frame);
  });
}
