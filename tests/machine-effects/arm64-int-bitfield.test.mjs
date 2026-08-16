import assert from 'node:assert/strict';
import { parseOperands } from '../../js/arm64.js';
import {
  decodeArm64BitMasks,
  evaluateArm64Bitfield,
  liftArm64IntegerEffects,
} from '../../js/targets/architecture/arm64/effects/integer.js';

let sequence = 0;
function lift(mnemonic, operands) {
  sequence += 1;
  const instructionId = `arm64-bitfield-${sequence}`;
  return liftArm64IntegerEffects({
    instructionId, mnemonic, operands, ops: parseOperands(operands), mode: 'a64',
    address: 0x2000n + BigInt(sequence * 4), origin: { instructionIds: [instructionId] },
  });
}

{
  const masks = decodeArm64BitMasks(64, 8, 15);
  assert.ok(masks);
  assert.equal(evaluateArm64Bitfield('ubfm', 0x12345678n, 0n, 64, 8, 15), 0x56n);
  assert.equal(evaluateArm64Bitfield('ubfm', 0x12345678n, 0n, 64, 56, 7), 0x7800n);
  assert.equal(evaluateArm64Bitfield('sbfm', 0x8000n, 0n, 64, 8, 15), 0xffffffffffffff80n);
  assert.equal(evaluateArm64Bitfield('bfm', 0x12n, 0xffffn, 64, 56, 7), 0x12ffn);
}

{
  const samples = [0n, 1n, 0x12345678n, 0xffffffffn];
  for (const source of samples) {
    for (const lsb of [0,1,7,8,15,16,24]) {
      for (const width of [1,2,4,8]) {
        if (lsb + width > 32) continue;
        const actual = evaluateArm64Bitfield('ubfm', source, 0n, 32, lsb, lsb + width - 1);
        const expected = (BigInt.asUintN(32, source) >> BigInt(lsb)) & ((1n << BigInt(width)) - 1n);
        assert.equal(actual, expected, `UBFX property lsb=${lsb} width=${width}`);
      }
    }
  }
}

{
  const bundle = lift('ubfx', 'x0, x1, #8, #8');
  assert.equal(bundle.completeness, 'exact');
  const op = bundle.operations.find((operation) => operation.kind === 'value' && operation.opcode === 'a64-ubfm');
  assert.ok(op);
  assert.equal(op.metadata.immr, 8);
  assert.equal(op.metadata.imms, 15);
  assert.equal(op.metadata.alias, 'ubfx');
}

{
  const bundle = lift('bfi', 'x0, x1, #8, #8');
  assert.equal(bundle.completeness, 'exact');
  const bfm = bundle.operations.find((operation) => operation.kind === 'value' && operation.opcode === 'a64-bfm');
  assert.ok(bfm);
  assert.equal(bfm.inputs.length, 2, 'BFI reads both the old destination and insertion source');
  assert.ok(bundle.operations.some((operation) => operation.kind === 'register-read' && operation.register.registerId === 'x0'));
}

{
  const bundle = lift('extr', 'x0, x1, x2, #63');
  assert.equal(bundle.completeness, 'exact');
  const op = bundle.operations.find((operation) => operation.kind === 'value' && operation.opcode === 'extract-concat');
  assert.equal(op.metadata.lsb, 63);
  assert.equal(op.metadata.widthBits, 64);
}

{
  for (const [mnemonic, operands] of [
    ['sbfx','x0, x1, #4, #12'], ['ubfiz','x0, x1, #20, #8'], ['sbfiz','x0, x1, #20, #8'],
    ['bfxil','x0, x1, #4, #12'], ['bfc','x0, #8, #8'], ['ubfm','x0, x1, #8, #15'],
    ['sbfm','x0, x1, #8, #15'], ['bfm','x0, x1, #56, #7'],
  ]) assert.equal(lift(mnemonic, operands).completeness, 'exact', `${mnemonic} should lift exactly`);
}

{
  const partial = lift('ubfx', 'x0, x1, #60, #8');
  assert.equal(partial.completeness, 'partial');
  assert.equal(partial.unknownEffects.preservation, 'not-assumed');
  assert.match(partial.unknownEffects.reason, /bitfield-out-of-range/);
}

console.log('arm64 integer bitfield effects: PASS');
