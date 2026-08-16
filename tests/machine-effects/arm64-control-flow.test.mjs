import assert from 'node:assert/strict';
import { parseOperands } from '../../js/arm64.js';
import { liftArm64ControlEffects } from '../../js/targets/architecture/arm64/effects/control.js';

let sequence = 0;
function instruction(mnemonic, operands = '', extra = {}) {
  sequence += 1;
  const instructionId = `arm64-control-${sequence}`;
  return {
    instructionId, mnemonic, operands, ops: parseOperands(operands), mode:'a64',
    address: 0x4000n + BigInt(sequence * 4), origin:{ instructionIds:[instructionId] },
    ...extra,
  };
}
function lift(mnemonic, operands = '', extra = {}) { return liftArm64ControlEffects(instruction(mnemonic, operands, extra)); }
function registerWrites(bundle) { return bundle.operations.filter((operation) => operation.kind === 'register-write'); }

{
  const bundle = lift('b', '#0x5000', { branchTarget: 0x5000n });
  assert.equal(bundle.completeness, 'exact');
  assert.equal(bundle.controlEffect.kind, 'branch');
  assert.equal(bundle.controlEffect.target.value, '20480');
  assert.equal(bundle.operations.length, 0, 'direct B has no architectural register effects');
  assert.ok(bundle.origin.instructionIds.includes(bundle.instructionId));
}

{
  const bundle = lift('br', 'x3');
  assert.equal(bundle.completeness, 'exact');
  assert.equal(bundle.controlEffect.kind, 'indirect');
  assert.equal(bundle.operations.filter((operation) => operation.kind === 'register-read')[0].register.registerId, 'x3');
  assert.equal(bundle.possibleFaults[0].kind, 'pc-alignment-fault');
}

{
  const insn = instruction('bl', '#0x6000', { callTarget: 0x6000n, address: 0x4100n });
  const bundle = liftArm64ControlEffects(insn);
  assert.equal(bundle.completeness, 'exact');
  assert.equal(bundle.controlEffect.kind, 'call');
  assert.deepEqual(registerWrites(bundle).map((operation) => operation.register.registerId), ['x30']);
  assert.equal(bundle.metadata.abiSemantics, false, 'MachineEffects call must not add AAPCS64 semantics');
  assert.equal(bundle.controlEffect.fallthrough.value, String(0x4104));
}

{
  const bundle = lift('blr', 'x9', { address: 0x4200n });
  assert.equal(bundle.completeness, 'exact');
  assert.equal(bundle.controlEffect.kind, 'call');
  assert.equal(bundle.metadata.indirect, true);
  assert.deepEqual(registerWrites(bundle).map((operation) => operation.register.registerId), ['x30']);
  const reads = bundle.operations.filter((operation) => operation.kind === 'register-read').map((operation) => operation.register.registerId);
  assert.deepEqual(reads, ['x9']);
}

{
  const bundle = lift('ret');
  assert.equal(bundle.completeness, 'exact');
  assert.equal(bundle.controlEffect.kind, 'return');
  assert.equal(registerWrites(bundle).length, 0);
  assert.deepEqual(bundle.operations.filter((operation) => operation.kind === 'register-read').map((operation) => operation.register.registerId), ['x30']);
  assert.equal(bundle.metadata.abiSemantics, false);
}

{
  const bundle = lift('b.eq', '#0x7000', { branchTarget: 0x7000n, address: 0x4300n });
  assert.equal(bundle.completeness, 'exact');
  assert.equal(bundle.controlEffect.kind, 'conditional-branch');
  assert.equal(bundle.controlEffect.target.value, String(0x7000));
  assert.equal(bundle.controlEffect.fallthrough.value, String(0x4304));
  const flagReads = bundle.operations.filter((operation) => operation.kind === 'flag-read').map((operation) => operation.flag.flagId);
  assert.deepEqual(flagReads, ['NZCV.Z'], 'condition code is lowered to explicit NZCV consumption');
  assert.notEqual(bundle.controlEffect.condition, 'eq', 'downstream consumers receive a condition value, not a mnemonic string');
}

{
  const zero = lift('cbz', 'w1, #0x7100', { branchTarget: 0x7100n, address: 0x4400n });
  assert.equal(zero.completeness, 'exact');
  assert.ok(zero.operations.some((operation) => operation.kind === 'value' && operation.opcode === 'is-zero'));
  const test = lift('tbnz', 'x2, #63, #0x7200', { branchTarget: 0x7200n, address: 0x4500n });
  assert.equal(test.completeness, 'exact');
  assert.ok(test.operations.some((operation) => operation.kind === 'value' && operation.opcode === 'extract-bit' && operation.metadata.bit === 63));
}

{
  const partial = lift('tbz', 'w0, #32, #0x7300', { branchTarget: 0x7300n, address: 0x4600n });
  assert.equal(partial.completeness, 'partial');
  assert.equal(partial.controlEffect.kind, 'unknown');
  assert.equal(partial.unknownEffects.preservation, 'not-assumed');
}

{
  const partial = lift('bl', '#0x8000', { callTarget: 0x8000n, address: null });
  assert.equal(partial.completeness, 'partial');
  assert.equal(partial.controlEffect.kind, 'call');
  assert.ok(partial.unknownEffects.categories.includes('registers'), 'unknown link-register value must fail closed');
}

assert.equal(liftArm64ControlEffects(instruction('ldr', 'x0, [x1]')), null, 'memory family is outside this lifter');

console.log('arm64 control effects: PASS');
