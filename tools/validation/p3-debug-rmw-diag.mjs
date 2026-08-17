import { buildSemanticModel } from '../../js/blocks.js';
import { buildIR, readModifyWrite } from '../../js/ir.js';
import { findValueUpdates } from '../../js/dataflow.js';

const BASE=0x100000000n;
const safe=(value)=>JSON.stringify(value,(_k,v)=>typeof v==='bigint'?String(v):v);
function build(lines,names={}) {
  const table=new Map(Object.entries(names));
  const raw=lines.map((text,row)=>{const p=text.indexOf(' ');return {row,address:BASE+BigInt(row*4),mn:p<0?text:text.slice(0,p),ops:p<0?'':text.slice(p+1)}});
  const rowOfAddress=(addr)=>{const d=BigInt(addr)-BASE;return d>=0n&&d<BigInt(raw.length*4)?Number(d/4n):null};
  const model=buildSemanticModel(raw,{startRow:0,endRow:raw.length-1,rowOfAddress,symbolFor:(addr)=>table.get('0x'+addr.toString(16))||null});
  return {model,rowOfAddress};
}
function v(v){return v?{id:v.id,reg:v.reg,kind:v.kind,ver:v.version,const:v.const==null?null:String(v.const),def:v.def?{id:v.def.id,row:v.def.row,op:v.def.op,sub:v.def.sub,sem:v.def.semanticNodeId}:null}:null}
function i(x){return {id:x.id,row:x.row,op:x.op,sub:x.sub,sem:x.semanticNodeId,src:x.sourceInstructionIds,dst:v(x.dst),args:(x.args||[]).map(a=>v(a?.value)),loc:x.loc?{key:x.loc.key,kind:x.loc.kind,disp:x.loc.disp==null?null:String(x.loc.disp),base:v(x.loc.base)}:null,addr:x.addr?{baseReg:x.addr.baseReg,disp:x.addr.disp==null?null:String(x.addr.disp),base:v(x.addr.base)}:null,extra:{stateRead:!!x.extra?.stateRead,stateWrite:!!x.extra?.stateWrite,publicStateIdentity:x.extra?.publicStateIdentity}}}

{
 const {model,rowOfAddress}=build(['ldr w8, [x0, #0x20]','add w8, w8, #0xa','str w8, [x0, #0x20]','ret']);
 const ir=buildIR(model,{rowOfAddress});
 console.log('RMW_CORE_COUNT '+readModifyWrite(ir).length);
 console.log('RMW_CORE '+safe(readModifyWrite(ir).map(r=>({load:i(r.load),store:i(r.store),chain:(r.chain||[]).map(i),loc:r.location?{key:r.location.key,kind:r.location.kind,disp:String(r.location.disp)}:null,kind:r.kind}))));
 const updates=findValueUpdates(model);
 console.log('RMW_PUBLIC_COUNT '+updates.length);
 console.log('RMW_PUBLIC '+safe(updates.map(u=>({kind:u.kind,engine:u.engine,store:u.store,from:u.from,steps:(u.steps||[]).map(s=>({op:s.op,imm:s.imm==null?null:String(s.imm),row:s.row})),location:u.location?{key:u.location.key,irKey:u.location.irKey,disp:String(u.location.disp),base:u.location.base}:null})));
}
{
 const {model,rowOfAddress}=build(['adrp x8, #0x100004000','ldrsw x2, [x8, #0x20]','b #0x100000100'],{'0x100000100':'_objc_setProperty_nonatomic_copy'});
 const ir=buildIR(model,{rowOfAddress});
 console.log('ARC_CALLS '+safe(model.calls));
 console.log('ARC_INSTRUCTIONS '+safe(ir.instructions.map(i)));
 const updates=findValueUpdates(model);
 console.log('ARC_PUBLIC_COUNT '+updates.length);
 console.log('ARC_PUBLIC '+safe(updates.map(u=>({kind:u.kind,engine:u.engine,register:u.register,helper:u.helper,store:u.store,location:u.location?{key:u.location.key,disp:u.location.disp==null?null:String(u.location.disp),indexAddr:u.location.indexAddr==null?null:String(u.location.indexAddr)}:null})));
}
