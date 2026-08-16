import assert from 'node:assert/strict';
import { parseOperands } from '../../js/arm64.js';
import { liftArm64IntegerEffects } from '../../js/targets/architecture/arm64/effects/integer.js';
import {
  evaluateArm64AddSubFlags,
  evaluateArm64Condition,
  liftArm64FlagEffects,
} from '../../js/targets/architecture/arm64/effects/flags.js';

{
  assert.deepEqual(evaluateArm64AddSubFlags(0xffffffffn, 1n, 32), {
    result: 0n, N: 0, Z: 1, C: 1, V: 0,
  });
  assert.deepEqual(evaluateArm64AddSubFlags(0x7fffffffn, 1n, 32), {
    result: 0x80000000n, N: 1, Z: 0, C: 0, V: 1,
  });
  assert.deepEqual(evaluateArm64AddSubFlags(0n, 1n, 32, { subtract: true }), {
    result: 0xffffffffn, N: 1, Z: 0, C: 0, V: 0,
  });
  assert.deepEqual(evaluateArm64AddSubFlags(1n, 1n, 32, { subtract: true }), {
    result: 0n, N: 0, Z: 1, C: 1, V: 0,
  });
  assert.deepEqual(evaluateArm64AddSubFlags(0x7fffffffffffffffn, 1n, 64), {
    result: 0x8000000000000000n, N: 1, Z: 0, C: 0, V: 1,
  });
}

{
  const flags = evaluateArm64AddSubFlags(0xffffffffn, 1n, 32, { subtract: true });
  assert.equal(evaluateArm64Condition(flags, 'hi'), true, '0xffffffff is greater than 1 unsigned');
  assert.equal(evaluateArm64Condition(flags, 'lt'), true, '0xffffffff is -1 and less than 1 signed');
  assert.equal(evaluateArm64Condition(flags, 'ge'), false);
  assert.equal(evaluateArm64Condition(flags, 'ls'), false);
  assert.equal(evaluateArm64Condition({N:0,Z:1,C:1,V:0}, 'eq'), true);
  assert.equal(evaluateArm64Condition({N:0,Z:0,C:0,V:1}, 'vs'), true);
  assert.equal(evaluateArm64Condition({N:0,Z:0,C:0,V:0}, 'al'), true);
  assert.equal(evaluateArm64Condition({N:0,Z:0,C:0,V:0}, 'nv'), true);
}

let sequence = 0;
function instruction(mnemonic, operands) {
  sequence += 1;
  const instructionId = `arm64-flags-${sequence}`;
  return {
    instructionId, mnemonic, operands, ops: parseOperands(operands), mode:'a64',
    address: 0x3000n + BigInt(sequence * 4), origin:{ instructionIds:[instructionId] },
  };
}
function liftFlags(mnemonic, operands) { return liftArm64FlagEffects(instruction(mnemonic, operands)); }

{
  const bundle = liftFlags('cmp', 'w0, #1');
  assert.equal(bundle.completeness, 'exact');
  assert.equal(bundle.operations.filter((operation) => operation.kind === 'register-write').length, 0);
  assert.deepEqual(bundle.operations.filter((operation) => operation.kind === 'flag-write').map((operation) => operation.flag.flagId).sort(),
    ['NZCV.C','NZCV.N','NZCV.V','NZCV.Z']);
  assert.ok(bundle.operations.some((operation) => operation.kind === 'value' && operation.opcode === 'add-with-carry'));
}

{
  const bundle = liftFlags('tst', 'x0, x1');
  assert.equal(bundle.completeness, 'exact');
  const writes = Object.fromEntries(bundle.operations.filter((operation) => operation.kind === 'flag-write').map((operation) => [operation.flag.flagId, operation.value]));
  assert.equal(writes['NZCV.C'].kind, 'bitvector');
  assert.equal(writes['NZCV.C'].value, '0');
  assert.equal(writes['NZCV.V'].value, '0');
}

{
  const bundle = liftFlags('ccmp', 'x0, x1, #5, ge');
  assert.equal(bundle.completeness, 'exact');
  assert.equal(bundle.metadata.condition, 'ge');
  assert.equal(bundle.metadata.fallbackNzcv, 5);
  const reads = bundle.operations.filter((operation) => operation.kind === 'flag-read').map((operation) => operation.flag.flagId).sort();
  assert.deepEqual(reads, ['NZCV.N','NZCV.V'], 'GE consumes N and V explicitly');
  assert.equal(bundle.operations.filter((operation) => operation.kind === 'flag-write').length, 4);
}

{
  const bundle = liftArm64IntegerEffects(instruction('adcs', 'x0, x1, x2'));
  assert.equal(bundle.completeness, 'exact');
  assert.ok(bundle.operations.some((operation) => operation.kind === 'flag-read' && operation.flag.flagId === 'NZCV.C'));
  assert.equal(bundle.operations.filter((operation) => operation.kind === 'flag-write').length, 4);
}

{
  const partial = liftFlags('ccmn', 'x0, x1, #16, eq');
  assert.equal(partial.completeness, 'partial');
  assert.equal(partial.unknownEffects.preservation, 'not-assumed');
  assert.ok(partial.unknownEffects.categories.includes('flags'));
}

console.log('arm64 NZCV effects: PASS');
