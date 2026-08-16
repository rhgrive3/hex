import { buildSemanticModel, attachTexts } from '../../js/blocks.js';
import { buildIR, OP, setSemanticMigrationMode } from '../../js/ir.js';
import { decompile } from '../../js/decompile.js';
import { SEMANTIC_V2_MIGRATION_MODES } from '../../js/semantics/compat/index.js';

const clean=(x)=>JSON.stringify(x,(_k,v)=>typeof v==='bigint'?`${v}n`:v).replace(/%/g,'%25').replace(/\r/g,'%0D').replace(/\n/g,'%0A');
const base=0x100000490n, PUTS=0x100001000n;
const lines=['stp x29, x30, [sp, #-32]!','mov x29, sp','str x0, [sp, #16]','ldr w8, [x0, #0x20]','ldr w9, [x0, #0x24]','mul w9, w1, w9','sub w8, w8, w9','str w8, [x0, #0x20]','cmp w8, #0','b.gt #0x1000004C4','mov w8, #0','ldr x0, [sp, #16]','str w8, [x0, #0x20]','str w8, [sp, #12]','adrp x0, #0x100000000','add x0, x0, #0x5B4','bl #0x100001000','ldr w0, [sp, #12]','ldp x29, x30, [sp], #32','ret'];
const rows=lines.map((line,row)=>{const p=line.indexOf(' ');return{row,address:base+BigInt(row*4),mn:p<0?line:line.slice(0,p),ops:p<0?'':line.slice(p+1)}});
const rowOfAddress=(a)=>{const d=BigInt(a)-base;return d<0n||d>=BigInt(rows.length*4)?null:Number(d/4n)};
const makeModel=()=>{const m=buildSemanticModel(rows,{startRow:0,endRow:rows.length-1,rowOfAddress,name:'apply_damage',symbolFor:(a)=>BigInt(a)===PUTS?'_puts':null});m.calls=[{row:16,name:'_puts',target:PUTS}];attachTexts(m,new Map([['4294968756','damage dealt to enemy']]));return m;};
const opts={addr:base,name:'apply_damage',rowOfAddress,returnType:'int32',receiverType:'Unit',beginner:false,symbolFor:(a)=>BigInt(a)===PUTS?'_puts':null,fieldFor:(_b,off)=>off===0x20n?{name:'hp',type:'int32'}:off===0x24n?{name:'damageRate',type:'uint32'}:null};
const val=(v)=>v?{id:v.id,kind:v.kind,reg:v.reg,bits:v.bits,version:v.version,const:v.const,def:v.def?{op:v.def.op,sub:v.def.sub,row:v.def.row,block:v.def.block}:null}:null;
const inst=(x)=>x?{op:x.op,sub:x.sub,row:x.row,block:x.block,cond:x.cond,dst:val(x.dst),args:(x.args||[]).map((a)=>val(a?.value)),loc:x.loc?{kind:x.loc.kind,key:x.loc.key,disp:x.loc.disp,address:x.loc.address,base:val(x.loc.base),regionId:x.loc.regionId}:null,addr:x.addr?{baseReg:x.addr.baseReg,disp:x.addr.disp,precise:x.addr.precise,base:val(x.addr.base)}:null,reachingStore:x.reachingStore?{row:x.reachingStore.row,loc:x.reachingStore.loc?.key,args:(x.reachingStore.args||[]).map((a)=>val(a?.value))}:null,returnReg:x.returnReg,extra:{kind:x.extra?.kind,target:x.extra?.target,abiProjectedReturnValueId:x.extra?.abiProjectedReturnValueId}}:null;
function snapshot(mode){setSemanticMigrationMode(mode);const model=makeModel();const ir=buildIR(model,opts);const d=decompile(model,opts);return{blocks:ir.blocks.map((b)=>({index:b.index,start:b.startRow,end:b.endRow,pred:b.pred,succ:b.succ,phis:(b.phis||[]).map(inst),memPhis:(b.memPhis||[]).map((p)=>({key:p.key,kind:p.kind,regionId:p.regionId,incoming:p.incoming?.map((q)=>({from:q.from,key:q.node?.key,kind:q.node?.kind,row:q.node?.inst?.row}))}))})),interesting:ir.instructions.filter((x)=>x.row>=7&&x.row<=19&&[OP.STORE,OP.LOAD,OP.MOV,OP.PHI,OP.CALL,OP.RET,OP.CMP,OP.CBR,OP.ADDR,OP.CONST].includes(x.op)).map(inst),x0:ir.values.filter((v)=>v.reg==='x0').map(val),x8:ir.values.filter((v)=>v.reg==='x8').map(val),pseudocode:d.pseudocode};}
try {
  const legacy=snapshot(SEMANTIC_V2_MIGRATION_MODES.LEGACY);
  const v2=snapshot(SEMANTIC_V2_MIGRATION_MODES.V2_COMPAT);
  console.log(`::warning title=P3_FINAL_ORACLE::${clean({legacy,v2})}`);
} finally {setSemanticMigrationMode(SEMANTIC_V2_MIGRATION_MODES.LEGACY);}
console.log('final legacy/v2 public-shape differential: PASS');