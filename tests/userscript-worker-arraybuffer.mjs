import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

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

assert.match(probe, /Capstone probe initialization/);
assert.match(disasm, /Capstone disassembler initialization/);

console.log('userscript protected worker ArrayBuffer regression: ok');
