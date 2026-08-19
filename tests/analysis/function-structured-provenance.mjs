import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { NodeBackend } from '../harness.mjs';

const argv = process.argv.slice(2);
const arg = (name, d='') => { const p=`--${name}=`; const x=argv.find(v=>v.startsWith(p)); return x?x.slice(p.length):d; };
const target=arg('target'), oraclePath=arg('oracle'), outPath=arg('out','structured-provenance.json');
if(!target||!oraclePath) throw new Error('need --target and --oracle');
const raw=fs.readFileSync(target);
const oracle=JSON.parse(zlib.gunzipSync(fs.readFileSync(oraclePath)).toString('utf8'));
const file={name:path.basename(target),size:raw.length,slice(a,b){const s=raw.subarray(a,b);return{arrayBuffer:async()=>s.buffer.slice(s.byteOffset,s.byteOffset+s.byteLength)}}};
const backend=new NodeBackend();
const info=await backend.open(file);
await backend.analyze(0);
const allRegions=[].concat(...info.slices.map(s=>s.regions),[info.raw]);
const code=allRegions.find(r=>r.section==='__text'&&r.size>0n)||allRegions.find(r=>r.exec&&r.size>0n);
if(!code) throw new Error('no code region');
const slice=info.slices.find(s=>(s.regions||[]).some(r=>r.id===code.id));
if(!slice) throw new Error('no owning slice');
const lo=BigInt(code.vmAddr), hi=lo+BigInt(code.size), imageBase=BigInt(oracle.base);
const imageRelative=new Set(), fieldRelative=new Set();
const add=(set,t)=>{if(t>=lo&&t<hi&&!(t&3n))set.add(t.toString());};
for(const r of slice.regions||[]){
  const size=Number(r.size||0n), off=Number(r.fileOffset||0n);
  if(!Number.isSafeInteger(size)||!Number.isSafeInteger(off)||size<=0||off<0||off+size>raw.length||size>32*1024*1024)continue;
  const b=raw.subarray(off,off+size); const dv=new DataView(b.buffer,b.byteOffset,b.byteLength);
  if(r.segment==='__DATA_CONST'&&r.section==='__const'){
    for(let p=0;p+4<=b.length;p+=4)add(imageRelative,imageBase+BigInt(dv.getUint32(p,true)));
  }
  const sec=r.section||'';
  const rel=sec==='__constg_swiftt'||sec.startsWith('__swift5_')||(sec==='__const'&&(r.segment==='__TEXT'||r.segment==='__DATA_CONST'));
  if(rel){
    for(let p=0;p+4<=b.length;p+=4)add(fieldRelative,BigInt(r.vmAddr)+BigInt(p)+BigInt(dv.getInt32(p,true)));
  }
}
const res=await backend.guessFunctions(code.id,400000);
if(!res.analysisEvidenceMasks)throw new Error('analysisEvidenceMasks missing');
const truth=new Set(oracle.functionStarts.map(x=>BigInt(x).toString()));
const stat={all:{tp:0,fp:0},mask131:{tp:0,fp:0,imageRelativeTP:0,imageRelativeFP:0,fieldRelativeTP:0,fieldRelativeFP:0,bothTP:0,bothFP:0},structuredIndirect:{tp:0,fp:0,imageRelativeTP:0,imageRelativeFP:0,fieldRelativeTP:0,fieldRelativeFP:0}};
const samples=[];
for(let i=0;i<res.starts.length;i++){
  const a=res.starts[i], key=a.toString(), m=res.analysisEvidenceMasks[i], ok=truth.has(key), side=ok?'tp':'fp';
  stat.all[side]++;
  const im=imageRelative.has(key), fr=fieldRelative.has(key);
  if(m===131){
    stat.mask131[side]++;
    if(im)stat.mask131['imageRelative'+(ok?'TP':'FP')]++;
    if(fr)stat.mask131['fieldRelative'+(ok?'TP':'FP')]++;
    if(im&&fr)stat.mask131['both'+(ok?'TP':'FP')]++;
    if(samples.length<20)samples.push({addr:'0x'+a.toString(16),truth:ok,imageRelative:im,fieldRelative:fr});
  }
  if((m&(1<<1))&&(m&(1<<7))){
    stat.structuredIndirect[side]++;
    if(im)stat.structuredIndirect['imageRelative'+(ok?'TP':'FP')]++;
    if(fr)stat.structuredIndirect['fieldRelative'+(ok?'TP':'FP')]++;
  }
}
const doc={code:{vm:'0x'+lo.toString(16),size:Number(code.size)},candidateSets:{imageRelative:imageRelative.size,fieldRelative:fieldRelative.size},stats:stat,samples};
fs.writeFileSync(outPath,JSON.stringify(doc,null,2)+'\n');
console.log(JSON.stringify(doc));
