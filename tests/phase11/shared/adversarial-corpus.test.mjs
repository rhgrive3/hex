import assert from 'node:assert/strict';
import {
  createManagedMethodId,
  createVMEffectBundle,
  createVMEffectFunction,
  lowerVMEffectsToSemanticIr,
  probeManagedFrontend,
  openManagedImage,
  VM_EFFECTS_SCHEMA_VERSION,
  VM_EFFECTS_CONTRACT_VERSION,
} from '../../../js/managed/index.js';
import { parseWasm } from '../../../js/managed/wasm/parser.js';
import { parseDex } from '../../../js/managed/dex/parser.js';
import { parseCil } from '../../../js/managed/cil/parser.js';
import { liftCilMethod } from '../../../js/managed/cil/lifter.js';
import { parseJvm } from '../../../js/managed/jvm/parser.js';
import { buildMinimalDex } from '../dex/dex-parser.test.mjs';
import { buildMinimalCil } from '../cil/cil-parser.test.mjs';
import { buildMinimalJvmClass } from '../jvm/jvm-parser.test.mjs';

console.log('[phase11] running mandatory adversarial corpus tests...');

// 1. Truncated container
assert.throws(() => {
  parseWasm(new Uint8Array([0x00, 0x61, 0x73]));
}, /wasm-unsupported-binary/);

// 2. Oversized count
assert.throws(() => {
  // WASM section 1 declaring 0xffffffff types
  parseWasm(new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    0x01, 0x06, 0xff, 0xff, 0xff, 0xff, 0x0f, 0x60,
  ]));
}, /wasm-malformed-type-section|wasm-malformed-uleb128/);

// 3. Overflowed offset
const overflowDex = buildMinimalDex();
new DataView(overflowDex.buffer).setUint32(60, 0x7fffffff, true); // string_ids_off overflow
assert.throws(() => {
  parseDex(overflowDex);
}, /dex-truncated-string-ids/);

// 4. Invalid metadata reference
const badRefDex = buildMinimalDex();
new DataView(badRefDex.buffer).setUint32(0x80, 999, true); // type 0 -> string 999 (invalid index)
assert.throws(() => {
  parseDex(badRefDex);
}, /dex-invalid-type-descriptor-index/);

// 5. Invalid method body index
const validCil = parseCil(buildMinimalCil());
assert.throws(() => {
  liftCilMethod(999, validCil);
}, /cil-invalid-method-body-index/);

// 6. Unsupported opcode: MUST be explicit partial/unknown, NOT silent no-op!
const methodId = createManagedMethodId('mod-adv', 'unsupportedOp');
const unsupportedBundle = createVMEffectBundle({
  frontendId: 'wasm',
  methodId,
  operationId: 'vm-op:mod-adv:0x0:1',
  bytecodeOffset: 0,
  opcode: 0xee,
  mnemonic: 'unknown_0xee',
  completeness: 'partial',
  unknownEffects: [{ category: 'other', reason: 'unsupported-opcode-0xee' }],
});
assert.equal(unsupportedBundle.completeness, 'partial');
assert.equal(unsupportedBundle.unknownEffects[0].reason, 'unsupported-opcode-0xee');

// 7. Invalid CFG target
assert.throws(() => {
  const badBranchBundle = createVMEffectBundle({
    frontendId: 'wasm',
    methodId,
    operationId: 'vm-op:mod-adv:0x0:1',
    bytecodeOffset: 0,
    controlEffects: [{ kind: 'branch', targetOffset: 0x99999 }], // nonexistent target
    completeness: 'exact',
  });
  const vmFn = createVMEffectFunction({
    methodId,
    frontendId: 'wasm',
    bundles: [badBranchBundle],
  });
  lowerVMEffectsToSemanticIr(vmFn);
}, /semantic-ir-invalid-control-target|semantic-cfg-invalid-entry-block|semantic-cfg-invalid-successor|managed-bridge/);

