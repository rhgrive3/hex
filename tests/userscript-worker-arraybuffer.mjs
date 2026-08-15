import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../js/userscript/protected-workers.js', import.meta.url), 'utf8');

assert.match(source, /decodeArrayBuffer\(PROTECTED_WORKER_ASSETS\.wasm\)/);
assert.match(source, /return bytes\.buffer/);
assert.match(source, /new Blob\(\[wasmBytes\]/);
assert.doesNotMatch(source, /new Blob\(\[decode\(PROTECTED_WORKER_ASSETS\.wasm\)\]/);
assert.match(source, /protected worker WASM Blob/);

console.log('userscript protected worker ArrayBuffer regression: ok');
