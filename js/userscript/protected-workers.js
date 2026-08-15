import { PROTECTED_WORKER_ASSETS } from '../../.runtime-build/embedded-assets.js';

export function installProtectedWorkers() {
  if (globalThis.__HEX_WORKER_RUNTIME__) return globalThis.__HEX_WORKER_RUNTIME__;
  const NativeWorker = globalThis.Worker;
  if (!NativeWorker) throw new Error('Web Workers are unavailable in this browser.');
  const wasmURL = URL.createObjectURL(new Blob([decode(PROTECTED_WORKER_ASSETS.wasm)], { type: 'application/wasm' }));
  const urls = new Map(), revoke = [wasmURL];
  for (const [path, source] of Object.entries(PROTECTED_WORKER_ASSETS.classic)) {
    const url = URL.createObjectURL(new Blob([capstonePrelude(wasmURL), source], { type: 'text/javascript' })); urls.set(path, url); revoke.push(url);
  }
  for (const [path, source] of Object.entries(PROTECTED_WORKER_ASSETS.modules)) {
    const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' })); urls.set(path, url); revoke.push(url);
  }
  function HexWorker(value, options) {
    const path = logicalPath(value), local = path && urls.get(path);
    return new NativeWorker(local || value, options);
  }
  HexWorker.prototype = NativeWorker.prototype; Object.setPrototypeOf(HexWorker, NativeWorker);
  Object.defineProperty(HexWorker, '__hexUserscriptWorker', { value: true }); globalThis.Worker = HexWorker;
  const runtime = { nativeWorker: NativeWorker, workers: urls, cleanup() { if (globalThis.Worker === HexWorker) globalThis.Worker = NativeWorker; for (const url of revoke) URL.revokeObjectURL(url); delete globalThis.__HEX_WORKER_RUNTIME__; } };
  globalThis.__HEX_WORKER_RUNTIME__ = runtime; addEventListener('pagehide', () => runtime.cleanup(), { once: true }); return runtime;
}
function logicalPath(value) { try { const path = new URL(String(value), location.href).pathname; return path.replace(/^\//, ''); } catch { return null; } }
function decode(value) { const binary = atob(value); return Uint8Array.from(binary, (char) => char.charCodeAt(0)); }
function capstonePrelude(wasmURL) { return `;(()=>{const N=globalThis.URL,W=${JSON.stringify(wasmURL)};globalThis.URL=class extends N{constructor(p,b){if(typeof p==='string'&&/(?:^|\\/)capstone\\.wasm(?:[?#].*)?$/.test(p)){super(W);return}super(p,b)}}})();\n`; }
