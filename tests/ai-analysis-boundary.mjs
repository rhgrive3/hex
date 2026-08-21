import assert from 'node:assert/strict';
import {
  analyzeFunctionCached,
  clearAnalysisCache,
  supportsArm64SemanticAnalysis,
} from '../js/analyze.js';
import { analyzeModelAt, createHexAIContext } from '../js/ai/ui/hex-context.js';
import { ToolRegistry } from '../js/ai/tools/registry-core.js';

const CHUNK_ROWS=1024;
function backendFor(totalRows){
  const state={fetches:0};
  return {
    state,
    gen:1,
    async fetchChunk(_regionId,chunk){
      state.fetches++;
      const start=chunk*CHUNK_ROWS;
      const count=Math.max(0,Math.min(CHUNK_ROWS,totalRows-start));
      return {
        mn:new Array(count).fill('nop'),
        ops:new Array(count).fill(''),
        bytes:new Uint8Array(count*4),
        rows:count,
      };
    },
  };
}
function symbolsFor(start=0x1000n,end=null){
  return {
    gen:1,functionCount:1,
    functionAt(addr){return addr===start?{start,end,index:0}:null;},
    nameAt(){return null;},
  };
}
function storeFor(region,architecture='arm64'){
  const values={
    architecture,capability:{architecture,instructionAlignment:architecture.startsWith('arm64')?4:1},
    instructionAlignment:architecture.startsWith('arm64')?4:1,canDisassemble:true,
    currentRegion:region,regions:[region],sliceIndex:0,fileInfo:{name:'fixture'},currentAddress:region.vmAddr,
  };
  return {values,get(key){return this.values[key];}};
}

assert.equal(supportsArm64SemanticAnalysis('arm64'),true);
assert.equal(supportsArm64SemanticAnalysis('arm64e'),true);
assert.equal(supportsArm64SemanticAnalysis('arm64_32'),true);
assert.equal(supportsArm64SemanticAnalysis('x86_64'),false);

// The semantic builder caps itself at 6000 instructions. The analysis feeder
// must retain a one-row sentinel so >6000 input cannot masquerade as complete.
{
  clearAnalysisCache();
  const total=6001;
  const region={id:'text-long',vmAddr:0x1000n,size:BigInt(total*4),exec:true};
  const backend=backendFor(total);
  const result=await analyzeFunctionCached(backend,region,0,total-1,symbolsFor());
  assert.equal(result.endRow,total-1);
  assert.equal(result.requestedRows,total);
  assert.equal(result.analyzedRows,total);
  assert.equal(result.model.truncated,true,'semantic-model cap must be reported');
  assert.equal(result.truncated,true);
}

// A caller row budget must constrain the actual backend reads, and differently
// budgeted requests must not alias in the analysis cache.
{
  clearAnalysisCache();
  const total=100;
  const region={id:'text-budget',vmAddr:0x2000n,size:BigInt(total*4),exec:true};
  const backend=backendFor(total);
  const symbols=symbolsFor(0x2000n,0x2000n+BigInt(total*4));
  const first=await analyzeFunctionCached(backend,region,0,total-1,symbols,null,{maxRows:10});
  assert.equal(first.endRow,9);
  assert.equal(first.analyzedRows,10);
  assert.equal(first.truncated,true);
  const fetchesAfterFirst=backend.state.fetches;
  const second=await analyzeFunctionCached(backend,region,0,total-1,symbols,null,{maxRows:20});
  assert.equal(second.endRow,19,'larger row budget must not reuse the 10-row cached result');
  assert.equal(second.analyzedRows,20);
  assert.ok(backend.state.fetches>fetchesAfterFirst);
}

// AI adapter: unknown function ends are inherently incomplete, and the
// control-plane maxInstructions budget must reach analyzeFunctionCached.
{
  clearAnalysisCache();
  const total=4096;
  const region={id:'text-ai',vmAddr:0x3000n,size:BigInt(total*4),exec:true};
  const backend=backendFor(total);
  const app={
    store:storeFor(region,'arm64'),backend,codeRegion:()=>region,
    symbols:symbolsFor(0x3000n,null),
  };
  const model=await analyzeModelAt(app,0x3000n,null,{maxInstructions:10});
  assert.ok(model);
  assert.equal(model.instructions.length,10);
  assert.equal(model.truncated,true,'unknown function end must fail closed');
}

