import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../js/userscript/protected-workers.js', import.meta.url), 'utf8');
const probe = await readFile(new URL('../js/platform/capstone-probe-worker.js', import.meta.url), 'utf8');
const disasm = await readFile(new URL('../js/platform/capstone-disasm-worker.js', import.meta.url), 'utf8');

assert.match(source, /decodeArrayBuffer\(PROTECTED_WORKER_ASSETS\.wasm\)/);
assert.match(source, /return bytes\.buffer/);
assert.match(source, /new Blob\(\[wasmBytes\]/);
assert.doesNotMatch(source, /new Blob\(\[decode\(PROTECTED_WORKER_ASSETS\.wasm\)\]/);
assert.match(source, /protected worker WASM Blob/);
assert.match(source, /WebAssembly\.instantiate=/);
assert.match(source, /ArrayBuffer\.isView\(v\)/);
assert.match(source, /return b\.buffer/);

// Protected ChatGPT workers must receive the already-verified WASM bytes directly.
// This avoids a second blob: fetch/compile path that is unreliable in iOS WebKit.
assert.match(source, /CAPSTONE_WASM_BOOTSTRAP = '__hex_capstone_wasm__'/);
assert.match(source, /CAPSTONE_CLASSIC_WORKERS/);
assert.match(source, /'js\/worker\.js'/);
assert.match(source, /'js\/platform\/capstone-probe-worker\.js'/);
assert.match(source, /'js\/platform\/capstone-disasm-worker\.js'/);
assert.match(source, /const wasmBinary = wasmBytes\.slice\(0\)/);
assert.match(source, /worker\.postMessage\(\{ t: CAPSTONE_WASM_BOOTSTRAP, wasmBinary \}, \[wasmBinary\]\)/);
assert.match(source, /__HEX_CAPSTONE_WASM__/);
assert.match(source, /wasmBinary:globalThis\.__HEX_CAPSTONE_WASM__\|\|o\.wasmBinary/);
assert.match(source, /stopImmediatePropagation\(\)/);
assert.match(source, /worker\.terminate\(\)/);

// Execute the generated worker prelude with a fake Capstone factory. This locks
// the ordering contract: bootstrap message first, then MCapstone receives the
// in-memory wasmBinary instead of having to fetch the nested blob URL.
const preludeStart = source.indexOf('function capstonePrelude(wasmURL)');
assert.ok(preludeStart >= 0, 'capstonePrelude must exist');
const factoryContext = vm.createContext({});
vm.runInContext(`
const CAPSTONE_WASM_BOOTSTRAP = '__hex_capstone_wasm__';
${source.slice(preludeStart)}
globalThis.__generatedPrelude = capstonePrelude('blob:verified-capstone-wasm');
`, factoryContext);

const listeners = [];
const microtasks = [];
let instantiateCalls = 0;
class FakeURL {
  constructor(path, base) { this.href = base ? `${base}:${path}` : String(path); }
  toString() { return this.href; }
}
const workerContext = vm.createContext({
  URL: FakeURL,
  ArrayBuffer,
  Uint8Array,
  WebAssembly: {
    instantiate(sourceValue, imports) {
      instantiateCalls++;
      return { sourceValue, imports };
    },
  },
  addEventListener(type, handler) {
    if (type === 'message') listeners.push(handler);
  },
  queueMicrotask(handler) { microtasks.push(handler); },
});
vm.runInContext(factoryContext.__generatedPrelude, workerContext);

let receivedOptions = null;
workerContext.MCapstone = async (options) => {
  receivedOptions = options;
  return { ok: true };
};
for (const task of microtasks.splice(0)) task();

const embeddedWasm = new ArrayBuffer(16);
let bootstrapStopped = false;
assert.equal(listeners.length, 1, 'bootstrap message listener installed');
listeners[0]({
  data: { t: '__hex_capstone_wasm__', wasmBinary: embeddedWasm },
  stopImmediatePropagation() { bootstrapStopped = true; },
});
assert.equal(bootstrapStopped, true, 'bootstrap message must not reach the normal worker handler');
await workerContext.MCapstone({ locateFile: () => 'should-not-be-needed.wasm' });
assert.equal(receivedOptions.wasmBinary, embeddedWasm, 'MCapstone must receive the embedded WASM bytes');
assert.equal(instantiateCalls, 0, 'test factory should not need WebAssembly.instantiate itself');

assert.match(probe, /Capstone probe initialization/);
assert.match(disasm, /Capstone disassembler initialization/);

console.log('userscript protected worker ArrayBuffer regression: ok');
