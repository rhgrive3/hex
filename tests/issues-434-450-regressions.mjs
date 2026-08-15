import assert from 'node:assert/strict';
import { buildSemanticModel } from '../js/blocks.js';
import { findValueUpdates } from '../js/dataflow.js';
import { verifyAccessor } from '../js/verify.js';
import { summarizeFunction } from '../js/interproc.js';
import { forwardSlice } from '../js/slice.js';
import { OP } from '../js/ir.js';
import { functionPaths } from '../js/query/causal.js';
import { traceToSemanticFacts } from '../js/runtime-evidence/index.js';
import { FunctionSandbox, MAX_SANDBOX_STEPS } from '../js/symbolic/function-sandbox.js';
import { buildObjcRuntimeIndex, resolveObjcDispatch } from '../js/apple/objc-runtime.js';
import { readVtable } from '../js/rtti.js';
import { ByteView } from '../js/binary/reader.js';
import { parseChainedBindingSites } from '../js/binary/macho-dyld.js';
import { parseImports } from '../js/binary/pe-loader.js';
import { parseProgramDynamic } from '../js/binary/elf-dynamic.js';
import { parseSourceRanges } from '../js/binary/source-reader.js';

const BASE = 0x100000000n;
const cases = [];
function test(name, fn) { cases.push([name, fn]); }
function workflowEscape(value) {
  return String(value).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}
function modelOf(lines) {
  const rows = lines.map((line, i) => {
    if (typeof line === 'object') return { row:i, address:BASE + BigInt(i * 4), ...line };
    const s = line.trim(); const p = s.indexOf(' ');
    return { row:i, address:BASE + BigInt(i * 4), mn:p < 0 ? s : s.slice(0,p), ops:p < 0 ? '' : s.slice(p + 1) };
  });
  return buildSemanticModel(rows, {
    startRow:0, endRow:rows.length - 1,
    rowOfAddress:(addr) => { const d=addr-BASE; return d < 0n || d >= BigInt(rows.length*4) ? null : Number(d/4n); },
  });
}

test('#450 bounded sandbox budget', async () => {
  const sandbox = new FunctionSandbox({ fetch: async () => null });
  await assert.rejects(() => sandbox.run({ maxSteps:Infinity }), /positive finite safe integer/);
  assert.ok(Number.isSafeInteger(MAX_SANDBOX_STEPS) && MAX_SANDBOX_STEPS > 0);
});

test('#440 setter x2 provenance', () => {
  const good = verifyAccessor(modelOf(['str x2, [x0, #0x20]', 'ret']), { offset:0x20n });
  assert.equal(good.setter, true); assert.equal(good.fromArgument, true);
  const bad = verifyAccessor(modelOf(['mov x8, x3', 'str x8, [x0, #0x20]', 'ret']), { offset:0x20n });
  assert.equal(bad.setter, true); assert.equal(bad.fromArgument, false);
  const mixed = verifyAccessor(modelOf(['add x8, x2, x3', 'str x8, [x0, #0x20]', 'ret']), { offset:0x20n });
  assert.equal(mixed.fromArgument, false);
});

test('#439 divergent PHI arithmetic', () => {
  const model = modelOf([
    'ldr w8, [x19, #0x20]',
    'cmp w0, #0',
    'b.eq #0x100000014',
    'add w9, w8, #1',
    'b #0x100000018',
    'sub w9, w8, #1',
    'str w9, [x19, #0x30]',
    'ret',
  ]);
  const u = findValueUpdates(model).find((x) => x.store?.row === 6);
  assert.ok(u, 'branch-dependent transfer should remain visible');
  assert.equal(u.branchDependent, true);
  assert.equal(u.operationKind, 'branch-transfer');
  assert.equal(u.steps.length, 0);
  assert.equal(u.alternatives.length, 2);
  assert.notEqual(u.alternatives[0].steps[0]?.op, u.alternatives[1].steps[0]?.op);
});

test('#438 arithmetic summary width', () => {
  const s = summarizeFunction(modelOf(['add w0, w0, #1', 'ret']));
  assert.equal(s.returns.length, 1);
  assert.equal(s.returns[0].kind, 'argument-arithmetic');
  assert.equal(s.returns[0].bits, 32);
});

test('#437 weak terminal x0 inference', () => {
  const s = summarizeFunction(modelOf(['bl #0x100001000', 'ret']));
  assert.equal(s.returns.length, 1);
  assert.equal(s.returns[0].inferred, true);
  assert.equal(s.classification.wrapper, false);
  assert.equal(s.classification.forwarding, false);
  assert.equal(s.classification.returnEvidence, 'inferred-terminal-x0');
});

