import assert from 'node:assert/strict';
import { WasmFrontend } from '../../../js/managed/wasm/frontend.js';
import { lowerVMEffectsToSemanticIr } from '../../../js/managed/shared/bridge.js';

console.log('[phase11] running wasm pipeline tests...');

const wasmBytes = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  0x01, 0x07, 0x01, 0x60, 0x02, 0x7f, 0x7f, 0x01, 0x7f,
  0x03, 0x02, 0x01, 0x00,
  0x07, 0x08, 0x01, 0x04, 0x74, 0x65, 0x73, 0x74, 0x00, 0x00,
  0x0a, 0x09, 0x01, 0x07, 0x00,
  0x20, 0x00, 0x20, 0x01, 0x6a, 0x0b,
]);

const frontend = new WasmFrontend();
const image = await frontend.open(wasmBytes);

const methods = [];
for await (const m of frontend.enumerateMethods(image)) {
  methods.push(m);
}
assert.equal(methods.length, 1);
assert.equal(methods[0].name, 'test');

const decoded = await frontend.decodeMethod(methods[0], { image });
const val = await frontend.validateMethod(decoded);
assert.equal(val.status, 'valid');

const lifted = await frontend.liftMethod(decoded, val);
const bridged = lowerVMEffectsToSemanticIr(lifted);

assert.ok(bridged.semanticIr);
assert.ok(bridged.cfg);
assert.ok(bridged.ssa);
assert.equal(bridged.cfg.blocks.length, 1);

console.log('  ok wasm pipeline tests passed');
