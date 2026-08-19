import test from 'node:test';
import assert from 'node:assert/strict';
import { liftArm64FpEffects } from '../../../../js/targets/architecture/arm64/effects/fp.js';

const fp = (num, bits) => ({ k:'reg', cls:'fp', num, bits, text:`${bits === 32 ? 's' : bits === 64 ? 'd' : 'q'}${num}` });
const lift = (mnemonic, operands, id) => liftArm64FpEffects({
  instructionId:id, mnemonic, ops:operands, operands:operands.map((op) => op.text).join(', '),
}, { instructionId:id });
const ops = (bundle, kind) => bundle.operations.filter((operation) => operation.kind === kind);
const stateOps = (bundle, kind, registerId) => ops(bundle, kind).filter((operation) => operation.register?.registerId === registerId);

test('FMOV D0,D0 reads and writes canonical 128-bit V0 and explicitly zeroes upper 64 bits', () => {
  const bundle = lift('fmov', [fp(0,64), fp(0,64)], 'issue947:fmov-d');
  assert.equal(bundle.completeness, 'exact');
  assert.equal(stateOps(bundle, 'register-read', 'v0').length, 1);
  assert.equal(stateOps(bundle, 'register-read', 'v0')[0].register.widthBits, 128);
  assert.equal(stateOps(bundle, 'register-write', 'v0').length, 1);
  assert.equal(stateOps(bundle, 'register-write', 'v0')[0].register.widthBits, 128);
  assert.equal(stateOps(bundle, 'register-write', 'v0')[0].metadata?.writePolicy, 'zero-upper-vector-bits');
  assert.ok(ops(bundle, 'value').some((operation) => operation.opcode === 'truncate' && operation.metadata?.fromBits === 128 && operation.metadata?.toBits === 64));
  assert.ok(ops(bundle, 'value').some((operation) => operation.opcode === 'zero-extend' && operation.metadata?.fromBits === 64 && operation.metadata?.toBits === 128));
  assert.equal(bundle.operations.some((operation) => operation.kind === 'register-write' && operation.register?.registerId === 'v0' && operation.register?.widthBits === 64), false);
});

test('FADD D0 and FADD S0 materialize scalar results into the same 128-bit V0 physical state', () => {
  for (const bits of [64,32]) {
    const bundle = lift('fadd', [fp(0,bits), fp(1,bits), fp(2,bits)], `issue947:fadd-${bits}`);
    assert.equal(bundle.completeness, 'exact-with-intrinsic');
    const writes = stateOps(bundle, 'register-write', 'v0');
    assert.equal(writes.length, 1);
    assert.equal(writes[0].register.widthBits, 128);
    assert.equal(writes[0].metadata?.writePolicy, 'zero-upper-vector-bits');
    assert.ok(ops(bundle, 'value').some((operation) => operation.opcode === 'zero-extend' && operation.metadata?.fromBits === bits && operation.metadata?.toBits === 128));
    assert.equal(stateOps(bundle, 'register-read', 'v1')[0].register.widthBits, 128);
    assert.equal(stateOps(bundle, 'register-read', 'v2')[0].register.widthBits, 128);
  }
});

test('scalar FP source views are projections from canonical Vn rather than independent 32/64-bit physical state', () => {
  const bundle = lift('fadd', [fp(0,64), fp(1,64), fp(2,64)], 'issue947:source-view');
  for (const registerId of ['v1','v2']) {
    const reads = stateOps(bundle, 'register-read', registerId);
    assert.equal(reads.length, 1);
    assert.equal(reads[0].register.widthBits, 128);
    assert.equal(bundle.operations.some((operation) => operation.kind === 'register-read' && operation.register?.registerId === registerId && operation.register?.widthBits === 64), false);
  }
  assert.ok(ops(bundle, 'value').filter((operation) => operation.opcode === 'truncate' && operation.metadata?.purpose === 'arm64-fp-register-view').length >= 2);
});
