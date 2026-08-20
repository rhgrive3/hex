import assert from 'node:assert/strict';
import { liftWasmFunction } from '../../../js/managed/wasm/lifter.js';
import { parseWasm } from '../../../js/managed/wasm/parser.js';

console.log('[phase11] running wasm VMEffects tests...');

const wasmBytes = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  // Type: (func (param i32 i32) (result i32))
  0x01, 0x07, 0x01, 0x60, 0x02, 0x7f, 0x7f, 0x01, 0x7f,
  // Function: type 0
  0x03, 0x02, 0x01, 0x00,
  // Export: "test"
  0x07, 0x08, 0x01, 0x04, 0x74, 0x65, 0x73, 0x74, 0x00, 0x00,
  // Code:
  //   local.get 0
  //   local.get 1
  //   i32.add
  //   i32.const 5
  //   i32.mul
  //   return
  //   end
  0x0a, 0x0d, 0x01, 0x0b, 0x00,
  0x20, 0x00,       // local.get 0
  0x20, 0x01,       // local.get 1
  0x6a,             // i32.add
  0x41, 0x05,       // i32.const 5
  0x6c,             // i32.mul
  0x0f,             // return
  0x0b,             // end
]);

const parsed = parseWasm(wasmBytes);
const vmFn = liftWasmFunction(0, parsed);

assert.equal(vmFn.frontendId, 'wasm');
assert.equal(vmFn.bundles.length, 7);
assert.equal(vmFn.aggregateCompleteness, 'exact');

assert.equal(vmFn.bundles[0].mnemonic, 'local.get');
assert.equal(vmFn.bundles[0].locationReads[0].kind, 'local');
assert.equal(vmFn.bundles[0].locationReads[0].index, 0);

assert.equal(vmFn.bundles[1].mnemonic, 'local.get');
assert.equal(vmFn.bundles[1].locationReads[0].index, 1);

assert.equal(vmFn.bundles[2].mnemonic, 'i32.add');
assert.equal(vmFn.bundles[2].consumedValues.length, 2);
assert.equal(vmFn.bundles[2].producedValues.length, 1);

assert.equal(vmFn.bundles[3].mnemonic, 'i32.const');
assert.equal(vmFn.bundles[3].producedValues[0].constant, 5);

assert.equal(vmFn.bundles[4].mnemonic, 'i32.mul');

assert.equal(vmFn.bundles[5].mnemonic, 'return');
assert.equal(vmFn.bundles[5].controlEffects[0].kind, 'return');

console.log('  ok wasm VMEffects tests passed');
