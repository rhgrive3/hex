import { buildSemanticModel, attachTexts } from '../../js/blocks.js';
import { buildIR, OP, setSemanticMigrationMode } from '../../js/ir.js';
import { decompile } from '../../js/decompile.js';
import { SEMANTIC_V2_MIGRATION_MODES } from '../../js/semantics/compat/index.js';

const clean=(x)=>JSON.stringify(x,(_k,v)=>typeof v==='bigint'?`${v}n`:v).replace(/%/g,'%25').replace(/\r/g,'%0D').replace(/\n/g,'%0A');
const base=0x100000490n, PUTS=0x100001000n;
const lines=['stp x29, x30, [sp, #-32]!','mov x29, sp','str x0, [sp, #16]','ldr w8, [x0, #0x20]','ldr w9, [x0, #0x24]','mul w9, w1, w9','sub w8, w8, w9','str w8, [x0, #0x20]','cmp w8, #0','b.gt #0x1000004C4','mov w8, #0','ldr x0, [sp, #16]','str w8, [x0, #0x20]','str w8, [sp, #12]','adrp x0, #0x100000000','add x0, x0, #0x5B4','bl #0x100001000','ldr w0, [sp, #12]','ldp x29, x30, [sp], #32','ret'];
const rows=lines.map((line,row)=>{const p=line.indexOf(' ');return{row,address:base+BigInt(row*4),mn:p<0?line:line.slice(0,p),ops:p<0?'':line.slice(p+1)}});
const rowOfAddress=(a)=>{const d=BigInt(a)-base;return d<0n||d>=BigInt(rows.length*4)?null:Number(d/4n)};
const model=buildSemanticModel(rows,{startRow:0,endRow:rows.length-1,rowOfAddress,name:'apply_damage',symbolFor:(a)=>BigInt(a)===PUTS?'_puts':null});
model.calls=[{row:16,name:'_puts',target:PUTS}];
attachTexts(model,new Map([['4294968756','damage dealt to enemy']]));
const opts={addr:base,name:'apply_damage',rowOfAddress,returnType:'int32',receiverType:'Unit',beginner:false,symbolFor:(a)=>BigInt(a)===PUTS?'_puts':null,fieldFor:(_b,off)=>off===0x20n?{name:'hp',type:'int32'}:off===0x24n?{name:'damageRate',type:'uint32'}:null};
const v=(x)=>x?{id:x.id,kind:x.kind,reg:x.reg,bits:x.bits,version:x.version,compatDerived:x.compatDerived,def:x.def?{id:x.def.id,op:x.def.op,sub:x.def.sub,row:x.def.row,block:x.def.block}:null,uses:(x.uses||[]).map((u)=>({id:u.id,op:u.op,row:u.row,block:u.block}))}:null;
const i=(x)=>x?{id:x.id,op:x.op,sub:x.sub,row:x.row,block:x.block,cond:x.cond,dst:v(x.dst),args:(x.args||[]).map((a)=>v(a?.value)),loc:x.loc?{kind:x.loc.kind,key:x.loc.key,disp:x.loc.disp,regionId:x.loc.regionId,base:v(x.loc.base)}:null,addr:x.addr?{baseReg:x.addr.baseReg,disp:x.addr.disp,precise:x.addr.precise,base:v(x.addr.base)}:null,memUse:x.memUse?{kind:x.memUse.kind,key:x.memUse.key,regionId:x.memUse.regionId,definitionId:x.memUse.definitionId,prev:x.memUse.prev?{kind:x.memUse.prev.kind,key:x.memUse.prev.key,definitionId:x.memUse.prev.definitionId,row:x.memUse.prev.inst?.row}:null}:null,reachingStore:x.reachingStore?{id:x.reachingStore.id,row:x.reachingStore.row,loc:x.reachingStore.loc?.key}:null,returnReg:x.returnReg}:null;
setSemanticMigrationMode(SEMANTIC_V2_MIGRATION_MODES.V2_COMPAT);
try {
  const ir=buildIR(model,opts);
  const d=decompile(model,opts);
  console.log(`::warning title=P3_APPLY_FINAL::${clean({
    blocks:ir.blocks.map((b)=>({index:b.index,start:b.startRow,end:b.endRow,pred:b.pred,succ:b.succ,phis:b.phis.map(i),memPhis:b.memPhis.map((p)=>({kind:p.kind,key:p.key,regionId:p.regionId,definitionId:p.definitionId,incoming:p.incoming?.map((q)=>({from:q.from,kind:q.node?.kind,key:q.node?.key,definitionId:q.node?.definitionId,row:q.node?.inst?.row}))}))})),
    memory:ir.instructions.filter((x)=>x.op===OP.LOAD||x.op===OP.STORE).map(i),
    row8to19:ir.instructions.filter((x)=>x.row>=7&&x.row<=19&&[OP.STORE,OP.LOAD,OP.MOV,OP.PHI,OP.CALL,OP.RET,OP.CMP,OP.CBR].includes(x.op)).map(i),
    x0:ir.values.filter((x)=>x.reg==='x0').map(v),x8:ir.values.filter((x)=>x.reg==='x8').map(v),
    pseudocode:d.pseudocode,warnings:d.warnings,semantic:d.semantic,outputs:d.semanticAst?.outputs,
  })}`);
} finally {setSemanticMigrationMode(SEMANTIC_V2_MIGRATION_MODES.LEGACY);}
console.log('final apply_damage diagnostic: PASS');