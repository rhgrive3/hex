import test from 'node:test';
import assert from 'node:assert/strict';
import { createX86DecodedInstruction } from '../../../../js/targets/architecture/x86_64/decoded-instruction.js';
import { liftX86MachineEffects } from '../../../../js/targets/architecture/x86_64/effects/index.js';
import { createCapstoneX86Session } from '../../helpers/capstone-session.mjs';

let sequence=0;
function effects(decoded){sequence+=1;return liftX86MachineEffects(decoded,{instructionId:`p5-3:real:${sequence}:${decoded.address.toString(16)}`});}
function ops(bundle,kind){return bundle.operations.filter((op)=>op.kind===kind);}

test('real decoder bytes preserve legacy/VEX structure before P5-3 effects', async () => {
  const decoder=await createCapstoneX86Session();
  try{
    const addssRaw=decoder.decode([0xf3,0x0f,0x58,0xc1],0x401000n)[0],addss=createX86DecodedInstruction({...addssRaw,instructionId:'p5-3:real:addss'});
    assert.equal(addss.length,4); assert.equal(addss.instructionFamily,'addss'); assert.equal(addss.rawBytes[0],0xf3); assert.equal(addss.detail.prefixes.vector,null); assert.equal(addss.detail.operands[0].register.id,'xmm0'); assert.equal(addss.detail.operands[1].register.id,'xmm1'); assert.equal(effects(addssRaw).completeness,'partial');

    const moveRaw=decoder.decode([0x0f,0x28,0xc1],0x401100n)[0],move=createX86DecodedInstruction({...moveRaw,instructionId:'p5-3:real:movaps'});
    assert.equal(move.length,3); assert.equal(move.instructionFamily,'movaps'); assert.equal(move.detail.operands[0].register.physicalId,'ymm0'); const moveBundle=effects(moveRaw); assert.equal(moveBundle.completeness,'exact'); assert.equal(moveBundle.metadata.upperLaneBehavior,'preserve-upper-128');

    const v128Raw=decoder.decode([0xc5,0xf0,0x57,0xc2],0x401200n)[0],v128=createX86DecodedInstruction({...v128Raw,instructionId:'p5-3:real:v128'});
    assert.equal(v128.instructionFamily,'vxorps'); assert.equal(v128.detail.prefixes.vector.kind,'vex2'); assert.deepEqual([...v128.detail.prefixes.vector.bytes],[0xc5,0xf0]); assert.deepEqual(v128.detail.operands.map((op)=>op.register.id),['xmm0','xmm1','xmm2']); const v128Bundle=effects(v128Raw); assert.equal(v128Bundle.completeness,'exact'); assert.equal(v128Bundle.metadata.vectorWidthBits,128); assert.equal(v128Bundle.metadata.upperLaneBehavior,'zero-upper-128');

    const v256Raw=decoder.decode([0xc5,0xf4,0x57,0xc2],0x401300n)[0],v256=createX86DecodedInstruction({...v256Raw,instructionId:'p5-3:real:v256'});
    assert.equal(v256.instructionFamily,'vxorps'); assert.deepEqual(v256.detail.operands.map((op)=>op.register.id),['ymm0','ymm1','ymm2']); const v256Bundle=effects(v256Raw); assert.equal(v256Bundle.completeness,'exact'); assert.equal(v256Bundle.metadata.vectorWidthBits,256); assert.equal(ops(v256Bundle,'register-write')[0].register.registerId,'ymm0');

    const zeroRaw=decoder.decode([0xc5,0xf8,0x77],0x401400n)[0],zero=createX86DecodedInstruction({...zeroRaw,instructionId:'p5-3:real:vzeroupper'}); assert.equal(zero.instructionFamily,'vzeroupper'); assert.equal(zero.detail.operandCount,0); assert.equal(effects(zeroRaw).completeness,'exact');

    const memRaw=decoder.decode([0x0f,0x10,0x00],0x401500n)[0],mem=createX86DecodedInstruction({...memRaw,instructionId:'p5-3:real:movups-memory'}); assert.equal(mem.instructionFamily,'movups'); assert.equal(mem.detail.operands[1].type,'memory'); assert.equal(mem.detail.operands[1].widthBits,128); assert.equal(mem.detail.operands[1].memory.base.id,'rax'); assert.equal(ops(effects(memRaw),'memory-read')[0].access.widthBits,128);

    const cmpRaw=decoder.decode([0x0f,0x2e,0xc1],0x401600n)[0],cmp=createX86DecodedInstruction({...cmpRaw,instructionId:'p5-3:real:ucomiss'}); assert.equal(cmp.instructionFamily,'ucomiss'); assert.equal(cmp.detail.operands[0].register.id,'xmm0'); const cmpBundle=effects(cmpRaw); assert.equal(cmpBundle.completeness,'partial'); assert.equal(ops(cmpBundle,'flag-write').length,6);

    const cvtRaw=decoder.decode([0xf2,0x0f,0x2a,0xc0],0x401700n)[0],cvt=createX86DecodedInstruction({...cvtRaw,instructionId:'p5-3:real:cvtsi2sd'}); assert.equal(cvt.instructionFamily,'cvtsi2sd'); assert.equal(cvt.rawBytes[0],0xf2); assert.equal(cvt.detail.operands[0].register.id,'xmm0'); assert.equal(cvt.detail.operands[1].register.id,'eax'); assert.equal(effects(cvtRaw).completeness,'partial');

    const fenceRaw=decoder.decode([0x0f,0xae,0xf0],0x401800n)[0],fence=createX86DecodedInstruction({...fenceRaw,instructionId:'p5-3:real:mfence'}); assert.equal(fence.instructionFamily,'mfence'); const fenceBundle=effects(fenceRaw); assert.equal(fenceBundle.completeness,'partial'); assert.equal(fenceBundle.metadata.operation,'mfence');

    const pauseRaw=decoder.decode([0xf3,0x90],0x401900n)[0],pause=createX86DecodedInstruction({...pauseRaw,instructionId:'p5-3:real:pause'}); assert.equal(pause.instructionFamily,'pause'); assert.deepEqual([...pause.rawBytes],[0xf3,0x90]); assert.equal(pause.detail.prefixes.vector,null); assert.equal(effects(pauseRaw).completeness,'exact');
  }finally{decoder.close();}
});
