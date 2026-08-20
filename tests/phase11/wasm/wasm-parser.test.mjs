import assert from 'node:assert/strict';
import { parseWasm, probeWasm } from '../../../js/managed/wasm/parser.js';

console.log('[phase11] running wasm parser tests...');

// 1. Valid minimal WASM module with type, function, export, and code section:
// (module
//   (type (func (param i32 i32) (result i32)))
//   (func (type 0) (param i32 i32) (result i32)
//     local.get 0
//     local.get 1
//     i32.add)
//   (export "add" (func 0)))
const minimalWasm = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, // \0asm
  0x01, 0x00, 0x00, 0x00, // version 1
  // Section 1: Type
  0x01, 0x07, // id 1, len 7
  0x01,       // 1 type
  0x60,       // func
  0x02, 0x7f, 0x7f, // 2 params: i32, i32
  0x01, 0x7f,       // 1 result: i32
  // Section 3: Function
  0x03, 0x02, // id 3, len 2
  0x01,       // 1 function
  0x00,       // type index 0
  // Section 7: Export
  0x07, 0x07, // id 7, len 7
  0x01,       // 1 export
  0x03, 0x61, 0x64, 0x64, // "add"
  0x00,       // func export
  0x00,       // func index 0
  // Section 10: Code
  0x0a, 0x09, // id 10, len 9
  0x01,       // 1 function body
  0x07,       // body size 7
  0x00,       // 0 local declarations
  0x20, 0x00, // local.get 0
  0x20, 0x01, // local.get 1
  0x6a,       // i32.add
  0x0b,       // end
]);

const probe = probeWasm(minimalWasm);
assert.equal(probe.supported, true);
assert.equal(probe.formatVersion, '1');
assert.equal(probe.vmSpecEdition, 'core-3.0');

const parsed = parseWasm(minimalWasm, { binaryId: 'test-wasm' });
assert.equal(parsed.formatVersion, '1');
assert.equal(parsed.types.length, 1);
assert.deepEqual(parsed.types[0].params, [0x7f, 0x7f]);
assert.deepEqual(parsed.types[0].results, [0x7f]);
assert.equal(parsed.functions.length, 1);
assert.equal(parsed.functions[0], 0);
assert.equal(parsed.exports.length, 1);
assert.equal(parsed.exports[0].name, 'add');
assert.equal(parsed.codeBodies.length, 1);
assert.equal(parsed.codeBodies[0].bodySize, 7);

console.log('  ok wasm parser tests passed');
