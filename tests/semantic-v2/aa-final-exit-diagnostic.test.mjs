import { buildSemanticModel } from '../../js/blocks.js';
import { buildIR, OP, setSemanticMigrationMode } from '../../js/ir.js';
import { buildSemanticV2CompatibilityPipeline, SEMANTIC_V2_MIGRATION_MODES } from '../../js/semantics/compat/index.js';
import { ARM64_ARCHITECTURE } from '../../js/targets/architecture/index.js';

const clean=(x)=>JSON.stringify(x,(_k,v)=>typeof v==='bigint'?`${v}n`:v).replace(/%/g,'%25').replace(/\r/g,'%0D').replace(/\n/g,'%0A');
const base=0x100000490n;
const lines=['stp x29, x30, [sp, #-32]!','mov x29, sp','str x0, [sp, #16]','ldr w8, [x0, #0x20]','ldr w9, [x0, #0x24]'];
const rows=lines.map((line,row)=>{const p=line.indexOf(' ');return{row,address:base+BigInt(row*4),mn:p<0?line:line.slice(0,p),ops:p<0?'':line.slice(p+1)}});
const rowOfAddress=(a)=>{const d=BigInt(a)-base;return d<0n||d>=BigInt(rows.length*4)?null:Number(d/4n)};
const model=buildSemanticModel(rows,{startRow:0,endRow:rows.length-1,rowOfAddress,name:'writeback_region_diag'});
function roots(request){const p=request?.variable?.physicalIdentity;if(p?.kind!=='register')return null;const id=String(p.registerId||'');if(id==='sp')return{kind:'stack-like',addressSpace:'memory',baseOffset:0,linearOffsets:true,rootIdentity:{kind:'abi-storage-root',storageClass:'function-local-stack',registerId:id}};if(/^x[0-7]$/.test(id))return{kind:'rooted-object',addressSpace:'memory',baseOffset:0,linearOffsets:true,rootIdentity:{kind:'abi-entry-argument-root',storageClass:'external-entry-memory',registerId:id}};return null;}
const blocks=[{key:'b0',startAddress:base,instructions:model.instructions.map((decoded)=>({decoded,address:decoded.address,size:4,mode:'a64'})),successors:[]}];
const pipe=buildSemanticV2CompatibilityPipeline({architecturePlugin:ARM64_ARCHITECTURE,decoderSemanticVersion:'writeback-region-diag',binaryId:'writeback-region-diag',sliceId:'writeback-region-diag',addressWidthBits:64,canonicalStartIdentity:{address:base},entryBlockKey:'b0',rootDescriptorProvider:roots,blocks});
const nodeRow=(n)=>{const a=n?.origin?.virtualRanges?.[0]?.start;return a==null?null:rowOfAddress(a)};
console.log(`::warning title=P3_REGION_MIN::${clean({
  states:pipe.semanticIr.nodes.filter((n)=>['state-read','state-write','binary','address'].includes(n.kind)&&nodeRow(n)<=4).map((n)=>({row:nodeRow(n),kind:n.kind,op:n.operator,inputs:n.inputs,outputs:n.outputs,variable:n.variable?.physicalIdentity,meta:n.attributes?.machineEffects?.operationMetadata})),
  regions:pipe.regions.map((r)=>({kind:r.kind,offset:r.offset,rootEntityId:r.rootEntityId,metadata:r.metadata,uncertaintyIdentity:r.uncertaintyIdentity})),
  publicMemory:pipe.legacyV1.instructions.filter((i)=>i.op===OP.LOAD||i.op===OP.STORE).map((i)=>({row:i.row,op:i.op,loc:i.loc?{kind:i.loc.kind,key:i.loc.key,disp:i.loc.disp,regionId:i.loc.regionId}:null,addr:i.addr?{baseReg:i.addr.baseReg,disp:i.addr.disp,precise:i.addr.precise}:null})),
})}`);
setSemanticMigrationMode(SEMANTIC_V2_MIGRATION_MODES.V2_COMPAT);
try {
  const ir=buildIR(model,{rowOfAddress,returnType:'int32'});
  console.log(`::warning title=P3_REGION_REAL::${clean(ir.instructions.filter((i)=>i.op===OP.LOAD||i.op===OP.STORE).map((i)=>({row:i.row,op:i.op,loc:i.loc?{kind:i.loc.kind,key:i.loc.key,disp:i.loc.disp,regionId:i.loc.regionId}:null,addr:i.addr?{baseReg:i.addr.baseReg,disp:i.addr.disp,precise:i.addr.precise}:null})))}`);
} finally { setSemanticMigrationMode(SEMANTIC_V2_MIGRATION_MODES.LEGACY); }
console.log('writeback region diagnostic: PASS');