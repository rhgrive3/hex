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
assert.match(probe, /Capstone probe initialization/);
assert.match(disasm, /Capstone disassembler initialization/);

const generated = await readFile(new URL('../userscript/hex.user.template.js', import.meta.url));
console.log(`TEMPLATE_BASE64=${generated.toString('base64')}`);
console.log('userscript protected worker ArrayBuffer regression: ok');
