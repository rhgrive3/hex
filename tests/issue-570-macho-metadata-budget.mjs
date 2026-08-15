import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ByteView } from '../js/binary/reader.js';
import { createMachOMetadataBudget } from '../js/binary/macho-budget.js';
import { parseChainedImports, parseClassicBindings, parseExportTrie } from '../js/binary/macho-dyld.js';

function image() {
  return {
    bits:64, imageBase:0x1000n, metadata:{}, warnings:[], libraries:['/usr/lib/libA.dylib'],
    imports:[], exports:[], functions:[],
    sectionAt(address) { const a=BigInt(address); return a>=0x1000n&&a<0x2000n?{address:0x1000n,size:0x1000n,perms:{execute:true}}:null; },
    addressToOffset(address) { const a=BigInt(address); return a>=0x1000n&&a<0x2000n?a-0x1000n:null; },
  };
}

// Shared budget object keeps cumulative accounting across independent decoders.
{
  const img=image();
  const budget=createMachOMetadataBudget(img,{limits:{records:4,objects:4,stringBytes:4096,inputBytes:4096,operations:100,warnings:8,estimatedHeapBytes:1<<20,wallClockMs:5000}});
  assert.equal(budget.take({records:2,objects:2,operations:1},'a'),true);
  assert.equal(budget.remaining('records'),2);
  assert.equal(budget.take({records:3},'b'),false);
  assert.equal(img.metadata.machoMetadata.complete,false);
  assert.ok(img.metadata.machoMetadata.reasons.some((x)=>x.includes('b:records')));
}

// Chained imports stop at the shared record/object budget instead of allocating
// an importsCount-sized object graph.
{
  const bytes=new Uint8Array(0x200),v=new DataView(bytes.buffer);
  v.setUint32(8,0x40,true);   // imports_offset
  v.setUint32(12,0x100,true); // symbols_offset
  v.setUint32(16,16,true);    // imports_count
  v.setUint32(20,1,true);     // DYLD_CHAINED_IMPORT
  v.setUint32(24,0,true);
  for(let i=0;i<16;i++) v.setUint32(0x40+i*4,1,true); // ordinal 1, name offset 0
  bytes.set(new TextEncoder().encode('_target\0'),0x100);
  const img=image();
  const budget=createMachOMetadataBudget(img,{limits:{records:3,objects:16,stringBytes:4096,inputBytes:4096,operations:100,warnings:16,estimatedHeapBytes:1<<20,wallClockMs:5000}});
  const parsed=parseChainedImports(new ByteView(bytes),{offset:0,size:0x180},img,budget);
  assert.equal(img.imports.length,3);
  assert.equal(parsed.length,3);
  assert.equal(img.metadata.chainedFixups.importsComplete,false);
  assert.equal(img.metadata.chainedFixups.importsPartialReason,'metadata-budget');
  assert.equal(img.metadata.machoMetadata.complete,false);
}

// A few-byte classic repeat cannot request millions of binds/warnings. Capacity
// is pre-bounded by the owning segment and remaining shared work/output budget.
{
  const bytes=new Uint8Array([0x70,0x00,0x40,0x5f,0x78,0x00,0xc0,0x64,0x00,0x00]);
  const img=image();
  const segment={address:0x1000n,size:0x20n,fileOffset:0n,fileSize:0x20n};
  const budget=createMachOMetadataBudget(img,{limits:{records:100,objects:100,stringBytes:4096,inputBytes:4096,operations:100,warnings:4,estimatedHeapBytes:1<<20,wallClockMs:5000}});
  const status=parseClassicBindings(new ByteView(bytes),{offset:0,size:bytes.length},img,[segment],'bind',budget);
  assert.equal(status.complete,false);
  assert.equal(status.decodedBinds,4);
  assert.equal(img.imports.length,4);
  assert.ok(img.warnings.some((x)=>/repeat count 100 exceeds segment\/shared metadata capacity 4/.test(x)));
  assert.ok(img.warnings.length<=2,'repeat must not generate one warning per invalid bind');
}

// Export trie output is also charged to the same shared budget; a node may be
// decoded without allowing an unbounded export/function object pair.
{
  const bytes=new Uint8Array([0x02,0x00,0x10,0x00]); // terminalSize=2, flags=0, addr=0x10, childCount=0
  const img=image();
  const budget=createMachOMetadataBudget(img,{limits:{records:8,objects:1,stringBytes:4096,inputBytes:4096,operations:100,warnings:8,estimatedHeapBytes:1<<20,wallClockMs:5000}});
  const status=parseExportTrie(new ByteView(bytes),{offset:0,size:bytes.length},img,budget);
  assert.equal(status.complete,false);
  assert.equal(img.exports.length,0);
  assert.equal(img.functions.length,0);
  assert.equal(img.metadata.machoMetadata.complete,false);
}

// Parser wiring guard: all high-amplification Mach-O sources consume one budget.
{
  const macho=fs.readFileSync(new URL('../js/binary/macho.js',import.meta.url),'utf8');
  const dyld=fs.readFileSync(new URL('../js/binary/macho-dyld.js',import.meta.url),'utf8');
  assert.match(macho,/const metadataBudget = createMachOMetadataBudget/);
  for(const call of ['parseSymbolTable','parseFunctionStarts','parseChainedImports','parseChainedBindingSites','parseClassicBindings','parseExportTrie'])
    assert.match(macho,new RegExp(`${call}\\([^;]*metadataBudget\\)`),`${call} must receive the shared budget`);
  assert.match(macho,/machoMetadata = metadataBudget\.snapshot\(\)/);
  assert.match(dyld,/bind repeat count \$\{repeat\} exceeds segment\/shared metadata capacity/);
  assert.match(dyld,/export-trie-prefix/);
  assert.match(dyld,/chained-import-record/);
}

console.log('issue #570 Mach-O metadata budget regressions: PASS');