test('#436 Memory SSA PHI forward slice', () => {
  const loc={key:'field:x0:32'};
  const store={id:1,op:OP.STORE,block:0,row:0,loc,dst:null};
  const sink={id:3,op:OP.BIN,block:2,row:2,dst:null,args:[]};
  const value={id:100,uses:[sink]};
  const nested={kind:'phi',incoming:[{node:{kind:'store',inst:store}}]};
  const load={id:2,op:OP.LOAD,block:2,row:1,loc,reachingStore:null,memUse:{kind:'phi',incoming:[{node:nested}]},dst:value};
  const ir={instructions:[store,load,sink]};
  const result=forwardSlice(ir,store);
  assert.ok(result.instructions.includes(load));
  assert.ok(result.instructions.includes(sink));
});

test('#435 call path completeness', () => {
  const completeProgram={
    graphCompleteness:{callsComplete:true},
    functionRange:()=>({end:9n}),
    calleesOf:(x)=>x===1n?[2n]:x===2n?[3n]:[],
  };
  const found=functionPaths(completeProgram,1n,3n,{maxDepth:4});
  assert.deepEqual(found.paths,[[1n,2n,3n]]); assert.equal(found.complete,true);
  const partial=functionPaths({...completeProgram,graphCompleteness:{callsComplete:false}},1n,9n,{maxDepth:2});
  assert.equal(partial.complete,false); assert.equal(partial.truncated,true);
  assert.ok(partial.reasons.includes('depth-limit'));
  assert.ok(partial.reasons.includes('program-calls-incomplete'));
});

test('#434 runtime fact completeness', () => {
  const capped=traceToSemanticFacts({events:[
    {type:'memory-read',address:1n,size:4,value:1n},
    {type:'memory-write',address:2n,size:4,before:1n,after:2n},
  ]},{limit:1});
  assert.equal(capped.facts.length,1); assert.equal(capped.complete,false);
  assert.ok(capped.reasons.includes('fact-limit'));
  const sourcePartial=traceToSemanticFacts({events:[{type:'return',value:1n}],truncated:true,dropped:3},{limit:10});
  assert.equal(sourcePartial.complete,false); assert.ok(sourcePartial.reasons.includes('source-trace-truncated'));
  assert.equal(sourcePartial.facts[0].observationComplete,false);
});

test('#441 protocol requirement vs IMP', () => {
  const protocolOnly=buildObjcRuntimeIndex({protocols:[{name:'P',methods:[{sel:'work:',addr:null}]}]});
  const r=resolveObjcDispatch(protocolOnly,{selector:'work:',protocols:['P']});
  assert.equal(r.resolved,null); assert.equal(r.candidates.length,0); assert.equal(r.requirements.length,1);
  const concrete=buildObjcRuntimeIndex({classes:[{name:'Worker',methods:[{sel:'work:',addr:0x1234n}]}],protocols:[{name:'P',methods:[{sel:'work:',addr:null}]}]});
  const c=resolveObjcDispatch(concrete,{receiverType:'Worker',selector:'work:',protocols:['P']});
  assert.equal(c.resolved?.imp,0x1234n); assert.equal(c.requirements.length,1);
});

test('#443 chained vtable pointer identity', async () => {
  const bytes=new Uint8Array(32); const dv=new DataView(bytes.buffer);
  dv.setBigUint64(0,0n,true); dv.setBigUint64(8,0x20n,true);
  dv.setBigUint64(16,(1n<<63n)|3n,true); dv.setBigUint64(24,0n,true);
  const vt=await readVtable(async()=>bytes,BASE,null,2,{pointerFormat:6,imageBase:BASE});
  assert.equal(vt.typeinfo,BASE+0x20n);
  assert.equal(vt.slots[0].addr,null); assert.equal(vt.slots[0].binding.ordinal,3);
  const tagged=new Uint8Array(32); const tdv=new DataView(tagged.buffer);
  tdv.setBigUint64(8,0xf000000000000123n,true); tdv.setBigUint64(16,0xf000000000000456n,true);
  const unresolved=await readVtable(async()=>tagged,BASE,null,2);
  assert.equal(unresolved.typeinfo,null); assert.equal(unresolved.slots[0].addr,null);
  assert.equal(unresolved.slots[0].unresolved,true);
});