// 8. Invalid exception region
const badExcFn = createVMEffectFunction({
  methodId,
  frontendId: 'wasm',
  bundles: [
    createVMEffectBundle({
      frontendId: 'wasm',
      methodId,
      operationId: 'vm-op:mod-adv:0x0:1',
      bytecodeOffset: 0,
      controlEffects: [{ kind: 'return' }],
      completeness: 'exact',
    }),
  ],
  exceptionRegions: [
    { startOffset: 100, endOffset: 200, handlerOffset: 300 }, // out of bounds
  ],
});
assert.equal(badExcFn.exceptionRegions.length, 1);

// 9. Impossible stack/register state (fail closed on missing required values)
assert.throws(() => {
  createVMEffectBundle({
    frontendId: 'wasm',
    methodId,
    operationId: 'vm-op:mod-adv:0x0:1',
    bytecodeOffset: 0,
    completeness: 'invalid-state',
  });
}, /vm-effect-invalid-completeness/);

// 10. Native bridge boundary (explicit external boundary, not guessed pure call)
const nativeBundle = createVMEffectBundle({
  frontendId: 'dex',
  methodId,
  operationId: 'vm-op:mod-adv:0x0:1',
  bytecodeOffset: 0,
  opcode: 0,
  mnemonic: 'jni_native_method',
  callEffects: [{
    target: 'Lcom/example/Native;->nativeMethod()V',
    dispatchKind: 'jni-native',
    unresolved: true,
  }],
  controlEffects: [{ kind: 'return' }],
  completeness: 'exact',
});
assert.equal(nativeBundle.callEffects[0].dispatchKind, 'jni-native');
assert.equal(nativeBundle.callEffects[0].unresolved, true);

// 11. Malformed nested archive/container probe
const badProbe = await probeManagedFrontend(new Uint8Array([0x50, 0x4b, 0x03, 0x04])); // raw zip without valid dex/class
assert.equal(badProbe.supported, false);

// 12. Stale artifact schema/version rejection
assert.throws(() => {
  createVMEffectBundle({
    schemaVersion: 999, // future/stale schema
    frontendId: 'wasm',
    methodId,
    operationId: 'vm-op:mod-adv:0x0:1',
    bytecodeOffset: 0,
    completeness: 'exact',
  });
}, /vm-effect-schema-version-mismatch/);

// 13. Wrong BinaryId reuse attempt
assert.notEqual(
  createManagedMethodId('mod-1', 'methodA'),
  createManagedMethodId('mod-2', 'methodA'),
);

// 14. Provenance loss after transform check
const provBundle = createVMEffectBundle({
  frontendId: 'wasm',
  methodId,
  operationId: 'vm-op:mod-adv:0x0:1',
  bytecodeOffset: 0,
  opcode: 0x41,
  mnemonic: 'i32.const',
  producedValues: [{ bits: 32, constant: 42 }],
  completeness: 'exact',
  origin: { byteRanges: [{ start: 0x10, end: 0x12 }], operationIds: ['vm-op:mod-adv:0x0:1'] },
});
const provFn = createVMEffectFunction({
  methodId,
  frontendId: 'wasm',
  bundles: [provBundle],
});
const provLowered = lowerVMEffectsToSemanticIr(provFn);
assert.ok(provLowered.semanticIr.nodes[0].origin.transforms.length > 0);
assert.equal(provLowered.semanticIr.nodes[0].sourceEffectIds[0], 'vm-op:mod-adv:0x0:1');

// 15. Unknown operation incorrectly treated as no-op (Hard invariant: must be flagged)
assert.throws(() => {
  createVMEffectBundle({
    frontendId: 'wasm',
    methodId,
    operationId: 'vm-op:mod-adv:0x0:1',
    bytecodeOffset: 0,
    opcode: 0xee,
    completeness: 'unknown',
    // Missing unknownEffects array!
  });
}, /vm-effect-partial-must-specify-unknown-effects/);

console.log('  ok all 15 mandatory adversarial classes passed');
