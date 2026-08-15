import assert from 'node:assert/strict';
import { parseProgramDynamic } from '../js/binary/elf-dynamic.js';
import { parseDynamicSymbolVersions } from '../js/binary/elf-extended.js';
import { createDynamicSymbolBudget } from '../js/binary/dynamic-symbol-budget.js';

const BASE=0x1000n;
const DT_NULL=0n, DT_HASH=4n, DT_STRTAB=5n, DT_SYMTAB=6n, DT_STRSZ=10n, DT_SYMENT=11n, DT_VERSYM=0x6ffffff0n;

class SparseReader {
  constructor({ strtabVa=0x1130n, hashVa=0x1200n, fakeLength=20*1024*1024+0x4000 }={}) {
    this.buf=new Uint8Array(0x400);
    this.dv=new DataView(this.buf.buffer);
    this.length=fakeLength;
    this.hashOff=Number(hashVa-BASE);
    this.versymOff=0x2000;
    this.versymReads=0;
    const dyn=[
      [DT_HASH,hashVa],[DT_STRTAB,strtabVa],[DT_SYMTAB,0x1100n],
      [DT_STRSZ,16n],[DT_SYMENT,24n],[DT_VERSYM,BASE+BigInt(this.versymOff)],[DT_NULL,0n],
    ];
    dyn.forEach(([tag,value],i)=>{
      this.dv.setBigInt64(i*16,tag,true);
      this.dv.setBigUint64(i*16+8,value,true);
    });
    if(this.hashOff+8<=this.buf.length){
      this.dv.setUint32(this.hashOff,1,true);
      this.dv.setUint32(this.hashOff+4,10_000_000,true);
    }
    // Second of two actually file-backed Elf64_Sym records in the tight fixture.
    this.dv.setUint32(0x118,1,true);
    this.dv.setUint8(0x11c,0x12);
    this.dv.setUint16(0x11e,1,true);
    this.dv.setBigUint64(0x120,0x1800n,true);
    this.dv.setBigUint64(0x128,4n,true);
    this.buf.set(Uint8Array.from([0,0x66,0x6f,0x6f,0]),0x130);
  }
  _ok(off,size){ return off>=0 && off+size<=this.buf.length; }
  u8(off){ return this._ok(off,1)?this.dv.getUint8(off):0; }
  u16(off){ if(off>=this.versymOff){this.versymReads++;return 2;} return this._ok(off,2)?this.dv.getUint16(off,true):0; }
  u32(off){
    if(off===this.hashOff)return 1;
    if(off===this.hashOff+4)return 10_000_000;
    return this._ok(off,4)?this.dv.getUint32(off,true):0;
  }
  i32(off){ return this._ok(off,4)?this.dv.getInt32(off,true):0; }
  u64(off){ return this._ok(off,8)?this.dv.getBigUint64(off,true):0n; }
  i64(off){ return this._ok(off,8)?this.dv.getBigInt64(off,true):0n; }
  cstring(off,max=1<<20){
    if(!this._ok(off,1)) return '';
    const bytes=[];
    for(let i=0;i<max&&this._ok(off+i,1);i++){const b=this.dv.getUint8(off+i);if(!b)break;bytes.push(b);}
    return new TextDecoder().decode(Uint8Array.from(bytes));
  }
}

function imageFor(r){
  return {
    warnings:[],metadata:{},libraries:[],symbols:[],imports:[],exports:[],functions:[],relocations:[],sections:[],
    addressToOffset(va){const off=BigInt(va)-BASE;return off>=0n&&off<BigInt(r.length)?off:null;},
  };
}
const dynamicHeader=[{type:2,offset:0n,filesz:7n*16n}];

