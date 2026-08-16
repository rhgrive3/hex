import assert from 'node:assert/strict';
import { createInstructionId } from '../../js/core/identity/index.js';
import {
  ARM64E_PAUTH_KEYS,
  createArm64eEffectsExtension,
  extendArm64WithArm64eEffects,
  liftArm64eEffects,
} from '../../js/targets/architecture/arm64e/index.js';

function instruction(mnemonic, opStr = '', address = 0x1000n, serial = mnemonic) {
  const instructionId = createInstructionId({
    binaryId: 'bin_arm64e',
    sliceId: 'slice_arm64e',
    virtualAddress: address,
    decodeMode: 'arm64e',
    decoderSemanticVersion: `arm64e-test-${serial}`,
  });
  return {
    mnemonic,
    opStr,
    address,
    instructionId,
    origin: {
      instructionIds: [instructionId],
      byteRanges: [{ binaryId: 'bin_arm64e', start: address - 0x1000n, end: address - 0xffcn }],
      virtualRanges: [{ imageId: 'image_arm64e', sliceId: 'slice_arm64e', start: address, end: address + 4n }],
    },
  };
}

function intrinsic(bundle, id) {
  return bundle.operations.find((operation) => operation.kind === 'intrinsic' && operation.intrinsicId === id);
}

function writtenRegisters(bundle) {
  return bundle.operations
    .filter((operation) => operation.kind === 'register-write')
    .map((operation) => operation.register.registerId);
}

function readRegisters(bundle) {
  return bundle.operations
    .filter((operation) => operation.kind === 'register-read')
    .map((operation) => operation.register.registerId);
}

{
  const decoded = instruction('pacia', 'x2, x3');
  const bundle = liftArm64eEffects(decoded);
  const sign = intrinsic(bundle, 'arm64e.pointer.sign');
  assert.equal(bundle.completeness, 'exact-with-intrinsic');
  assert.ok(sign, 'PACIA must remain an explicit sign intrinsic');
  assert.equal(bundle.metadata.keyIdentity, ARM64E_PAUTH_KEYS.ia);
  assert.deepEqual(bundle.metadata.modifier, { kind: 'register', registerId: 'x3' });
  assert.equal(bundle.metadata.destinationRegister, 'x2');
  assert.ok(sign.effectSummary.inputs.some((value) => value.kind === 'temporary' && value.valueType.widthBits === 128), 'sign intrinsic must consume key state');
  assert.deepEqual(writtenRegisters(bundle), ['x2'], 'PACIA writes the destination register identity, not a generic pointer slot');
}

{
  const bundle = liftArm64eEffects(instruction('autdb', 'x5, x6', 0x1010n));
  const authenticate = intrinsic(bundle, 'arm64e.pointer.authenticate');
  assert.equal(bundle.completeness, 'exact-with-intrinsic');
  assert.ok(authenticate, 'AUTDB must remain an explicit authenticate intrinsic');
  assert.equal(bundle.metadata.keyIdentity, ARM64E_PAUTH_KEYS.db);
  assert.equal(bundle.metadata.destinationRegister, 'x5');
  assert.equal(bundle.possibleFaults[0].condition.kind, 'pointer-authentication-failed');
  assert.deepEqual(writtenRegisters(bundle), ['x5']);
}

{
  const bundle = liftArm64eEffects(instruction('xpaci', 'x7', 0x1020n));
  const strip = intrinsic(bundle, 'arm64e.pointer.strip');
  assert.ok(strip, 'XPACI must remain an explicit strip intrinsic');
  assert.equal(bundle.completeness, 'exact-with-intrinsic');
  assert.equal(bundle.metadata.destinationRegister, 'x7');
  assert.equal(bundle.metadata.pointerKind, 'instruction');
  assert.equal(strip.metadata.authenticationPerformed, false);
  assert.deepEqual(writtenRegisters(bundle), ['x7']);
}

{
  const bundle = liftArm64eEffects(instruction('paciasp', '', 0x1030n));
  assert.equal(bundle.metadata.destinationRegister, 'x30');
  assert.deepEqual(bundle.metadata.modifier, { kind: 'register', registerId: 'sp' });
  assert.ok(readRegisters(bundle).includes('x30'));
  assert.ok(readRegisters(bundle).includes('sp'), 'PACIASP must consume SP as the modifier');
  assert.ok(readRegisters(bundle).includes(ARM64E_PAUTH_KEYS.ia), 'PACIASP must consume the IA key identity');
  assert.ok(readRegisters(bundle).includes('PAuthState'), 'architecture state must be an explicit input');
}

{
  const bundle = liftArm64eEffects(instruction('pacib', 'x9, x10', 0x1040n));
  assert.equal(bundle.metadata.keyIdentity, ARM64E_PAUTH_KEYS.ib);
  assert.equal(bundle.metadata.destinationRegister, 'x9');
  assert.ok(readRegisters(bundle).includes(ARM64E_PAUTH_KEYS.ib));
  assert.deepEqual(writtenRegisters(bundle), ['x9']);
}

