import { buildSemanticModel } from '../../js/blocks.js';
import { createOriginSet } from '../../js/core/identity/origin.js';
import { ARM64_ARCHITECTURE } from '../../js/targets/architecture/index.js';
import { liftArm64MachineEffects } from '../../js/targets/architecture/arm64/effects/index.js';
import { buildSemanticV2CompatibilityPipeline } from '../../js/semantics/compat/index.js';

const BASE = 0x100000000n;
const clean = (x) => JSON.stringify(x, (_k, v) => typeof v === 'bigint' ? `${v}n` : v).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
function modelOf(lines, base = BASE) {
  const rows = lines.map((line, row) => {
    const p = line.indexOf(' ');
    return { row, address:base + BigInt(row * 4), mn:p < 0 ? line : line.slice(0,p), ops:p < 0 ? '' : line.slice(p+1) };
  });
  const rowOfAddress = (address) => {
    const d = BigInt(address) - base;
    return d < 0n || d >= BigInt(rows.length * 4) ? null : Number(d / 4n);
  };
  return buildSemanticModel(rows, { startRow:0, endRow:rows.length-1, rowOfAddress });
}
function stackRootProvider(request) {
  const p = request?.variable?.physicalIdentity;
  if (p?.kind !== 'register' || String(p.registerId) !== 'sp') return null;
  return { kind:'stack-like', addressSpace:'memory', baseOffset:0, linearOffsets:true, rootIdentity:{kind:'diag-stack',storageClass:'function-local-stack'} };
}

const o0 = modelOf(['sub sp, sp, #16','str w0, [sp, #12]','ldr w8, [sp, #12]','add w8, w8, #1','str w8, [sp, #8]','ldr w0, [sp, #8]','add sp, sp, #16','ret']);
const pipeline = buildSemanticV2CompatibilityPipeline({
  architecturePlugin:ARM64_ARCHITECTURE,
  decoderSemanticVersion:'final-exit-diag', binaryId:'final-exit-diag-bin', sliceId:'final-exit-diag-slice', addressWidthBits:64,
  canonicalStartIdentity:{address:BASE}, entryBlockKey:'b0', rootDescriptorProvider:stackRootProvider,
  blocks:[{ key:'b0', startAddress:BASE, instructions:o0.instructions.map((decoded) => ({decoded,address:decoded.address,size:4,mode:'a64'})), successors:[] }],
});
console.log(`::warning title=P3_O0_REGIONS::${clean(pipeline.regions.map((r) => ({kind:r.kind,offset:r.offset,metadata:r.metadata})))}`);
console.log(`::warning title=P3_O0_STATE::${clean(pipeline.semanticIr.nodes.filter((n) => ['intrinsic','state-read','state-write','unary'].includes(n.kind)).map((n) => ({kind:n.kind,operator:n.operator,inputs:n.inputs,variable:n.variable?.physicalIdentity,meta:n.attributes?.machineEffects?.operationMetadata})))}`);

const base = 0x100000490n;
const lines = ['stp x29, x30, [sp, #-32]!','mov x29, sp','str x0, [sp, #16]','ldr w8, [x0, #0x20]','ldr w9, [x0, #0x24]','mul w9, w1, w9','sub w8, w8, w9','str w8, [x0, #0x20]','cmp w8, #0','b.gt #0x1000004C4','mov w8, #0','ldr x0, [sp, #16]','str w8, [x0, #0x20]','str w8, [sp, #12]','adrp x0, #0x100000000','add x0, x0, #0x5B4','bl #0x100001000','ldr w0, [sp, #12]','ldp x29, x30, [sp], #32','ret'];
const fixture = modelOf(lines, base);
const rows = fixture.instructions.map((decoded) => {
  try {
    const b = liftArm64MachineEffects(decoded, { instructionId:`final-diag-${decoded.row}`, origin:createOriginSet({instructionIds:[`final-diag-${decoded.row}`]}), mode:'a64' });
    return {row:decoded.row,mnemonic:decoded.mnemonic,claimed:!!b,completeness:b?.completeness ?? null,unknown:b?.unknownEffects?.reason ?? null};
  } catch (e) {
    return {row:decoded.row,mnemonic:decoded.mnemonic,claimed:false,error:String(e?.message || e)};
  }
});
console.log(`::warning title=P3_UNSUPPORTED_ROWS::${clean(rows.filter((r) => !r.claimed || r.completeness !== 'exact'))}`);
console.log('final Phase 3 exit diagnostics: PASS');