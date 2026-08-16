import { PROTECTED_WORKER_ASSETS } from '../../.runtime-build/embedded-assets.js';

export function installProtectedWorkers() {
  if (globalThis.__HEX_WORKER_RUNTIME__) return globalThis.__HEX_WORKER_RUNTIME__;
  const NativeWorker = globalThis.Worker;
  if (!NativeWorker) throw new Error('Web Workers are unavailable in this browser.');
  const wasmBytes = decodeArrayBuffer(PROTECTED_WORKER_ASSETS.wasm);
  const wasmURL = workerStage('protected worker WASM Blob', () => URL.createObjectURL(new Blob([wasmBytes], { type: 'application/wasm' })));
  const urls = new Map(), revoke = [wasmURL];
  for (const [path, source] of Object.entries(PROTECTED_WORKER_ASSETS.classic)) {
    const url = workerStage(`protected classic worker Blob (${path})`, () => URL.createObjectURL(new Blob([capstonePrelude(wasmURL), source], { type: 'text/javascript' })));
    urls.set(path, url); revoke.push(url);
  }
  for (const [path, source] of Object.entries(PROTECTED_WORKER_ASSETS.modules)) {
    const url = workerStage(`protected module worker Blob (${path})`, () => URL.createObjectURL(new Blob([source], { type: 'text/javascript' })));
    urls.set(path, url); revoke.push(url);
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
function workerStage(name, operation) { try { return operation(); } catch (error) { throw new Error(`${name}: ${String(error?.message || error || 'failed')}`); } }
function logicalPath(value) { try { const path = new URL(String(value), location.href).pathname; return path.replace(/^\//, ''); } catch { return null; } }
function decodeArrayBuffer(value) {
  const binary = atob(value), bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}
function capstonePrelude(wasmURL) {
  return `;(()=>{const N=globalThis.URL,W=${JSON.stringify(wasmURL)},I=WebAssembly.instantiate.bind(WebAssembly);const E=v=>{if(v instanceof ArrayBuffer)return v;if(ArrayBuffer.isView(v)){const b=new Uint8Array(v.byteLength);b.set(new Uint8Array(v.buffer,v.byteOffset,v.byteLength));return b.buffer}return v};WebAssembly.instantiate=(s,i)=>I(E(s),i);globalThis.URL=class extends N{constructor(p,b){if(typeof p==='string'&&/(?:^|\\/)capstone\\.wasm(?:[?#].*)?$/.test(p)){super(W);return}super(p,b)}}})();\n`;
}
