import assert from 'node:assert/strict';
import { createInstructionId } from '../../js/core/identity/index.js';
import { validateMachineEffectBundle } from '../../js/semantics/effects/index.js';
import { liftArm64SimdEffects } from '../../js/targets/architecture/arm64/effects/simd.js';

let address = 0x3000n;
function instruction(mnemonic, ops, operands = '') {
  const virtualAddress = address;
  address += 4n;
  const instructionId = createInstructionId({
    binaryId:'bin_arm64_simd', sliceId:'slice_arm64_simd', virtualAddress,
    decodeMode:'a64', decoderSemanticVersion:'1',
  });
  return { mnemonic, ops, operands, instructionId, origin:{ instructionIds:[instructionId] } };
}
const vec = (num, arr) => ({ k:'reg', cls:'vec', num, bits:128, arr, text:`v${num}.${arr}` });
const elem = (num, size, index) => ({ k:'elem', num, size, index, text:`v${num}.${size}[${index}]` });
const gp = (num, bits = 64) => ({ k:'reg', cls:'gp', num, bits, text:`${bits === 32 ? 'w' : 'x'}${num}` });

{
  const effect = liftArm64SimdEffects(instruction('add', [vec(0,'4s'), vec(1,'4s'), vec(2,'4s')]));
  assert.equal(effect.completeness, 'exact-with-intrinsic');
  assert.equal(effect.metadata.laneCount, 4);
  assert.equal(effect.metadata.laneWidthBits, 32);
  const intrinsic = effect.operations.find((op) => op.kind === 'intrinsic');
  assert.equal(intrinsic.intrinsicId, 'arm64.simd.add');
  assert.equal(intrinsic.effectSummary.outputs[0].valueType.kind, 'vector');
  assert.equal(intrinsic.effectSummary.outputs[0].valueType.laneCount, 4);
  assert.equal(intrinsic.effectSummary.outputs[0].valueType.elementType.widthBits, 32);
  const write = effect.operations.find((op) => op.kind === 'register-write' && op.register.registerId === 'v0');
  assert.equal(write.register.widthBits, 128);
  assert.equal(write.register.view, 'v0.4s');
  assert.doesNotThrow(() => validateMachineEffectBundle(effect));
}

{
  const effect = liftArm64SimdEffects(instruction('add', [vec(3,'8h'), vec(4,'8h'), vec(5,'8h')]));
  assert.equal(effect.metadata.laneCount, 8);
  assert.equal(effect.metadata.laneWidthBits, 16, 'lane identity must not be flattened to a generic 128-bit integer');
}

{
  const effect = liftArm64SimdEffects(instruction('ins', [elem(0,'s',2), gp(1,32)]));
  assert.equal(effect.completeness, 'exact-with-intrinsic');
  const intrinsic = effect.operations.find((op) => op.kind === 'intrinsic');
  assert.equal(intrinsic.metadata.destinationLane, 2);
  assert.equal(intrinsic.metadata.laneWidthBits, 32);
  assert.ok(intrinsic.effectSummary.registersRead.includes('v0'), 'lane insert must read the preserved destination lanes');
  const write = effect.operations.find((op) => op.kind === 'register-write' && op.register.registerId === 'v0');
  assert.equal(write.metadata.laneWritten, 2);
}

{
  const effect = liftArm64SimdEffects(instruction('umov', [gp(0,32), elem(1,'b',7)]));
  assert.equal(effect.metadata.laneIndex, 7);
  assert.equal(effect.metadata.laneWidthBits, 8);
  const physicalWrite = effect.operations.find((op) => op.kind === 'register-write' && op.register.registerId === 'x0');
  assert.equal(physicalWrite.register.widthBits, 64, 'W destination must include architectural zero-extension');
  assert.equal(physicalWrite.metadata.architecturalViewWritten, 'w0');
}

{
  const effect = liftArm64SimdEffects(instruction('sqxtn', [vec(0,'4h'), vec(1,'4s')]));
  assert.equal(effect.completeness, 'exact-with-intrinsic');
  const intrinsic = effect.operations.find((op) => op.kind === 'intrinsic');
  assert.ok(intrinsic.effectSummary.registersRead.includes('fpsr'), 'saturating narrow must consume cumulative saturation state');
  assert.ok(intrinsic.effectSummary.registersWritten.includes('fpsr'), 'saturating narrow must update cumulative saturation state');
}

{
  const effect = liftArm64SimdEffects(instruction('fadd', [vec(0,'4s'), vec(1,'4s'), vec(2,'4s')]));
  const intrinsic = effect.operations.find((op) => op.kind === 'intrinsic');
  assert.ok(intrinsic.effectSummary.registersRead.includes('fpcr'));
  assert.ok(intrinsic.effectSummary.registersRead.includes('fpsr'));
  assert.ok(intrinsic.effectSummary.registersWritten.includes('fpsr'));
  assert.equal(intrinsic.effectSummary.outputs[0].valueType.elementType.kind, 'float');
}

{
  const effect = liftArm64SimdEffects(instruction('add', [], 'z0.s, z1.s, z2.s'));
  assert.equal(effect.completeness, 'partial');
  assert.match(effect.unknownEffects.reason, /sve-scalable-vector/);
}

{
  const effect = liftArm64SimdEffects(instruction('mysteryvec', [vec(0,'16b'), vec(1,'16b')]));
  assert.equal(effect.completeness, 'partial');
  assert.match(effect.unknownEffects.reason, /simd-instruction-unsupported/);
}

console.log('arm64 SIMD MachineEffects: PASS');
