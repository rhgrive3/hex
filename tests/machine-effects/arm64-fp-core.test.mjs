import assert from 'node:assert/strict';
import { createInstructionId } from '../../js/core/identity/index.js';
import { validateMachineEffectBundle } from '../../js/semantics/effects/index.js';
import { liftArm64FpEffects } from '../../js/targets/architecture/arm64/effects/fp.js';

let address = 0x2000n;
function instruction(mnemonic, ops, operands = '') {
  const virtualAddress = address;
  address += 4n;
  const instructionId = createInstructionId({
    binaryId:'bin_arm64_fp', sliceId:'slice_arm64_fp', virtualAddress,
    decodeMode:'a64', decoderSemanticVersion:'1',
  });
  return { mnemonic, ops, operands, instructionId, origin:{ instructionIds:[instructionId] } };
}
const fp = (num, bits, prefix) => ({ k:'reg', cls:'fp', num, bits, text:`${prefix}${num}` });
const gp = (num, bits = 64) => ({ k:'reg', cls:'gp', num, bits, text:`${bits === 32 ? 'w' : 'x'}${num}` });
const immFloat = (value, text = `#${value}`) => ({ k:'imm', value:null, float:value, text });

{
  const effect = liftArm64FpEffects(instruction('fadd', [fp(0,32,'s'), fp(1,32,'s'), fp(2,32,'s')]));
  assert.equal(effect.completeness, 'exact-with-intrinsic', 'FP arithmetic must not pretend primitive IEEE exactness');
  const intrinsic = effect.operations.find((op) => op.kind === 'intrinsic');
  assert.equal(intrinsic.intrinsicId, 'arm64.fp.fadd');
  assert.deepEqual(intrinsic.effectSummary.registersRead.sort(), ['fpcr','fpsr','v1','v2'].sort());
  assert.deepEqual(intrinsic.effectSummary.registersWritten.sort(), ['fpsr','v0'].sort());
  const result = intrinsic.effectSummary.outputs[0];
  assert.equal(result.valueType.kind, 'float');
  assert.equal(result.valueType.widthBits, 32, 'S-register FP width must remain 32-bit');
  const write = effect.operations.find((op) => op.kind === 'register-write' && op.register.registerId === 'v0');
  assert.equal(write.register.widthBits, 32);
  assert.equal(write.register.view, 's0');
  assert.doesNotThrow(() => validateMachineEffectBundle(effect));
}

{
  const effect = liftArm64FpEffects(instruction('fdiv', [fp(3,64,'d'), fp(4,64,'d'), fp(5,64,'d')]));
  const intrinsic = effect.operations.find((op) => op.kind === 'intrinsic');
  assert.equal(intrinsic.effectSummary.outputs[0].valueType.widthBits, 64, 'D-register FP width must remain 64-bit');
  assert.equal(effect.metadata.destinationWidthBits, 64);
}

{
  const effect = liftArm64FpEffects(instruction('fcvtzs', [gp(0,32), fp(1,64,'d')]));
  assert.equal(effect.completeness, 'exact-with-intrinsic');
  assert.equal(effect.metadata.destinationWidthBits, 32);
  assert.equal(effect.metadata.roundingMode, 'toward-zero');
  const intrinsic = effect.operations.find((op) => op.kind === 'intrinsic');
  assert.equal(intrinsic.effectSummary.outputs[0].valueType.kind, 'bitvector');
  assert.equal(intrinsic.effectSummary.outputs[0].valueType.widthBits, 32, 'conversion result width must match W destination');
  const physicalWrite = effect.operations.find((op) => op.kind === 'register-write' && op.register.registerId === 'x0');
  assert.equal(physicalWrite.register.widthBits, 64, 'W writes must model the architectural zero-extension into X');
  assert.equal(physicalWrite.metadata.architecturalViewWritten, 'w0');
  assert.ok(intrinsic.effectSummary.registersRead.includes('fpcr'));
  assert.ok(intrinsic.effectSummary.registersWritten.includes('fpsr'));
}

{
  const effect = liftArm64FpEffects(instruction('fcmp', [fp(0,64,'d'), immFloat(0, '#0.0')]));
  assert.equal(effect.completeness, 'exact-with-intrinsic');
  const intrinsic = effect.operations.find((op) => op.kind === 'intrinsic');
  assert.ok(intrinsic.effectSummary.registersWritten.includes('nzcv'));
  assert.ok(intrinsic.effectSummary.registersWritten.includes('fpsr'));
  assert.ok(effect.operations.some((op) => op.kind === 'register-write' && op.register.registerId === 'nzcv'));
}

{
  const effect = liftArm64FpEffects(instruction('fmov', [fp(0,64,'d'), fp(1,64,'d')]));
  assert.equal(effect.completeness, 'exact', 'register-to-register FMOV is a bit-preserving move');
  assert.ok(effect.operations.some((op) => op.kind === 'value' && op.opcode === 'arm64.fp.bitcopy'));
  assert.equal(effect.operations.some((op) => op.kind === 'intrinsic'), false);
}

{
  const effect = liftArm64FpEffects(instruction('fmov', [fp(0,64,'d'), immFloat(1.5, '#1.5')]));
  assert.equal(effect.completeness, 'partial', 'parsed decimal FP immediates must not be claimed bit-exact without their encoded bit pattern');
  assert.deepEqual(effect.unknownEffects.categories, ['other']);
}

{
  const effect = liftArm64FpEffects(instruction('fadd', [], 'z0.s, z1.s, z2.s'));
  assert.equal(effect.completeness, 'partial');
  assert.match(effect.unknownEffects.reason, /sve-scalable-vector/);
}

console.log('arm64 fp MachineEffects: PASS');
