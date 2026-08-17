import assert from 'node:assert/strict';
import { parseOperands } from '../../js/arm64.js';
import { liftArm64IntegerEffects } from '../../js/targets/architecture/arm64/effects/integer.js';

let sequence = 0;
function instruction(mnemonic, operands, extra = {}) {
  sequence += 1;
  const instructionId = `arm64-int-${sequence}`;
  return {
    instructionId,
    mnemonic,
    operands,
    ops: parseOperands(operands),
    address: 0x1000n + BigInt(sequence * 4),
    mode: 'a64',
    origin: { instructionIds: [instructionId] },
    ...extra,
  };
}
function lift(mnemonic, operands, extra) { return liftArm64IntegerEffects(instruction(mnemonic, operands, extra)); }
function opsOf(bundle, kind) { return bundle.operations.filter((operation) => operation.kind === kind); }
function assertOrigin(bundle) {
  assert.ok(bundle.origin.instructionIds.includes(bundle.instructionId));
  for (const operation of bundle.operations) {
    assert.equal(operation.metadata.originInstructionId, bundle.instructionId);
    assert.ok(bundle.origin.operationIds.includes(operation.id));
  }
}

{
  const bundle = lift('add', 'w0, w1, w2');
  assert.equal(bundle.completeness, 'exact');
  const reads = opsOf(bundle, 'register-read');
  assert.equal(reads.length, 2);
  assert.ok(reads.every((operation) => operation.register.widthBits === 64),
    'W reads must observe the shared 64-bit physical X register state');
  assert.deepEqual(reads.map((operation) => operation.register.registerId), ['x1','x2']);
  assert.equal(bundle.operations.filter((operation) => operation.kind === 'value'
    && operation.opcode === 'trunc'
    && operation.metadata.reason === 'a64-w-register-read-is-low-32-of-physical-x').length, 2,
    'each W read must project its low-32 view explicitly');
  const writes = opsOf(bundle, 'register-write');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].register.registerId, 'x0');
  assert.equal(writes[0].register.widthBits, 64, 'W writes must update the physical X register');
  assert.equal(writes[0].register.view, 'x0');
  assert.ok(bundle.operations.some((operation) => operation.kind === 'value' && operation.opcode === 'zext'
    && operation.metadata.reason === 'a64-w-register-write-zeroes-upper-32'));
  assertOrigin(bundle);
}

{
  const bundle = lift('add', 'sp, sp, #16');
  assert.equal(bundle.completeness, 'exact');
  const writes = opsOf(bundle, 'register-write');
  assert.deepEqual(writes.map((operation) => operation.register.registerId), ['sp']);
  assert.ok(opsOf(bundle, 'register-read').some((operation) => operation.register.registerId === 'sp'));
}

{
  const bundle = lift('add', 'xzr, x1, x2');
  assert.equal(bundle.completeness, 'exact');
  assert.equal(opsOf(bundle, 'register-write').length, 0, 'writes to XZR are discarded');
  assert.equal(opsOf(bundle, 'register-read').filter((operation) => operation.register.registerId === 'x1').length, 1);
}

{
  const bundle = lift('adds', 'x3, x4, x5');
  assert.equal(bundle.completeness, 'exact');
  assert.deepEqual(opsOf(bundle, 'flag-write').map((operation) => operation.flag.flagId).sort(),
    ['NZCV.C','NZCV.N','NZCV.V','NZCV.Z']);
}

{
  const exact = lift('lsl', 'x0, x1, #63');
  assert.equal(exact.completeness, 'exact');
  const partial = lift('lsl', 'x0, x1, #64');
  assert.equal(partial.completeness, 'partial');
  assert.match(partial.unknownEffects.reason, /shift-out-of-range/);
}

{
  const bundle = lift('lslv', 'w0, w1, w2');
  assert.equal(bundle.completeness, 'exact');
  const maskOp = bundle.operations.find((operation) => operation.kind === 'value' && operation.metadata.reason === 'a64-variable-shift-modulo-register-width');
  assert.ok(maskOp, 'variable shifts must mask the amount by width-1');
}

{
  for (const mnemonic of ['mul','mneg','smull','umull','smulh','umulh','sdiv','udiv','madd','msub','smaddl','smsubl','umaddl','umsubl']) {
    const operands = mnemonic.endsWith('l') && !['mul','mneg'].includes(mnemonic)
      ? (['smull','umull'].includes(mnemonic) ? 'x0, w1, w2' : 'x0, w1, w2, x3')
      : ['smulh','umulh'].includes(mnemonic) ? 'x0, x1, x2'
      : ['madd','msub'].includes(mnemonic) ? 'x0, x1, x2, x3'
      : 'x0, x1, x2';
    const bundle = lift(mnemonic, operands);
    assert.equal(bundle.completeness, 'exact', `${mnemonic} should lift exactly`);
  }
  const div = lift('sdiv', 'w0, w1, w2');
  const op = div.operations.find((operation) => operation.kind === 'value' && operation.opcode === 'a64-sdiv');
  assert.equal(op.metadata.divisionByZero, 'returns-zero');
  assert.equal(op.metadata.signedOverflow, 'wraps-min-div-minus-one');
}

{
  for (const [mnemonic, operands] of [
    ['mov','x0, x1'], ['movz','x0, #0x1234, lsl #16'], ['movn','w0, #0'], ['movk','x0, #0xabcd, lsl #32'],
    ['sxtb','x0, w1'], ['sxth','x0, w1'], ['sxtw','x0, w1'], ['uxtb','w0, w1'], ['uxth','w0, w1'], ['uxtw','x0, w1'],
    ['clz','x0, x1'], ['rbit','x0, x1'], ['rev','x0, x1'], ['rev16','x0, x1'], ['rev32','x0, x1'], ['abs','x0, x1'],
  ]) {
    assert.equal(lift(mnemonic, operands).completeness, 'exact', `${mnemonic} should lift exactly`);
  }
}

{
  const bundle = lift('csel', 'x0, x1, x2, gt');
  assert.equal(bundle.completeness, 'exact');
  assert.ok(bundle.operations.some((operation) => operation.kind === 'value' && operation.opcode === 'select'));
  const flags = opsOf(bundle, 'flag-read').map((operation) => operation.flag.flagId).sort();
  assert.deepEqual(flags, ['NZCV.N','NZCV.V','NZCV.Z'], 'GT consumes only Z, N, and V');
  for (const [mnemonic, operands] of [
    ['csinc','x0, x1, x2, eq'], ['csinv','x0, x1, x2, ne'], ['csneg','x0, x1, x2, ge'],
    ['cset','w0, hi'], ['csetm','x0, lo'], ['cinc','x0, x1, pl'], ['cneg','x0, x1, mi'], ['cinv','x0, x1, vc'],
  ]) assert.equal(lift(mnemonic, operands).completeness, 'exact', `${mnemonic} should lift exactly`);
}

{
  const bundle = lift('add', 'x0');
  assert.equal(bundle.completeness, 'partial');
  assert.equal(bundle.unknownEffects.preservation, 'not-assumed');
  assert.ok(bundle.unknownEffects.categories.includes('registers'));
}

console.log('arm64 integer arithmetic effects: PASS');