// Issue reproducer: 10M DT_HASH count + virtual 20MiB VERSYM + only two
// genuinely file-backed symbols. SYMTAB extent wins before any huge loop.
{
  const r=new SparseReader();
  const image=imageFor(r);
  const result=parseProgramDynamic(r,dynamicHeader,image,64);
  assert.equal(image.metadata.programDynamic.symbolsDeclared,10_000_000);
  assert.equal(image.metadata.programDynamic.symbolFileCapacity,2);
  assert.equal(image.metadata.programDynamic.symbolsExpected,2);
  assert.equal(result.symbols,2);
  assert.equal(r.versymReads,2);
  assert.equal(image.metadata.symbolVersions.entries,2);
  assert.equal(image.metadata.programDynamicPartial,true);
  assert.match(image.metadata.programDynamicDiagnostics.join('\n'),/exceeds file-backed SYMTAB capacity 2/);
  assert.ok(image.metadata.programDynamicSymbolBudget.outputObjects<16);
}

// Move HASH/STRTAB after VERSYM so file-backed capacity is well above 16;
// now the independent maxSymbolRecords ceiling is the first limiting factor.
{
  const r=new SparseReader({strtabVa:BASE+0x100000n,hashVa:BASE+0x80000n});
  const image=imageFor(r);
  const result=parseProgramDynamic(r,dynamicHeader,image,64,{
    dynamicSymbolLimits:{maxSymbolRecords:16,maxOutputObjects:128,maxInputBytes:1<<20,maxOperations:1000,maxWallMs:10_000,maxEstimatedBytes:1<<20},
  });
  assert.equal(image.metadata.programDynamic.symbolsDeclared,10_000_000);
  assert.ok(image.metadata.programDynamic.symbolFileCapacity>16);
  assert.equal(image.metadata.programDynamic.symbolsExpected,16);
  assert.equal(result.symbols,16);
  assert.equal(r.versymReads,16);
  assert.match(image.metadata.programDynamicDiagnostics.join('\n'),/exceeds symbol record limit 16/);
}

// VERSYM itself is output-budgeted even when invoked directly with an
// apparently file-backed large table.
{
  let reads=0;
  const r={length:4096,u16(){reads++;return 2;}};
  const image={warnings:[],metadata:{},addressToOffset(){return 0n;}};
  const tags=new Map([[DT_VERSYM,[0n]]]);
  const versions=parseDynamicSymbolVersions(r,tags,image,100,()=>'',{
    limits:{maxSymbolRecords:100,maxOutputObjects:4,maxInputBytes:4096,maxOperations:1000,maxWallMs:10_000,maxEstimatedBytes:4096},
  });
  assert.equal(versions.size,4);
  assert.ok(reads<=5);
  assert.equal(image.metadata.programDynamicPartial,true);
  assert.match(image.metadata.programDynamicDiagnostics.join('\n'),/output objects exceed 4/);
}

// Input/work/wall/memory dimensions are independent hard stops.
{
  let message='';
  const input=createDynamicSymbolBudget({limits:{maxInputBytes:8},onLimit:m=>message=m});
  assert.equal(input.claimInput(9,'SYMTAB'),false); assert.match(message,/input bytes exceed 8/);

  message='';
  const ops=createDynamicSymbolBudget({limits:{maxOperations:2,maxWallMs:10_000},onLimit:m=>message=m});
  assert.equal(ops.step(),true); assert.equal(ops.step(),true); assert.equal(ops.step(),false); assert.match(message,/exceeds 2 operations/);

  message=''; let tick=0;
  const wall=createDynamicSymbolBudget({limits:{maxWallMs:5,now:()=>{const v=tick;tick+=10;return v;}},onLimit:m=>message=m});
  assert.equal(wall.step(),false); assert.match(message,/wall-clock budget/);

  message='';
  const memory=createDynamicSymbolBudget({limits:{maxOutputObjects:100,maxEstimatedBytes:64},onLimit:m=>message=m});
  assert.equal(memory.claimOutput(1,65,'symbol'),false); assert.match(message,/estimated memory exceeds 64/);
}

console.log('issue #513 ELF dynamic symbol budget: PASS');