{
  const bundle = liftArm64eEffects(instruction('braa', 'x4, x5', 0x1050n));
  assert.equal(bundle.controlEffect.kind, 'branch');
  assert.equal(bundle.metadata.authenticatedControlTransfer, true);
  assert.equal(bundle.metadata.indirect, true);
  assert.equal(bundle.metadata.targetRegister, 'x4');
  assert.equal(bundle.metadata.keyIdentity, ARM64E_PAUTH_KEYS.ia);
  assert.deepEqual(bundle.metadata.modifier, { kind: 'register', registerId: 'x5' });
  assert.ok(intrinsic(bundle, 'arm64e.pointer.authenticate'));
  assert.deepEqual(writtenRegisters(bundle), [], 'authenticated branch does not create a link-register write');
}

{
  const decoded = instruction('blraaz', 'x6', 0x1060n);
  const bundle = liftArm64eEffects(decoded);
  assert.equal(bundle.controlEffect.kind, 'call');
  assert.equal(bundle.metadata.authenticatedControlTransfer, true);
  assert.equal(bundle.metadata.targetRegister, 'x6');
  assert.deepEqual(bundle.metadata.modifier, { kind: 'constant-zero' });
  assert.equal(bundle.metadata.keyIdentity, ARM64E_PAUTH_KEYS.ia);
  const lrWrite = bundle.operations.find((operation) => operation.kind === 'register-write' && operation.register.registerId === 'x30');
  assert.ok(lrWrite, 'authenticated call must write the architectural link register');
  assert.equal(lrWrite.value.kind, 'bitvector');
  assert.equal(lrWrite.value.value, (decoded.address + 4n).toString());
}

{
  const bundle = liftArm64eEffects(instruction('retab', '', 0x1070n));
  assert.equal(bundle.controlEffect.kind, 'return');
  assert.equal(bundle.metadata.authenticatedControlTransfer, true);
  assert.equal(bundle.metadata.targetRegister, 'x30');
  assert.equal(bundle.metadata.keyIdentity, ARM64E_PAUTH_KEYS.ib);
  assert.deepEqual(bundle.metadata.modifier, { kind: 'register', registerId: 'sp' });
  assert.ok(readRegisters(bundle).includes('x30'));
  assert.ok(readRegisters(bundle).includes('sp'));
  assert.deepEqual(writtenRegisters(bundle), [], 'RETAB authenticates the branch target without inventing a destination-register write');
}

{
  const bundle = liftArm64eEffects(instruction('pacga', 'x0, x1, x2', 0x1080n));
  assert.ok(intrinsic(bundle, 'arm64e.pointer.generic-code'));
  assert.equal(bundle.metadata.keyIdentity, ARM64E_PAUTH_KEYS.ga);
  assert.equal(bundle.metadata.destinationRegister, 'x0');
  assert.deepEqual(writtenRegisters(bundle), ['x0']);
}

{
  const bundle = liftArm64eEffects(instruction('braa', 'x4', 0x1090n, 'missing-modifier'));
  assert.equal(bundle.completeness, 'partial', 'missing modifier identity must never become a zero/default modifier');
  assert.equal(bundle.controlEffect.kind, 'unknown');
  assert.ok(bundle.unknownEffects.categories.includes('control'));
  assert.ok(bundle.unknownEffects.categories.includes('registers'));
  assert.equal(bundle.unknownEffects.preservation, 'not-assumed');
}

{
  const decoded = instruction('pacia', 'x11, x12', 0x10a0n, 'provenance');
  const bundle = liftArm64eEffects(decoded);
  assert.deepEqual(bundle.origin.instructionIds, [decoded.instructionId]);
  assert.deepEqual(bundle.origin.byteRanges, [{ binaryId: 'bin_arm64e', start: '160', end: '164' }]);
  assert.deepEqual(bundle.origin.virtualRanges, [{ imageId: 'image_arm64e', sliceId: 'slice_arm64e', start: '0x10a0', end: '0x10a4' }]);
}

{
  const decoded = instruction('blraa', 'x8, x9', 0x10b0n, 'missing-address');
  delete decoded.address;
  const bundle = liftArm64eEffects(decoded);
  assert.equal(bundle.completeness, 'partial');
  assert.ok(bundle.unknownEffects.categories.includes('registers'));
  assert.equal(bundle.controlEffect.kind, 'call', 'known authenticated control flow survives a missing link value');
}

{
  const baseCalls = [];
  const base = (decoded, context) => {
    baseCalls.push([decoded.mnemonic, context.marker]);
    return { base: true, mnemonic: decoded.mnemonic };
  };
  const lift = extendArm64WithArm64eEffects(base);
  const baseResult = lift({ mnemonic: 'add' }, { marker: 7 });
  assert.deepEqual(baseResult, { base: true, mnemonic: 'add' });
  assert.deepEqual(baseCalls, [['add', 7]], 'non-arm64e instructions must delegate to the ARM64 base lifter');

  const extension = createArm64eEffectsExtension(base);
  assert.equal(extension.architectureId, 'arm64e');
  assert.equal(extension.canHandle({ mnemonic: 'retaa' }), true);
  const arm64eResult = extension.liftExact(instruction('retaa', '', 0x10c0n), { marker: 9 });
  assert.equal(arm64eResult.architectureId, 'arm64e');
  assert.deepEqual(baseCalls, [['add', 7]], 'arm64e-specific instructions must refine instead of falling through to base');
}

assert.equal(liftArm64eEffects({ mnemonic: 'add' }), null, 'base ARM64 families remain outside this extension');

console.log('arm64e machine effects: PASS');
