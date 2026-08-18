import assert from 'node:assert/strict';
import test from 'node:test';

import { flagReads, flagWrites, lift, operations, registerReads, registerWrites } from './helpers.mjs';

const lowHalfCases = [
  ['cbw','rax','rax',8,16,'ax'],
  ['cwde','rax','rax',16,32,'eax'],
  ['cdqe','rax','rax',32,64,'rax'],
];

for (const [family, sourcePhysical, destinationPhysical, fromBits, toBits, destinationView] of lowHalfCases) {
  test(`${family} exactly sign-extends the implicit low register without touching flags`, () => {
    const bundle = lift(family);
    assert.equal(bundle.completeness, 'exact');
    assert.equal(registerReads(bundle, sourcePhysical).length >= 1, true);
    assert.equal(registerWrites(bundle, destinationPhysical).length, 1);
    assert.equal(registerWrites(bundle, destinationPhysical)[0].metadata.view, destinationView);
    assert.ok(operations(bundle, 'value').some((operation) => operation.opcode === 'sext'));
    assert.equal(bundle.metadata.operation, family);
    assert.equal(bundle.metadata.fromBits, fromBits);
    assert.equal(bundle.metadata.toBits, toBits);
    assert.equal(flagReads(bundle).length, 0);
    assert.equal(flagWrites(bundle).length, 0);
  });
}

const highHalfCases = [
  ['cwd','rax','rdx',16,32,'dx'],
  ['cdq','rax','rdx',32,64,'edx'],
  ['cqo','rax','rdx',64,128,'rdx'],
];

for (const [family, sourcePhysical, destinationPhysical, fromBits, toBits, destinationView] of highHalfCases) {
  test(`${family} exactly materializes the high half of the implicit sign extension`, () => {
    const bundle = lift(family);
    assert.equal(bundle.completeness, 'exact');
    assert.equal(registerReads(bundle, sourcePhysical).length >= 1, true);
    assert.equal(registerWrites(bundle, destinationPhysical).length, 1);
    assert.equal(registerWrites(bundle, destinationPhysical)[0].metadata.view, destinationView);
    assert.ok(operations(bundle, 'value').some((operation) => operation.opcode === 'sext'));
    const extract = operations(bundle, 'value').find((operation) => operation.opcode === 'extract' && operation.metadata.semantic === `x86-${family}-sign-extension-high-half`);
    assert.ok(extract);
    assert.equal(extract.metadata.lsb, fromBits);
    assert.equal(bundle.metadata.toBits, toBits);
    assert.equal(flagReads(bundle).length, 0);
    assert.equal(flagWrites(bundle).length, 0);
  });
}

test('implicit sign-extension instructions reject fabricated explicit operands', () => {
  const bundle = lift('cdqe', [{ type:'register', register:'eax', access:'read' }]);
  assert.equal(bundle.completeness, 'partial');
  assert.match(bundle.unknownEffects.reason, /unexpected-explicit-operands/);
});
