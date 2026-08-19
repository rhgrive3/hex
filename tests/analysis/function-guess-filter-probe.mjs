import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { openBinary } from '../harness.mjs';

const args = process.argv.slice(2);
const arg = (n, d='') => { const p=`--${n}=`; const x=args.find(v=>v.startsWith(p)); return x?x.slice(p.length):d; };
const target=arg('target'), oraclePath=arg('oracle'), name=arg('name',path.basename(target)), out=arg('out',`function-filter-${name}.json`);
if(!target||!oraclePath) throw new Error('need --target and --oracle');
const oracle=JSON.parse(zlib.gunzipSync(fs.readFileSync(oraclePath)).toString('utf8'));
const w=await openBinary(target,{strings:false,objc:false,log:s=>console.error(`[${name}] ${s}`)});
const r=await w.backend.guessFunctions(w.region.id,400000);
const got=Array.from(r.starts||r.addrs||[],Number), truth=oracle.functionStarts.map(Number), truthSet=new Set(truth);
const cache=new Map();
async function insn(addr){
  const row=Math.floor((addr-Number(w.region.vmAddr))/4); if(row<0)return '?';
  const chunk=Math.floor(row/1024); if(!cache.has(chunk))cache.set(chunk,w.backend.fetchChunk(w.region.id,chunk,true));
  const c=await cache.get(chunk), i=row%1024; return (c?.mn?.[i]||'?').trim().toLowerCase();
}
const groups=new Map();
for(const a of got){
  const prev=await insn(a-4), cur=await insn(a), key=`${prev}->${cur}`;
  let g=groups.get(key); if(!g){g={pattern:key,tp:0,fp:0};groups.set(key,g);} (truthSet.has(a)?g.tp++:g.fp++);
}
const patterns=[...groups.values()].sort((a,b)=>b.fp-a.fp||b.tp-a.tp);
const baseTp=got.reduce((n,a)=>n+(truthSet.has(a)?1:0),0), baseFp=got.length-baseTp, baseFn=truth.length-baseTp;
function score(tp,fp,fn){const p=tp/(tp+fp),rec=tp/(tp+fn);return {tp,fp,fn,precision:p,recall:rec,f1:2*p*rec/(p+rec)};}
const filters={
  drop_after_br:['br'],
  drop_after_b:['b'],
  drop_after_ret:['ret','retaa','retab'],
  drop_after_br_or_b:['br','b'],
  drop_after_br_b_ret:['br','b','ret','retaa','retab'],
};
const scenarios={baseline:score(baseTp,baseFp,baseFn)};
for(const [id,prevs] of Object.entries(filters)){
  const drop=patterns.filter(g=>prevs.some(p=>g.pattern.startsWith(p+'->'))).reduce((z,g)=>({tp:z.tp+g.tp,fp:z.fp+g.fp}),{tp:0,fp:0});
  scenarios[id]={...score(baseTp-drop.tp,baseFp-drop.fp,baseFn+drop.tp),droppedTp:drop.tp,droppedFp:drop.fp};
}
const doc={target:name,scenarios,topPatterns:patterns.slice(0,80)};
fs.writeFileSync(out,JSON.stringify(doc,null,2)+'\n');
console.log(JSON.stringify(doc,null,2));
