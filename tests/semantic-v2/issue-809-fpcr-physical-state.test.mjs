import assert from 'node:assert/strict';
import { liftArm64FpEffects } from '../../js/targets/architecture/arm64/effects/fp.js';

function fp(num,bits,text){return{k:'reg',cls:'fp',num,bits,text};}
function cond(text){return{k:'cond',text};}

function assertPhysicalFpcrWrite(bundle, dst) {
  const write = bundle.operations.find((op) => op.kind === 'register-write' && op.register?.registerId === dst);
  assert.ok(write, `${dst} physical write`);
  assert.equal(write.register.widthBits, 128);
  assert.equal(write.metadata?.upperLaneBehavior, 'fpcr-dependent-architectural-intrinsic');
  assert.ok(bundle.operations.some((op) => op.kind === 'register-read' && op.register?.registerId === 'fpcr'));
  assert.ok(bundle.operations.some((op) => op.kind === 'register-read' && op.register?.registerId === dst && op.register?.widthBits === 128), 'old physical destination is available to merge behavior');
}

for (const [mnemonic,bits] of [['fadd',32],['fadd',64],['fmadd',32]]) {
  const ops = mnemonic === 'fmadd'
    ? [fp(0,bits,bits===32?'s0':'d0'),fp(1,bits,bits===32?'s1':'d1'),fp(2,bits,bits===32?'s2':'d2'),fp(3,bits,bits===32?'s3':'d3')]
    : [fp(0,bits,bits===32?'s0':'d0'),fp(1,bits,bits===32?'s1':'d1'),fp(2,bits,bits===32?'s2':'d2')];
  const bundle=liftArm64FpEffects({instructionId:`${mnemonic}-${bits}`,mnemonic,ops});
  assert.equal(bundle.completeness,'exact-with-intrinsic');
  assertPhysicalFpcrWrite(bundle,'v0');
}

{
  const bundle=liftArm64FpEffects({instructionId:'fcsel-32',mnemonic:'fcsel',ops:[fp(0,32,'s0'),fp(1,32,'s1'),fp(2,32,'s2'),cond('eq')]});
  assertPhysicalFpcrWrite(bundle,'v0');
}

// Exact scalar bitwise views still define one canonical 128-bit V register and
// explicitly encode their zero-upper projection instead of creating a 32/64-bit physical cell.
for (const mnemonic of ['fmov','fabs','fneg']) {
  const bundle=liftArm64FpEffects({instructionId:`${mnemonic}-view`,mnemonic,ops:[fp(0,32,'s0'),fp(1,32,'s1')]});
  const write=bundle.operations.find((op)=>op.kind==='register-write'&&op.register?.registerId==='v0');
  assert.equal(write?.register.widthBits,128);
  assert.ok(bundle.operations.some((op)=>op.kind==='value'&&op.opcode==='arm64.simd.scalar-write-zero-upper'));
}

console.log('issue #809 FPCR/cross-view physical state regressions: ok');
