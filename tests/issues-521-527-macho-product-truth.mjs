import assert from 'node:assert/strict';
import fs from 'node:fs';
import { SymbolIndex, SYM_STUB, SYM_POINTER } from '../js/symbols.js';
import { importList, exportList } from '../js/linkage.js';
import { mergeMachoAnalysisTruth, normalizeMachOLinkage } from '../js/macho-linkage.js';
import { chainedImportSymbols } from '../js/chained.js';

const image={
  format:'macho',arch:'arm64',libraries:['/usr/lib/libSystem.B.dylib'],
  imports:[
    {name:'_nonstub',library:'/usr/lib/libSystem.B.dylib',source:'chained-fixups',sites:[{address:0x2200n,offset:0x1200n,kind:'chained-bind'}]},
    {name:'_lazy',library:'/usr/lib/libSystem.B.dylib',source:'lazy-bind',sites:[{address:0x2300n,offset:0x1300n,kind:'lazy-bind'}]},
    {name:'_stubbed',library:'/usr/lib/libSystem.B.dylib',source:'chained-fixups',sites:[{address:0x2400n,offset:0x1400n,kind:'chained-bind'}]},
  ],
  exports:[{name:'_only_export_trie',address:0x1800n,kind:'export',source:'exports-trie'}],
  metadata:{machoMetadata:{complete:true,reasons:[]},chainedFixups:{complete:true,importsComplete:true,bindingSitesComplete:true},dyldBindings:{complete:true},exportTrie:{complete:true}},
};
const linkage=normalizeMachOLinkage(image);
assert.equal(linkage.completeness.importsComplete,true);
assert.equal(linkage.completeness.exportsComplete,true);
assert.equal(linkage.imports.length,3);

const legacy={
  addrs:BigUint64Array.from([0x1000n,0x2000n]),kinds:Uint8Array.from([SYM_STUB,SYM_POINTER]),flags:Uint8Array.from([0,0]),names:['_stubbed','_legacy_got'],
  funcs:BigUint64Array.from([0x1000n]),functionStartsExact:true,allSeedsExact:true,discoveryComplete:true,
};
const canonical={
  addrs:BigUint64Array.from([0x1800n,0x2200n,0x2300n,0x2400n]),kinds:Uint8Array.from([0,SYM_POINTER,SYM_POINTER,SYM_POINTER]),flags:Uint8Array.from([1,0,0,0]),
  names:['_only_export_trie','_nonstub','_lazy','_stubbed'],funcs:new BigUint64Array(0),linkage,
  nameProvenance:[{source:'exports-trie',confidence:1,confirmed:true},{source:'chained-fixups',confidence:1,confirmed:true},{source:'lazy-bind',confidence:1,confirmed:true},{source:'chained-fixups',confidence:1,confirmed:true}],
};
const merged=mergeMachoAnalysisTruth(legacy,canonical);
const symbols=new SymbolIndex({...merged,regions:[{id:'text',exec:true,vmAddr:0x1000n,size:0x1000n}]});
assert.equal(symbols.nameAt(0x2200n),'_nonstub','arbitrary non-stub chained site must enter SymbolIndex');
assert.equal(symbols.nameAt(0x2300n),'_lazy','classic lazy bind site must enter SymbolIndex');
assert.equal(symbols.nameAt(0x1800n),'_only_export_trie','export-trie-only symbol must enter SymbolIndex');
const imports=importList(symbols,null,100);
for(const name of ['_nonstub','_lazy','_stubbed'])assert.ok(imports.some((x)=>x.name===name),`missing canonical import ${name}`);
assert.equal(imports.find((x)=>x.name==='_nonstub').library,'/usr/lib/libSystem.B.dylib');
assert.equal(imports.complete,true);
const exports=exportList(symbols,100);
assert.ok(exports.some((x)=>x.name==='_only_export_trie'));
assert.equal(exports.complete,true);

const capped=mergeMachoAnalysisTruth(legacy,canonical,{maxSymbols:2});
assert.equal(capped.linkage.completeness.complete,false);
assert.ok(capped.linkage.completeness.reasons.includes('symbol-merge-limit'));

const partialImage={...image,metadata:{...image.metadata,machoMetadata:{complete:false,reasons:['budget:records']}}};
const partial=normalizeMachOLinkage(partialImage);
assert.equal(partial.completeness.complete,false);
assert.ok(partial.completeness.reasons.includes('budget:records'));

// A malicious huge chained-fixup payload must fail closed before materializing it.
const bad=new Uint8Array(64),dv=new DataView(bad.buffer);
dv.setUint32(0,0xfeedfacf,true);dv.setUint32(16,1,true);dv.setUint32(20,16,true);
dv.setUint32(32,0x80000034,true);dv.setUint32(36,16,true);dv.setUint32(40,0x100,true);dv.setUint32(44,0xffffffff,true);
const recovered=await chainedImportSymbols(new Blob([bad]),0);
assert.equal(recovered.length,0);
assert.equal(recovered.completeness.complete,false);
assert.ok(recovered.completeness.reasons.some((x)=>/fixup|range|budget/.test(x)));

const backend=fs.readFileSync(new URL('../js/backend.js',import.meta.url),'utf8');
const platform=fs.readFileSync(new URL('../js/platform/worker.js',import.meta.url),'utf8');
const sourceLoader=fs.readFileSync(new URL('../js/binary/source-loaders.js',import.meta.url),'utf8');
const worker=fs.readFileSync(new URL('../js/worker-legacy.js',import.meta.url),'utf8');
const chained=fs.readFileSync(new URL('../js/chained.js',import.meta.url),'utf8');
assert.doesNotMatch(backend,/augmentAnalysisResultWithChainedImports/,'normal Backend path must not rely on limited chained-stub augmentation');
assert.match(backend,/machoAnalysis/);
assert.match(platform,/normalizeMachOLinkage/);
assert.match(platform,/includeImportSites:true/);
assert.match(sourceLoader,/requestedIndex = opts\.sliceIndex/,'canonical parser must use the exact fat slice, not architecture-first guessing');
assert.match(worker,/SUPPLEMENTAL_READ_BYTES/);
assert.doesNotMatch(worker,/loaded\.push\(/,'ObjC recovery must not retain every pointer/text region at once');
assert.match(worker,/readVm=async/,'ObjC pointer/text metadata must be fetched lazily');
assert.match(chained,/BlobByteSource/);
assert.match(chained,/CHAINED_RECOVERY_LIMITS/);
assert.doesNotMatch(chained,/count > 1_000_000/);

console.log('issues #521/#527 Mach-O product truth regressions: PASS');
