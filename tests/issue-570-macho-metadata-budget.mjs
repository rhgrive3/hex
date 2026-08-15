import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ByteView } from '../js/binary/reader.js';
import { createMachOMetadataBudget } from '../js/binary/macho-budget.js';
import { parseChainedImports, parseClassicBindings } from '../js/binary/macho-dyld.js';

function image() {
  return {
    bits:64,imageBase:0x1000n,metadata:{},warnings:[],libraries:['/usr/lib/libA.dylib'],
    imports:[],exports:[],functions:[],
    sectionAt(a){a=BigInt(a);return a>=0x1000n&&a<0x2000n?{address:0x1000n,size:0x1000n,perms:{execute:true}}:null;},
    addressToOffset(a){a=BigInt(a);return a>=0x1000n&&a<0x2000n?a-0x1000n:null;},
  };
}

{
  const img=image();
  const budget=createMachOMetadataBudget(img,{limits:{records:4,objects:4,stringBytes:4096,inputBytes:4096,operations:100,warnings:8,estimatedHeapBytes:1<<20,wallClockMs:5000}});
  assert.equal(budget.take({records:2,objects:2,operations:1},'a'),true);
  assert.equal(budget.remaining('records'),2);
  assert.equal(budget.take({records:3},'b'),false);
  assert.equal(img.metadata.machoMetadata.complete,false);
  assert.ok(img.metadata.machoMetadata.reasons.some((x)=>x.includes('b:records')));
}

// 16 chained import entries but only 3 record slots: decoder must stop after 3.
{
  const bytes=new Uint8Array(0x200),v=new DataView(bytes.buffer);
  v.setUint32(8,0x40,true);v.setUint32(12,0x100,true);v.setUint32(16,16,true);v.setUint32(20,1,true);v.setUint32(24,0,true);
  for(let i=0;i<16;i++)v.setUint32(0x40+i*4,1,true);
  bytes.set(new TextEncoder().encode('_target\0'),0x100);
  const img=image();
  const budget=createMachOMetadataBudget(img,{limits:{records:3,objects:32,stringBytes:4096,inputBytes:4096,operations:100,warnings:16,estimatedHeapBytes:1<<20,wallClockMs:5000}});
  const parsed=parseChainedImports(new ByteView(bytes),{offset:0,size:0x180},img,budget);
  assert.ok(img.imports.length<=3);
  assert.ok(parsed.length<=3);
  assert.equal(img.metadata.machoMetadata.complete,false);
}

// Repeat opcode must be prebounded by segment/output capacity, not loop 10M times.
{
  const bytes=new Uint8Array([0x70,0x00,0x40,0x5f,0x78,0x00,0xc0,0x64,0x00,0x00]);
  const img=image(),segment={address:0x1000n,size:0x20n,fileOffset:0n,fileSize:0x20n};
  const budget=createMachOMetadataBudget(img,{limits:{records:100,objects:100,stringBytes:4096,inputBytes:4096,operations:100,warnings:8,estimatedHeapBytes:1<<20,wallClockMs:5000}});
  const status=parseClassicBindings(new ByteView(bytes),{offset:0,size:bytes.length},img,[segment],'bind',budget);
  assert.equal(status.complete,false);
  assert.ok(status.decodedBinds<=4);
  assert.ok(img.warnings.some((x)=>/segment\/shared metadata capacity/.test(x)));
  assert.ok(img.warnings.length<8);
}

const macho=fs.readFileSync(new URL('../js/binary/macho.js',import.meta.url),'utf8');
const dyld=fs.readFileSync(new URL('../js/binary/macho-dyld.js',import.meta.url),'utf8');
assert.match(macho,/const metadataBudget = ensureMachOMetadataBudget/);
for(const call of ['parseSymbolTable','parseFunctionStarts','parseChainedImports','parseChainedBindingSites','parseClassicBindings','parseExportTrie'])
  assert.match(macho,new RegExp(`${call}\\([^;]*metadataBudget\\)`),`${call} must share one parser budget`);
assert.match(macho,/machoMetadata = metadataBudget\.snapshot\(\)/);
assert.match(dyld,/chained-import-record/);
assert.match(dyld,/classic-bind-opcode/);
assert.match(dyld,/segment\/shared metadata capacity/);
assert.match(dyld,/export-trie-node/);

console.log('issue #570 Mach-O metadata budget regressions: PASS');
