import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { MemoryByteSource } from '../js/binary/source.js';
import { parseMachOSource } from '../js/binary/source-loaders.js';
import { analysisFromBinaryImage } from '../js/platform/analysis-result.js';
import { mergeMachOAnalysisResults } from '../js/macho-analysis-merge.js';

{
  const image = {
    format:'macho',
    symbols:[
      { name:'_defined', address:0x1000n, defined:true, source:'LC_SYMTAB' },
      { name:'_undefined', address:0n, defined:false, source:'LC_SYMTAB' },
    ],
    exports:[{ name:'_export_only', address:0x1100n, source:'exports-trie' }],
    imports:[
      { name:'_chain_target', source:'chained-fixups', sites:[{ address:0x2000n, kind:'chained-bind' }] },
      { name:'_lazy_target', source:'lazy-bind', sites:[{ address:0x2010n, kind:'lazy-bind' }] },
    ],
    functions:[],
    metadata:{
      machoMetadata:{ complete:true, reasons:[] },
      chainedFixups:{ complete:true, bindingSitesComplete:true },
      exportTrie:{ complete:true },
      dyldBindings:{ lazy:{ complete:true } },
    },
  };
  const result = analysisFromBinaryImage(image);
  const rows = result.names.map((name, i) => [name, result.addrs[i], result.kinds[i], result.flags[i]]);
  assert.ok(rows.some(([n,a,k]) => n === '_chain_target' && a === 0x2000n && k === 2));
  assert.ok(rows.some(([n,a,k]) => n === '_lazy_target' && a === 0x2010n && k === 2));
  assert.ok(rows.some(([n,a,,f]) => n === '_export_only' && a === 0x1100n && f === 1));
  assert.ok(!rows.some(([n]) => n === '_undefined'));
  assert.equal(result.symbolTruth.complete, true);
}

{
  const result = analysisFromBinaryImage({
    format:'macho', symbols:[], exports:[], imports:[], functions:[],
    metadata:{ machoMetadata:{ complete:true }, chainedFixups:{ complete:true, bindingSitesComplete:false, bindingSiteReasons:['unsupported pointer format'] } },
  });
  assert.equal(result.symbolTruth.complete, false);
  assert.ok(result.symbolTruth.reasons.some((x) => /binding-sites-incomplete/.test(x)));
}

{
  const legacy = {
    addrs:new BigUint64Array([0x3000n]), kinds:new Uint8Array([1]), flags:new Uint8Array([0]),
    names:['_objc_msgSend$foo:'], funcs:new BigUint64Array(0), symbolCount:1, funcCount:0,
  };
  const normalized = {
    addrs:new BigUint64Array([0x2000n]), kinds:new Uint8Array([2]), flags:new Uint8Array([0]),
    names:['_target'], nameProvenance:[{source:'chained-bind',confidence:1,confirmed:true}],
    symbolTruth:{source:'BinaryImage',normalized:true,complete:true,reasons:[]},
  };
  const merged = mergeMachOAnalysisResults(legacy, normalized);
  assert.deepEqual(merged.names, ['_target','_objc_msgSend$foo:']);
  assert.equal(merged.symbolTruth.complete, true);
}

{
  const bytes = new Uint8Array(0x300), dv = new DataView(bytes.buffer);
  dv.setUint32(0, 0xcafebabe, false); dv.setUint32(4, 2, false);
  const CPU_ARM64 = 0x0100000c;
  const writeFat = (p, subtype, off) => {
    dv.setUint32(p, CPU_ARM64, false); dv.setUint32(p + 4, subtype, false);
    dv.setUint32(p + 8, off, false); dv.setUint32(p + 12, 32, false); dv.setUint32(p + 16, 0, false);
  };
  writeFat(8, 2, 0x100); writeFat(28, 0, 0x200);
  const writeThin = (off, subtype) => {
    dv.setUint32(off, 0xfeedfacf, true);
    dv.setInt32(off + 4, CPU_ARM64, true); dv.setInt32(off + 8, subtype, true);
    dv.setUint32(off + 12, 2, true); dv.setUint32(off + 16, 0, true);
    dv.setUint32(off + 20, 0, true); dv.setUint32(off + 24, 0, true); dv.setUint32(off + 28, 0, true);
  };
  writeThin(0x100, 2); writeThin(0x200, 0);
  const parsed = await parseMachOSource(new MemoryByteSource(bytes), { sliceIndex:1 });
  assert.equal(parsed.metadata.subtypeBase, 0);
  assert.equal(parsed.metadata.fat.selected.index, 1);
}

{
  const code = fs.readFileSync(new URL('../js/worker-budget.js', import.meta.url), 'utf8');
  const context = { Date, globalThis:null }; context.globalThis = context;
  vm.runInNewContext(code, context);
  const b = context.HexWorkerBudget.createSupplementalBudget();
  assert.equal(b.takeRead(context.HexWorkerBudget.SUPPLEMENTAL_READ_BYTES), true);
  assert.equal(b.takeRead(1), false);
  assert.equal(b.takeRegion(context.HexWorkerBudget.SUPPLEMENTAL_REGIONS), true);
  assert.equal(b.takeRegion(1), false);
}

const chained = fs.readFileSync(new URL('../js/chained.js', import.meta.url), 'utf8');
assert.match(chained, /MAX_FIXUP_BYTES = 16 \* 1024 \* 1024/);
assert.match(chained, /fixupSize > image\.sliceSize - image\.fixups\.dataoff/);
assert.match(chained, /MAX_CHAINED_IMPORTS = 250_000/);

const legacySource = fs.readFileSync(new URL('../js/worker-legacy.js', import.meta.url), 'utf8');
assert.doesNotMatch(legacySource, /const loaded = \[\]/);
assert.match(legacySource, /HexObjCStubRecovery\.recover/);
assert.match(legacySource, /cancelled, requestId/);

console.log('issues #521/#527 normalized Mach-O truth + supplemental budget regressions: PASS');
