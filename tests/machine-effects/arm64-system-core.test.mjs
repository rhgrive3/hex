import assert from 'node:assert/strict';
import { createInstructionId } from '../../js/core/identity/index.js';
import { validateMachineEffectBundle } from '../../js/semantics/effects/index.js';
import { liftArm64SystemEffects } from '../../js/targets/architecture/arm64/effects/system.js';

let address = 0x4000n;
function instruction(mnemonic, ops = [], operands = '') {
  const virtualAddress = address;
  address += 4n;
  const instructionId = createInstructionId({
    binaryId:'bin_arm64_system', sliceId:'slice_arm64_system', virtualAddress,
    decodeMode:'a64', decoderSemanticVersion:'1',
  });
  return { mnemonic, ops, operands, instructionId, origin:{ instructionIds:[instructionId] } };
}
const gp = (num) => ({ k:'reg', cls:'gp', num, bits:64, text:`x${num}` });
const sys = (text) => ({ k:'other', text });
const imm = (value) => ({ k:'imm', value:BigInt(value), text:`#${value}` });

{
  const effect = liftArm64SystemEffects(instruction('nop'));
  assert.equal(effect.completeness, 'exact');
  assert.equal(effect.operations.length, 0);
  assert.equal(effect.statePreservation.proven, true);
  assert.doesNotThrow(() => validateMachineEffectBundle(effect));
}

{
  const effect = liftArm64SystemEffects(instruction('dmb', [sys('ish')], 'ish'));
  assert.equal(effect.completeness, 'exact');
  assert.equal(effect.operations.length, 1);
  assert.equal(effect.operations[0].kind, 'barrier');
  assert.equal(effect.operations[0].scope.barrier, 'dmb');
  assert.equal(effect.operations[0].scope.domain, 'ish');
}

{
  const effect = liftArm64SystemEffects(instruction('isb', [sys('sy')], 'sy'));
  assert.equal(effect.operations[0].scope.semantics, 'instruction-synchronization');
}

{
  const effect = liftArm64SystemEffects(instruction('mrs', [gp(0), sys('tpidr_el0')], 'x0, tpidr_el0'));
  assert.equal(effect.completeness, 'exact-with-intrinsic');
  const intrinsic = effect.operations.find((op) => op.kind === 'intrinsic');
  assert.equal(intrinsic.intrinsicId, 'arm64.system.mrs.tpidr_el0');
  assert.ok(intrinsic.effectSummary.registersRead.includes('sys:tpidr_el0'));
  assert.ok(intrinsic.effectSummary.registersWritten.includes('x0'));
  assert.ok(effect.operations.some((op) => op.kind === 'register-write' && op.register.registerId === 'x0'));
  assert.ok(effect.possibleFaults.some((fault) => fault.kind === 'system-register-access-trap'));
}

{
  const effect = liftArm64SystemEffects(instruction('mrs', [gp(0), sys('cntvct_el0')], 'x0, cntvct_el0'));
  const intrinsic = effect.operations.find((op) => op.kind === 'intrinsic');
  assert.equal(intrinsic.effectSummary.determinism, 'nondeterministic', 'architectural counter reads are not deterministic constants');
}

{
  const effect = liftArm64SystemEffects(instruction('msr', [sys('tpidr_el0'), gp(1)], 'tpidr_el0, x1'));
  assert.equal(effect.completeness, 'exact-with-intrinsic');
  const intrinsic = effect.operations.find((op) => op.kind === 'intrinsic');
  assert.ok(intrinsic.effectSummary.registersRead.includes('x1'));
  assert.ok(intrinsic.effectSummary.registersWritten.includes('sys:tpidr_el0'));
}

{
  const effect = liftArm64SystemEffects(instruction('msr', [sys('some_impl_reg_el1'), gp(1)]));
  assert.equal(effect.completeness, 'partial');
  assert.ok(effect.unknownEffects.categories.includes('other'));
  assert.ok(effect.unknownEffects.categories.includes('faults'));
}

{
  const effect = liftArm64SystemEffects(instruction('clrex'));
  assert.equal(effect.completeness, 'exact-with-intrinsic');
  const intrinsic = effect.operations.find((op) => op.kind === 'intrinsic');
  assert.equal(intrinsic.metadata.architecturalStateWritten, 'local-exclusive-monitor');
  assert.equal(intrinsic.effectSummary.memoryRead.scope, 'none');
  assert.equal(intrinsic.effectSummary.memoryWrite.scope, 'none');
}

{
  const effect = liftArm64SystemEffects(instruction('svc', [imm(0x80)], '#0x80'));
  assert.equal(effect.completeness, 'partial');
  assert.equal(effect.controlEffect.kind, 'trap');
  assert.ok(effect.unknownEffects.categories.includes('registers'));
  const intrinsic = effect.operations.find((op) => op.kind === 'intrinsic');
  assert.equal(intrinsic.effectSummary.controlEffects[0].kind, 'trap');
}

{
  const effect = liftArm64SystemEffects(instruction('dc', [sys('zva'), gp(0)], 'zva, x0'));
  assert.equal(effect.completeness, 'partial');
  assert.ok(effect.unknownEffects.categories.includes('memory'), 'generic DC operations must not silently preserve memory');
}

{
  const effect = liftArm64SystemEffects(instruction('bti', [sys('c')], 'c'));
  assert.equal(effect.completeness, 'exact-with-intrinsic');
  assert.ok(effect.possibleFaults.some((fault) => fault.kind === 'branch-target-exception'));
  const intrinsic = effect.operations.find((op) => op.kind === 'intrinsic');
  assert.ok(intrinsic.effectSummary.registersRead.includes('pstate.btype'));
}

{
  const effect = liftArm64SystemEffects(instruction('hint', [imm(99)], '#99'));
  assert.equal(effect.completeness, 'partial');
  assert.match(effect.unknownEffects.reason, /hint-encoding/);
}

{
  assert.equal(liftArm64SystemEffects(instruction('paciasp')), null, 'arm64e pointer-authentication families are owned elsewhere');
}

console.log('arm64 system MachineEffects: PASS');
