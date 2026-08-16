import { buildSemanticModel } from '../../js/blocks.js';
import { buildIR, OP, setSemanticMigrationMode } from '../../js/ir.js';
import { buildSemanticV2CompatibilityPipeline, SEMANTIC_V2_MIGRATION_MODES } from '../../js/semantics/compat/index.js';
import { ARM64_ARCHITECTURE } from '../../js/targets/architecture/index.js';

const clean = (x) => JSON.stringify(x, (_k,v)=>typeof v==='bigint'?`${v}n`:v).replace(/%/g,'%25').replace(/\r/g,'%0D').replace(/\n/g,'%0A');
function fixture(lines, base, name) {
  const rows=lines.map((line,row)=>{const p=line.indexOf(' ');return{row,address:base+BigInt(row*4),mn:p<0?line:line.slice(0,p),ops:p<0?'':line.slice(p+1)}});
  const rowOfAddress=(a)=>{const d=BigInt(a)-base;return d<0n||d>=BigInt(rows.length*4)?null:Number(d/4n)};
  return {model:buildSemanticModel(rows,{startRow:0,endRow:rows.length-1,rowOfAddress,name}),rowOfAddress};
}
const arg=(a)=>({id:a?.value?.id,reg:a?.value?.reg,kind:a?.value?.kind,bits:a?.value?.bits,def:a?.value?.def?{op:a.value.def.op,sub:a.value.def.sub,row:a.value.def.row,block:a.value.def.block}:null});
const inst=(i)=>i?{id:i.id,op:i.op,sub:i.sub,row:i.row,block:i.block,cond:i.cond,dst:i.dst?{id:i.dst.id,reg:i.dst.reg,kind:i.dst.kind,bits:i.dst.bits}:null,args:(i.args||[]).map(arg),loc:i.loc?{kind:i.loc.kind,disp:i.loc.disp,key:i.loc.key,base:i.loc.base?{id:i.loc.base.id,reg:i.loc.base.reg,kind:i.loc.base.kind}:null,regionId:i.loc.regionId}:null,addr:i.addr?{baseReg:i.addr.baseReg,disp:i.addr.disp,precise:i.addr.precise}:null}:null;
const val=(v)=>({id:v.id,reg:v.reg,kind:v.kind,bits:v.bits,version:v.version,compatDerived:v.compatDerived,def:v.def?{op:v.def.op,sub:v.def.sub,row:v.def.row,block:v.def.block}:null,uses:(v.uses||[]).map((u)=>({op:u.op,row:u.row,block:u.block}))});
function rootDescriptorProvider(request){const p=request?.variable?.physicalIdentity;if(p?.kind!=='register')return null; if(p.registerId==='sp')return{kind:'stack-like',addressSpace:'memory',baseOffset:0,linearOffsets:true,rootIdentity:{kind:'diag-stack',storageClass:'function-local-stack'}};if(/^x[0-7]$/.test(String(p.registerId)))return{kind:'entry-state',addressSpace:'memory',baseOffset:0,linearOffsets:true,rootIdentity:{kind:'diag-arg',registerId:p.registerId,storageClass:'entry-argument-storage'}};return null;}

setSemanticMigrationMode(SEMANTIC_V2_MIGRATION_MODES.V2_COMPAT);
try {
  const PRE=0x200000n;
  const pre=fixture(['cmp w0, w1','csel w0, w0, w1, gt','ret'],PRE,'max_prebuilt');
  const preir=buildIR(pre.model,{rowOfAddress:pre.rowOfAddress,returnType:'int32',decoderSemanticVersion:'pre-diag'});
  console.log(`::warning title=P3_PRE_SELECT::${clean({instructions:preir.instructions.filter((i)=>i.row<=2).map(inst),x0:preir.values.filter((v)=>v.reg==='x0').map(val),x1:preir.values.filter((v)=>v.reg==='x1').map(val)})}`);

  const base=0x100000490n;
  const lines=['stp x29, x30, [sp, #-32]!','mov x29, sp','str x0, [sp, #16]','ldr w8, [x0, #0x20]','ldr w9, [x0, #0x24]','mul w9, w1, w9','sub w8, w8, w9','str w8, [x0, #0x20]','cmp w8, #0','b.gt #0x1000004C4','mov w8, #0','ldr x0, [sp, #16]','str w8, [x0, #0x20]','str w8, [sp, #12]','adrp x0, #0x100000000','add x0, x0, #0x5B4','bl #0x100001000','ldr w0, [sp, #12]','ldp x29, x30, [sp], #32','ret'];
  const x=fixture(lines,base,'apply_damage');
  const opts={rowOfAddress:x.rowOfAddress,returnType:'int32',decoderSemanticVersion:'apply-diag'};
  const ir=buildIR(x.model,opts);
  const pipe=buildSemanticV2CompatibilityPipeline({architecturePlugin:ARM64_ARCHITECTURE,decoderSemanticVersion:'apply-region-diag',binaryId:'apply-diag',sliceId:'apply-diag',addressWidthBits:64,canonicalStartIdentity:{address:base},entryBlockKey:'b0',rootDescriptorProvider,blocks:[{key:'b0',startAddress:base,instructions:x.model.instructions.map((decoded)=>({decoded,address:decoded.address,size:4,mode:'a64'})),successors:[]}]});
  console.log(`::warning title=P3_APPLY_CONCISE::${clean({memory:ir.instructions.filter((i)=>i.op===OP.LOAD||i.op===OP.STORE).map(inst),phis:ir.instructions.filter((i)=>i.op===OP.PHI).map(inst),ret:inst(ir.instructions.find((i)=>i.op===OP.RET)),x0:ir.values.filter((v)=>v.reg==='x0').map(val),regions:pipe.regions.map((r)=>({id:r.id,kind:r.kind,offset:r.offset,rootEntityId:r.rootEntityId,metadata:r.metadata}))})}`);
} finally { setSemanticMigrationMode(SEMANTIC_V2_MIGRATION_MODES.LEGACY); }
console.log('final concise Phase 3 diagnostics: PASS');