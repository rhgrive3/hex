import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHexToolRegistry } from '../js/ai/tools/registry.js';
import { autoAnalyze } from '../js/auto.js';

const app = fs.readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
const ctx = fs.readFileSync(new URL('../js/ai/ui/hex-context.js', import.meta.url), 'utf8');
const panels = fs.readFileSync(new URL('../js/panels.js', import.meta.url), 'utf8');

assert.match(app, /this\.swiftModel = null;[\s\S]*this\.recognition = null;/, 'slice reset must invalidate Swift and recognition state');
assert.match(app, /Promise\.allSettled\(\[[\s\S]*this\.ensureObjc\(sliceIndex\)[\s\S]*this\.ensureSwift\(\)[\s\S]*this\.ensureRecognition/, 'symbol-ready path must start ObjC, Swift and global recognition');
assert.match(app, /knowledgeLimit[\s\S]*this\.knowledge\.propagate[\s\S]*knowledgeComplete/, 'global recognition must use a separate bounded KnowledgeDB reidentification budget');
assert.match(panels, /recognition=await app\.ensureRecognition[\s\S]*shapes, recognition/, 'Auto Analysis must receive global recognition truth');
assert.match(ctx, /get knowledge\(\)/, 'AI context must expose KnowledgeDB');
assert.match(ctx, /async searchFunctions[\s\S]*app\.ensureRecognition/, 'AI function search must use product recognition ranking');
assert.match(ctx, /resolveSwiftDispatch/, 'AI context must expose Swift dispatch');
assert.match(ctx, /swiftRuntimeIndex: app\.swiftRuntime/, 'Decompiler context must receive Swift runtime index');

const registry = createHexToolRegistry({
  functions: [], candidateFunctions: [],
  resolveSwiftDispatch: async (args) => ({ resolved:'0x1234', candidates:[{address:'0x1234'}], confidence:0.9, complete:true, args }),
});
assert.equal(registry.has('resolve_swift_dispatch'), true, 'Swift runtime must expose a deterministic AI tool');
const dispatched = await registry.execute('resolve_swift_dispatch', { kind:'witness', type:'T', protocol:'P', slot:2 }, { scope:'binary' });
assert.equal(dispatched.result.resolved, '0x1234');
assert.equal(dispatched.result.complete, true);

const fakeProgram = {
  functionRange: (addr) => ({ start:addr, end:addr+4n }),
  statsOf: () => ({ total:1, numeric:0, store:0, load:0, cmp:0 }),
  callCountOf: () => 0,
  functionsReferencing: () => Object.assign([], { complete:true }),
  callCount:0, refCount:0, statsComplete:true, callsCapped:false, refsCapped:false,
};
const fakeSymbols = { functionCount:2, funcs:[0x1000n,0x2000n], functionAt:(a)=>({start:a,end:a+4n}), nameAt:()=>null };
const report = await autoAnalyze({
  strings:[], program:fakeProgram, symbols:fakeSymbols, region:{vmAddr:0x1000n,size:0x2000n}, deepLimit:0,
  recognition:{complete:true,scannedCount:2,total:2,knowledgeMatches:1,records:[
    {address:0x2000n,name:'App::reward',classification:'APPLICATION',score:0.95,confidence:0.9,knowledge:{names:['App::reward']}},
    {address:0x1000n,name:'swift_release',classification:'RUNTIME',score:0,confidence:0.9},
  ]},
});
assert.equal(report.notable[0].addr, 0x2000n, 'Auto Analysis should prioritize application recognition without hard-dropping fallback candidates');
assert.equal(report.stats.recognition.knowledgeMatches, 1);

console.log('issues #531/#541 product intelligence regressions: PASS');
