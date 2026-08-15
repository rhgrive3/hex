import assert from 'node:assert/strict';
import fs from 'node:fs';
import { bindMethodAddresses, parseMetadataAuto } from '../js/il2cpp.js';

assert.throws(() => parseMetadataAuto(new Uint8Array(64), { budget:{ maxInputBytes:32 } }), (e) => e?.code === 'IL2CPP_METADATA_BUDGET');
const source=fs.readFileSync('js/il2cpp.js','utf8');
const chooser=source.slice(source.indexOf('function chooseLayout'),source.indexOf('function parseMetadataCommon'));
assert.equal((chooser.match(/parseLayout\(/g)||[]).length,2);
const tools=fs.readFileSync('js/tools.js','utf8');
assert.match(tools,/f\.size > MAX_IL2CPP_METADATA_BYTES/);
assert.ok(tools.indexOf('f.size > MAX_IL2CPP_METADATA_BYTES') < tools.indexOf('f.arrayBuffer()'));

function fixture() {
  const exec=new Uint8Array(0x2000),data=new Uint8Array(0x4000),dv=new DataView(data.buffer);
  const regions=[{vmAddr:0x1000n,size:0x2000n,exec:true,zerofill:false,section:'__text'},{vmAddr:0x4000n,size:0x4000n,exec:false,zerofill:false,section:'__data_const'}];
  const off=(a)=>Number(BigInt(a)-0x4000n),u64=(a,v)=>dv.setBigUint64(off(a),BigInt(v),true),u32=(a,v)=>dv.setUint32(off(a),Number(v),true);
  const str=(a,v)=>data.set(new TextEncoder().encode(v+'\0'),off(a));
  const read=async(a,n)=>{a=BigInt(a);if(a>=0x1000n&&a+BigInt(n)<=0x3000n)return exec.slice(Number(a-0x1000n),Number(a-0x1000n)+n);if(a>=0x4000n&&a+BigInt(n)<=0x8000n)return data.slice(off(a),off(a)+n);return null;};
  return {regions,read,u64,u32,str};
}
const meta=()=>({version:29,classes:[{index:0}],methods:[{index:0,classIndex:0,token:0x06000001,full:'C::A'},{index:1,classIndex:0,token:0x06000002,full:'C::B'}],images:[{index:0,name:'Assembly-CSharp.dll',typeStart:0,typeCount:1}],warnings:[]});
const addModule=(m,at,namePtr,table,count,pointers)=>{m.u64(at,namePtr);m.u32(BigInt(at)+8n,count);m.u64(BigInt(at)+16n,table);pointers.forEach((p,i)=>m.u64(BigInt(table)+BigInt(i*8),p));};

for(const reverse of [false,true]){
  const m=fixture();m.str(0x4f00n,'Assembly-CSharp.dll');const good=reverse?0x4300n:0x4200n,bad=reverse?0x4200n:0x4300n;
  addModule(m,good,0x4f00n,0x5000n,2,[0x1100n,0x1200n]);addModule(m,bad,0x4f00n,0x5100n,4,[0x1300n,0x1400n,0x1500n,0x1600n]);
  const x=meta(),r=await bindMethodAddresses(x,{regions:m.regions,read:m.read});assert.equal(r.bound,2);assert.equal(x.methods[0].address,0x1100n);assert.equal(x.methods[0].bindingVerified,true);
}
{
  const m=fixture();m.str(0x4f00n,'Assembly-CSharp.dll');addModule(m,0x4200n,0x4f00n,0x5000n,2,[0x1100n,0x1200n]);addModule(m,0x4300n,0x4f00n,0x5100n,2,[0x1300n,0x1400n]);
  const x=meta(),r=await bindMethodAddresses(x,{regions:m.regions,read:m.read});assert.equal(r.bound,0);assert.equal(r.reason,'ambiguous-codegen-modules');assert.equal(x.methodBinding.verified,false);assert.equal(x.methods[0].address,undefined);
}
{
  const sizes=[],regionSize=3*1024*1024;const read=async(_a,n)=>{sizes.push(n);return new Uint8Array(n);};
  const x={version:23,methods:[{index:0,classIndex:0,token:0,full:'C::A'}],images:[],warnings:[]};
  const r=await bindMethodAddresses(x,{regions:[{vmAddr:0x8000n,size:BigInt(regionSize),exec:false,zerofill:false,section:'__data_const'}],read,bindingBudget:{chunkBytes:256*1024,maxScanBytes:4*1024*1024,wallMs:10000,maxOperations:2_000_000}});
  assert.equal(r.reason,'no-proven-legacy-table');assert.ok(Math.max(...sizes)<=256*1024);
}
{
  const x=meta(),read=async(_a,n)=>new Uint8Array(n);const r=await bindMethodAddresses(x,{regions:[{vmAddr:0x9000n,size:2n*1024n*1024n,exec:false,zerofill:false,section:'__data_const'}],read,bindingBudget:{chunkBytes:256*1024,maxScanBytes:256*1024,wallMs:10000}});
  assert.equal(r.reason,'scan-budget-exhausted');assert.equal(x.methodBinding.verified,false);assert.equal(x.methods[0].address,undefined);
}
console.log('issues #496 #519 #520 regressions passed');