// A proven end fully covered within budget remains complete.
{
  clearAnalysisCache();
  const total=64, functionRows=20;
  const region={id:'text-exact',vmAddr:0x4000n,size:BigInt(total*4),exec:true};
  const backend=backendFor(total);
  const end=0x4000n+BigInt(functionRows*4);
  const app={store:storeFor(region,'arm64'),backend,codeRegion:()=>region,symbols:symbolsFor(0x4000n,end)};
  const model=await analyzeModelAt(app,0x4000n,end,{maxInstructions:64});
  assert.ok(model);
  assert.equal(model.instructions.length,functionRows);
  assert.equal(model.truncated,false);
}

// An explicit subrange of a known function is not exhaustive even when the
// requested subrange itself fits the row budget.
{
  clearAnalysisCache();
  const total=64, functionRows=20;
  const region={id:'text-subrange',vmAddr:0x5000n,size:BigInt(total*4),exec:true};
  const backend=backendFor(total);
  const end=0x5000n+BigInt(functionRows*4);
  const app={store:storeFor(region,'arm64'),backend,codeRegion:()=>region,symbols:symbolsFor(0x5000n,end)};
  const model=await analyzeModelAt(app,0x5000n,0x5000n+20n,{maxInstructions:64});
  assert.ok(model);
  assert.equal(model.truncated,true);
}

// Generic Capstone support does not make the ARM64 semantic engine valid for
// x86_64. The UI adapter must refuse before touching the backend.
{
  clearAnalysisCache();
  const region={id:'text-x86',vmAddr:0x6000n,size:0x100n,exec:true};
  const backend=backendFor(64);
  const app={store:storeFor(region,'x86_64'),backend,codeRegion:()=>region,symbols:symbolsFor(0x6000n,0x6010n)};
  const model=await analyzeModelAt(app,0x6000n,0x6010n,{maxInstructions:16});
  assert.equal(model,null);
  assert.equal(backend.state.fetches,0,'unsupported semantic architecture must not fetch analysis chunks');
}

// The actual AI context seam must forward end/options instead of silently
// discarding the control plane's budget arguments.
{
  clearAnalysisCache();
  const total=64;
  const region={id:'text-context',vmAddr:0x7000n,size:BigInt(total*4),exec:true};
  const backend=backendFor(total);
  const end=0x7000n+80n;
  const app={
    store:storeFor(region,'arm64'),backend,codeRegion:()=>region,symbols:symbolsFor(0x7000n,end),
    recognition:{records:[]},notes:null,lastGoal:null,stringIndex:[],program:null,knowledge:null,
  };
  const context=createHexAIContext(app);
  const model=await context.analyze(0x7000n,end,{maxInstructions:5});
  assert.ok(model);
  assert.equal(model.instructions.length,5);
  assert.equal(model.truncated,true);
}

// ChatGPT Web intentionally has no model-response deadline, but local analysis
// tools must never inherit that infinity. A tool that never settles is aborted
// by its own finite deadline, and the registry returns a tool failure instead
// of leaving get_function (or any other tool) permanently pending.
{
  const registry = new ToolRegistry();
  let abortObserved = false;
  registry.register({
    name: 'hang',
    cost: 'medium',
    storeResult: false,
    async execute(_args, { signal }) {
      return new Promise((_, reject) => {
        signal.addEventListener('abort', () => {
          abortObserved = true;
          reject(new Error('cancelled'));
        }, { once: true });
      });
    },
  });
  const started = Date.now();
  await assert.rejects(
    () => registry.execute('hang', {}, { toolTimeoutMs: 25 }),
    (error) => error?.type === 'tool_failed' && /hang timed out/i.test(error.message),
  );
  assert.equal(abortObserved, true, 'tool timeout must propagate an abort signal into the local analysis');
  assert.ok(Date.now() - started < 1000, 'explicit regression timeout must settle promptly');
  assert.equal(registry.executionSignal, null, 'registry must restore its execution signal after timeout');
}

console.log('ai semantic analysis boundary regressions: PASS');