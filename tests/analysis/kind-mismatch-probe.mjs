import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { openBinary } from '../harness.mjs';
const args=process.argv.slice(2);const arg=(n,d='')=>{const p=`--${n}=`;const x=args.find(v=>v.startsWith(p));return x?x.slice(p.length):d;};
const target=arg('target'), oraclePath=arg('oracle'), name=arg('name',path.basename(target)), out=arg('out',`kind-${name}.json`);
const oracle=JSON.parse(zlib.gunzipSync(fs.readFileSync(oraclePath)).toString('utf8'));
const src=fs.readFileSync(new URL('../accuracy.mjs',import.meta.url),'utf8');
const m=src.match(/const MN_TO_KIND = (\{[\s\S]*?\n\});/);if(!m)throw new Error('MN_TO_KIND not found');
const table=Function(`return (${m[1]})`)();
const expected=(mn,ops)=>{if(/\bv\d+\.\d*[bhsdq]/.test(ops))return null;if(mn.startsWith('b.'))return 'CONDBR';if(mn==='mov')return /#/.test(ops)?'MOVIMM':'MOVREG';return table[mn]||null;};
const w=await openBinary(target,{strings:false,objc:false,log:s=>console.error(`[${name}] ${s}`)});const {KIND}=await import('../../js/program.js');const names=Object.keys(KIND);const vm=Number(w.region.vmAddr);const bad=[];let judged=0,hit=0;
for(const [addr,mn,ops] of oracle.sampleInsns){const want=expected(mn,ops);if(!want)continue;const row=(addr-vm)/4;if(!Number.isInteger(row)||row<0||row>=w.scan.kindsCovered)continue;judged++;const got=names[w.scan.kinds[row]];if(got===want)hit++;else bad.push({addr:'0x'+addr.toString(16),mn,ops,want,got});}
const doc={target:name,judged,hit,badCount:bad.length,bad};fs.writeFileSync(out,JSON.stringify(doc,null,2)+'\n');console.log(JSON.stringify(doc,null,2));
