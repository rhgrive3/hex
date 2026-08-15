import assert from 'node:assert/strict';
import { bindMethodAddresses } from '../js/il2cpp.js';

function memoryFixture() {
  const exec = new Uint8Array(0x1000);
  const data = new Uint8Array(0x2000);
  const dv = new DataView(data.buffer);
  const regions = [
    { vmAddr:0x1000n,size:0x1000n,exec:true,zerofill:false,section:'__text' },
    { vmAddr:0x3000n,size:0x2000n,exec:false,zerofill:false,section:'__data_const' },
  ];
  const off = (addr) => Number(BigInt(addr)-0x3000n);
  const u64 = (addr,value) => dv.setBigUint64(off(addr),BigInt(value),true);
  const u32 = (addr,value) => dv.setUint32(off(addr),Number(value),true);
  const str = (addr,value) => { const bytes=new TextEncoder().encode(value+'\0'); data.set(bytes,off(addr)); };
  const read = async (addr,len) => {
    addr=BigInt(addr);
    if(addr>=0x1000n && addr+BigInt(len)<=0x2000n) return exec.slice(Number(addr-0x1000n),Number(addr-0x1000n)+len);
    if(addr>=0x3000n && addr+BigInt(len)<=0x5000n) return data.slice(Number(addr-0x3000n),Number(addr-0x3000n)+len);
    return null;
  };
  const addLegacy = (at,table,pointers,{proof=true}={}) => {
    u64(at,pointers.length); u64(BigInt(at)+8n,table);
    pointers.forEach((p,i)=>u64(BigInt(table)+BigInt(i*8),p));
    if(proof){
      u64(BigInt(at)+16n,1); u64(BigInt(at)+24n,0x3a00n);
      u64(BigInt(at)+32n,1); u64(BigInt(at)+40n,0x3a80n);
    }
  };
  return { regions, read, u64, u32, str, addLegacy };
}

function meta2(version=29,withImage=true){
  return {
    version,
    methods:[
      {index:0,classIndex:0,token:0x06000001,full:'C::A'},
      {index:1,classIndex:0,token:0x06000002,full:'C::B'},
    ],
    images:withImage?[{index:0,name:'Assembly-CSharp.dll',typeStart:0,typeCount:1}]:[],
    warnings:[],
  };
}

// The issue reproducer: a convincing but wrong legacy-shaped table must never
// suppress the stronger image-name + token/RID codegen-module mapping.
{
  const m=memoryFixture();
  m.addLegacy(0x3000n,0x3400n,[0x1500n,0x1600n],{proof:true});
  m.str(0x3300n,'Assembly-CSharp.dll');
  m.u64(0x3100n,0x3300n); // module name pointer
  m.u32(0x3108n,2);       // methodPointerCount
  m.u64(0x3110n,0x3500n); // methodPointers
  m.u64(0x3500n,0x1100n); m.u64(0x3508n,0x1200n);
  const meta=meta2(29,true);
  const result=await bindMethodAddresses(meta,{regions:m.regions,read:m.read});
  assert.equal(result.bound,2);
  assert.equal(result.preferred,'codegen-modules');
  assert.equal(meta.methodBinding.kind,'codegen-modules');
  assert.equal(meta.methodBinding.verified,true);
  assert.equal(meta.methods[0].address,0x1100n);
  assert.equal(meta.methods[1].address,0x1200n);
  assert.equal(meta.methods[0].binding,'codegen-module');
}

// The old heuristic (count + executable sample) alone is no longer enough.
{
  const m=memoryFixture();
  m.addLegacy(0x3000n,0x3400n,[0x1100n,0x1200n],{proof:false});
  const meta=meta2(23,false);
  const result=await bindMethodAddresses(meta,{regions:m.regions,read:m.read});
  assert.equal(result.bound,0);
  assert.equal(result.reason,'no-proven-legacy-table');
  assert.equal(meta.methods[0].address,undefined);
}

// A structurally proven, unique legacy CodeRegistration remains supported.
{
  const m=memoryFixture();
  m.addLegacy(0x3000n,0x3400n,[0x1100n,0x1200n],{proof:true});
  const meta=meta2(23,false);
  const result=await bindMethodAddresses(meta,{regions:m.regions,read:m.read});
  assert.equal(result.bound,2);
  assert.equal(result.preferred,'verified-legacy');
  assert.equal(meta.methodBinding.verified,true);
  assert.deepEqual(meta.methodBinding.evidence,['slot-coverage','registration-neighbors','executable-pointer-ratio','unique-candidate']);
  assert.equal(meta.methods[1].address,0x1200n);
  assert.equal(meta.methods[1].binding,'code-registration');
}

// Two equally strong legacy candidates are ambiguity, not permission to pick first.
{
  const m=memoryFixture();
  m.addLegacy(0x3000n,0x3400n,[0x1100n,0x1200n],{proof:true});
  m.addLegacy(0x3080n,0x3600n,[0x1300n,0x1400n],{proof:true});
  const meta=meta2(23,false);
  const result=await bindMethodAddresses(meta,{regions:m.regions,read:m.read});
  assert.equal(result.bound,0);
  assert.equal(result.reason,'ambiguous-legacy-table');
  assert.equal(meta.methods[0].address,undefined);
  assert.match(meta.warnings.join('\n'),/曖昧/);
}

console.log('issue #496 IL2CPP binding trust: PASS');