test('#446 ARM64E kernel chained stride', () => {
  const bytes=new Uint8Array(0x200); const dv=new DataView(bytes.buffer);
  dv.setUint32(4,28,true);
  dv.setUint32(28,1,true);
  dv.setUint32(32,8,true);
  const p=36;
  dv.setUint32(p,24,true); dv.setUint16(p+4,0x1000,true); dv.setUint16(p+6,7,true);
  dv.setBigUint64(p+8,0x100n,true); dv.setUint32(p+16,0,true); dv.setUint16(p+20,1,true); dv.setUint16(p+22,0,true);
  dv.setBigUint64(0x100,(1n<<62n)|(2n<<51n)|0n,true);
  dv.setBigUint64(0x108,(1n<<62n)|1n,true);
  const r=new ByteView(bytes);
  const imports=[{sites:[]},{sites:[]}];
  const image={imageBase:BASE,metadata:{chainedFixups:{}},warnings:[],addressToOffset:(a)=>a-BASE};
  parseChainedBindingSites(r,{offset:0,size:0x80},image,imports);
  assert.equal(imports[0].sites.length,1); assert.equal(imports[1].sites.length,1);
});

test('#447 dynamic ABI minimum entry size', () => {
  const bytes=new Uint8Array(0x100); const dv=new DataView(bytes.buffer);
  const entries=[
    [11n,8n],
    [17n,0x1000n],[18n,16n],[19n,4n],
    [7n,0x2000n],[8n,24n],[9n,8n],
    [0n,0n],
  ];
  entries.forEach(([tag,val],i)=>{dv.setBigInt64(i*16,tag,true);dv.setBigUint64(i*16+8,val,true);});
  const image={warnings:[],metadata:{},sections:[],segments:[],libraries:[],symbols:[],imports:[],exports:[],functions:[],relocations:[],addressToOffset:()=>null};
  parseProgramDynamic(new ByteView(bytes),[{type:2,offset:0n,filesz:BigInt(entries.length*16)}],image,64);
  assert.ok(image.warnings.some((w)=>w.includes('DT_SYMENT')));
  assert.ok(image.warnings.some((w)=>w.includes('PT_DYNAMIC-REL entry size')));
  assert.ok(image.warnings.some((w)=>w.includes('PT_DYNAMIC-RELA entry size')));
});

test('#448 bounded PE import thunks', () => {
  const bytes=new Uint8Array(0x500); const dv=new DataView(bytes.buffer); const te=new TextEncoder();
  dv.setUint32(0x100,0x2000,true); dv.setUint32(0x10c,0x4000,true); dv.setUint32(0x110,0x3000,true);
  te.encodeInto('X.dll\0',bytes.subarray(0x380));
  dv.setBigUint64(0x200,0x4010n,true); dv.setBigUint64(0x208,0x4020n,true);
  dv.setBigUint64(0x210,0x4030n,true);
  dv.setUint16(0x390,0,true); te.encodeInto('A\0',bytes.subarray(0x392));
  dv.setUint16(0x3a0,0,true); te.encodeInto('B\0',bytes.subarray(0x3a2));
  dv.setUint16(0x3b0,0,true); te.encodeInto('FAKE\0',bytes.subarray(0x3b2));
  const sections=[
    {address:0x140001000n,fileOffset:0x100n,fileSize:0x28n,size:0x100n},
    {address:0x140002000n,fileOffset:0x200n,fileSize:0x10n,size:0x100n},
    {address:0x140003000n,fileOffset:0x300n,fileSize:0x10n,size:0x100n},
    {address:0x140004000n,fileOffset:0x380n,fileSize:0x80n,size:0x100n},
  ];
  const image={bits:64,imageBase:0x140000000n,sections,segments:[],imports:[],libraries:[],metadata:{},warnings:[]};
  image.addressToOffset=(address)=>{for(const s of sections){if(address>=s.address&&address<s.address+s.fileSize)return s.fileOffset+(address-s.address);}return null;};
  parseImports(new ByteView(bytes),{rva:0x1000,size:40},image);
  assert.deepEqual(image.imports.map((x)=>x.name),['A','B']);
  assert.equal(image.metadata.peImports.complete,false);
  assert.ok(image.warnings.some((w)=>/boundary without a NUL terminator/.test(w)));
});

test('#466 source read cancellation', async () => {
  const controller=new AbortController(); controller.abort('test-cancel'); let reads=0;
  const source={size:16n,maxReadLength:16,readExactly:async()=>{reads++;return new Uint8Array(16);}};
  await assert.rejects(()=>parseSourceRanges(source,()=>({attachSource(){},metadata:{}}),{}, {signal:controller.signal}), (e)=>e?.name==='AbortError'&&e?.code==='BYTE_SOURCE_CANCELLED');
  assert.equal(reads,0);
});

for (const [name, fn] of cases) {
  try {
    await fn();
    console.log(`ok ${name}`);
  } catch (error) {
    const detail = workflowEscape(error?.stack || error?.message || error);
    console.error(`::error title=${workflowEscape(name)}::${detail}`);
    throw error;
  }
}

console.log('issues #434-#450 regressions PASS');
