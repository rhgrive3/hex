import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ProgramIndex, mergeProgramScans, KIND } from '../js/program.js';
import { SymbolIndex } from '../js/symbols.js';

const r1={id:'text-a',vmAddr:0x1000n,size:0x10n,exec:true,section:'__text'};
const r2={id:'text-b',vmAddr:0x2000n,size:0x10n,exec:true,section:'__cold'};

const scan1={
  regionId:r1.id,vmAddr:r1.vmAddr,words:4,
  callFrom:new BigUint64Array([0x1004n]),callTo:new BigUint64Array([0x2000n]),callCount:1,
  refFrom:new BigUint64Array([0x1008n]),refTo:new BigUint64Array([0x3000n]),refKind:new Uint8Array([1]),refCount:1,
  kinds:new Uint8Array([KIND.MOVIMM,KIND.CALL,KIND.LOAD,KIND.RET]),kindsCovered:4,
  callsCapped:false,refsCapped:false,complete:true,completeness:{complete:true,reasons:[]},
};
const scan2={
  regionId:r2.id,vmAddr:r2.vmAddr,words:4,
  callFrom:new BigUint64Array([0x2004n]),callTo:new BigUint64Array([0x1000n]),callCount:1,
  refFrom:new BigUint64Array([0x2008n]),refTo:new BigUint64Array([0x3004n]),refKind:new Uint8Array([2]),refCount:1,
  kinds:new Uint8Array([KIND.ARITH,KIND.CALL,KIND.STORE,KIND.RET]),kindsCovered:4,
  callsCapped:false,refsCapped:false,complete:true,completeness:{complete:true,reasons:[]},
};

// #560: both executable regions contribute calls/refs/stats, including cross-region BL edges.
{
  const merged=mergeProgramScans([scan2,scan1],{regions:[r1,r2]});
  assert.equal(merged.completeness.complete,true);
  assert.deepEqual(Array.from(merged.callFrom),[0x1004n,0x2004n]);
  assert.deepEqual(Array.from(merged.callTo),[0x2000n,0x1000n]);
  assert.deepEqual(Array.from(merged.refFrom),[0x1008n,0x2008n]);
  assert.equal(merged.kindRegions.length,2);

  const symbols=new SymbolIndex({
    addrs:new BigUint64Array(0),names:[],funcs:new BigUint64Array([0x1000n,0x2000n]),regions:[r1,r2],
    discoveryComplete:true,allSeedsExact:true,
  });
  const program=new ProgramIndex(merged,symbols,r1);
  assert.equal(program.callCount,2);
  assert.equal(program.refCount,2);
  assert.equal(program.graphCompleteness.callsComplete,true);
  assert.equal(program.graphCompleteness.refsComplete,true);
  assert.equal(program.statsComplete,true);
  assert.equal(program.calleesOf(0x1000n,0x1010n)[0].addr,0x2000n);
  assert.equal(program.calleesOf(0x2000n,0x2010n)[0].addr,0x1000n);
  assert.equal(program.refsFrom(0x2000n,0x2010n)[0].target,0x3004n);
  const a=program.statsOf(0x1000n,0x1010n), b=program.statsOf(0x2000n,0x2010n);
  assert.equal(a.load,1); assert.equal(a.store,0); assert.equal(a.call,1);
  assert.equal(b.load,0); assert.equal(b.store,1); assert.equal(b.arith,1);
  const range=program.functionRange(0x2000n);
  assert.equal(range?.region?.id,'text-b');
  assert.equal(range?.end,0x2010n);
}

// Missing any expected executable region makes absence evidence fail closed.
{
  const merged=mergeProgramScans([scan1],{regions:[r1,r2]});
  assert.equal(merged.completeness.complete,false);
  assert.ok(merged.completeness.reasons.some((x)=>x.includes('program-region-unscanned:text-b')));
  const p=new ProgramIndex(merged,null,r1);
  assert.equal(p.graphCompleteness.callsComplete,false);
  assert.equal(p.refsFrom(0x1000n,0x1010n).complete,false);
}

// Global caps are explicit and never silently drop later-region edges.
{
  const merged=mergeProgramScans([scan1,scan2],{regions:[r1,r2],limits:{calls:1,refs:1,kindWords:4}});
  assert.equal(merged.callCount,1);
  assert.equal(merged.refCount,1);
  assert.equal(merged.callsCapped,true);
  assert.equal(merged.refsCapped,true);
  assert.equal(merged.completeness.complete,false);
  assert.ok(merged.completeness.reasons.includes('global-call-edge-budget'));
  assert.ok(merged.completeness.reasons.includes('global-reference-budget'));
}

// #561 follow-up: refsFrom must inherit unsupported base incompleteness too.
{
  const merged=mergeProgramScans([{...scan1,unsupported:true,architecture:'x86_64',complete:false,completeness:{complete:false,reasons:['unsupported-program-analysis']}}],{regions:[r1]});
  const p=new ProgramIndex(merged,null,r1);
  const refs=p.refsFrom(0x1000n,0x1010n);
  assert.equal(refs.complete,false);
  assert.equal(refs.unsupported,true);
  assert.equal(refs.incompleteReason,'unsupported-program-analysis');
}

const app=fs.readFileSync(new URL('../js/app.js',import.meta.url),'utf8');
const backend=fs.readFileSync(new URL('../js/backend.js',import.meta.url),'utf8');
const worker=fs.readFileSync(new URL('../js/worker-legacy.js',import.meta.url),'utf8');
assert.match(app,/programRegions\(\)/);
assert.match(app,/mergeProgramScans\(scans/);
assert.match(app,/for\(let i=0;i<regions\.length;i\+\+\)/);
assert.match(app,/FUNCTION_DISCOVERY_GLOBAL_CAP/);
assert.match(backend,/scanProgram\(regionId, onProgress, limits = \{\}\)/);
assert.match(worker,/callLimit, refLimit, kindLimit/);
assert.match(worker,/outCallFrom=callFrom\.slice\(0,nCalls\)/);

console.log('issue #560 multi-exec regressions passed');
