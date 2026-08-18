import test from 'node:test';
import assert from 'node:assert/strict';
import { effects, reg, legacyPrefix, vex2, ops, physicalWrites } from './helpers.mjs';

function valueOps(bundle) {
  return ops(bundle, 'value');
}

test('legacy PANDN exact semantics match compiler-emitted 66 0f df f3', () => {
  const bundle = effects('pandn', [reg('xmm6','read-write'), reg('xmm3','read')], {
    prefixes:legacyPrefix(0x66),
    rawBytes:[0x66,0x0f,0xdf,0xf3],
    instructionId:'p5-i:pandn:660fdff3',
    mnemonic:'pandn',
  });

  assert.equal(bundle.completeness, 'exact');
  assert.equal(bundle.metadata.bitwiseOperation, 'and-not');
  assert.equal(bundle.metadata.exactFormula, '(~left) & right');
  assert.equal(bundle.metadata.upperLaneBehavior, 'preserve-upper-128');
  assert.deepEqual(valueOps(bundle).filter((op) => ['xor','and'].includes(op.opcode)).map((op) => op.opcode), ['xor','and']);
  assert.equal(physicalWrites(bundle, 'ymm6').length, 1);
  assert.equal(ops(bundle, 'flag-write').length, 0);
});

test('VPANDN uses independent source and VEX upper-lane rules', () => {
  const bundle = effects('vpandn', [reg('xmm0','write'), reg('xmm1','read'), reg('xmm2','read')], {
    prefixes:vex2(0xf8),
    rawBytes:[0xc5,0xf1,0xdf,0xc2],
    instructionId:'p5-i:vpandn:128',
    mnemonic:'vpandn',
  });

  assert.equal(bundle.completeness, 'exact');
  assert.equal(bundle.metadata.bitwiseOperation, 'and-not');
  assert.equal(bundle.metadata.upperLaneBehavior, 'zero-upper-128');
  assert.equal(physicalWrites(bundle, 'ymm0').length, 1);
  assert.ok(valueOps(bundle).some((op) => op.opcode === 'zext' && op.metadata?.toBits === 256));
});
