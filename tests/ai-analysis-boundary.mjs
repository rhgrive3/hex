await import('./ai-analysis-boundary-base.mjs');

import assert from 'node:assert/strict';
import { createHexAIContext } from '../js/ai/ui/hex-context.js';
import { createHexToolRegistry } from '../js/ai/tools/registry.js';
import { irFor } from '../js/ir.js';
import { projectSemanticIrV2ToLegacyV1 } from '../js/semantics/compat/semantic-ir-v2-to-v1.js';

const bit32 = { kind:'bitvector', widthBits:32 };
const origin = (id, address = 0x1000n) => ({ instructionIds:[id], virtualRanges:[{ start:address, end:address + 4n }] });
const a = { id:'a', kind:'entry', machineType:bit32, sourceEntityId:'fn', variableKey:'state:a', origin:origin('raw_a') };
const b = { id:'b', kind:'entry', machineType:bit32, sourceEntityId:'fn', variableKey:'state:b', origin:origin('raw_b') };
const sum = { id:'sum', kind:'definition', machineType:bit32, definitionNodeId:'n_add', sourceEntityId:'n_add', variableKey:'state:sum', origin:origin('raw_add', 0x1004n) };
const canonical = {
  schemaVersion:2,
  contractVersion:'2.0.0',
  functionId:'fn',
  entryBlockId:'b0',
  blocks:[{ id:'b0', nodeIds:['n_add','n_ret'], origin:origin('block') }],
  values:[a,b,sum],
  nodes:[
    { id:'n_add', kind:'binary', blockId:'b0', inputs:['a','b'], outputs:['sum'], operator:'add', origin:origin('raw_add', 0x1004n) },
    { id:'n_ret', kind:'return', blockId:'b0', inputs:['sum'], outputs:[], origin:origin('raw_ret', 0x1008n) },
  ],
  completeness:'complete',
  unknowns:[],
  origin:origin('fn'),
};
const projected = projectSemanticIrV2ToLegacyV1(canonical);
assert.equal(projected.compat?.projection, 'semantic-ir-v2-to-v1');
assert.equal(irFor(projected), projected,
  'an official v2->v1 compatibility projection is already semantic IR and must never be re-lifted as raw ARM64');

const region = { id:'text', vmAddr:0x1000n, size:0x100n, exec:true, read:true, write:false };
const state = new Map([
  ['fileInfo', { name:'fixture', size:0x100n, formatId:'elf' }],
  ['sliceIndex', 0],
  ['regions', [region]],
  ['currentRegion', region],
  ['currentAddress', 0x1000n],
  ['architecture', 'x86_64'],
  ['capability', { architecture:'x86_64', instructionAlignment:1 }],
  ['instructionAlignment', 1],
  ['canDisassemble', true],
]);
let snapshotCalls = 0;
let functionCalls = 0;
let instructionCalls = 0;
let xrefCalls = 0;
let callerCalls = 0;
let calleeCalls = 0;
let causalCalls = 0;
let searchCalls = 0;
let decompileCalls = 0;

const analysisQueries = {
  async snapshot() { snapshotCalls++; return { snapshotId:`s${snapshotCalls}`, binaryId:'fixture-bin' }; },
  async function() {
    functionCalls++;
    if (functionCalls === 1) {
      const error = new Error('stale once');
      error.name = 'AnalysisSnapshotStaleError';
      throw error;
    }
    return { value:{ name:'fixture_fn', startAddress:0x1000n, pipeline:{ legacyV1:projected } }, completeness:'complete', status:{ completeness:'complete' } };
  },
  async instructions(_snapshot, _range, page) {
    instructionCalls++;
    const rows = [
      { id:'raw-0', address:0x1000n, size:2, mnemonic:'raw_mov', operands:'eax, ebx' },
      { id:'raw-1', address:0x1002n, size:1, mnemonic:'raw_ret', operands:'' },
    ];
    return { value:rows.slice(page.offset, page.offset + page.limit), page:{ offset:page.offset, limit:page.limit, returned:Math.min(rows.length, page.limit), total:rows.length, next:null }, completeness:'complete', status:{ completeness:'complete' } };
  },
  async functions() { return { value:[{ address:0x1000n, name:'fixture_fn' }], page:{ offset:0, returned:1, total:1, next:null }, completeness:'complete', status:{ completeness:'complete' } }; },
  async binaryInfo() { return { value:{ regions:[region] }, completeness:'complete', status:{ completeness:'complete' } }; },
  async search() { searchCalls++; return { value:[], completeness:'unsupported', status:{ completeness:'unsupported', reason:'typed-search-producer-unavailable' } }; },
  async decompile() { decompileCalls++; return { value:{ pseudocode:'short pseudo' }, completeness:'partial', status:{ completeness:'partial', reason:'upstream-partial' } }; },
  async cfg() { return { value:{ blocks:[], edges:[] }, completeness:'complete', status:{ completeness:'complete' } }; },
  async xrefs(_snapshot, _address, page) { xrefCalls++; return { value:[{ kind:'reference', site:0x1010n, target:0x1000n }], page:{ offset:page.offset, returned:1, total:1, next:null }, completeness:'complete', status:{ completeness:'complete' } }; },
  async callers(_snapshot, _address, page) { callerCalls++; return { value:[{ address:0x1100n }], page:{ offset:page.offset, returned:1, total:1, next:null }, completeness:'complete', status:{ completeness:'complete' } }; },
  async callees(_snapshot, _address, page) { calleeCalls++; return { value:[{ address:0x1200n }], page:{ offset:page.offset, returned:1, total:1, next:null }, completeness:'complete', status:{ completeness:'complete' } }; },
  async causalPath() { causalCalls++; return { value:{ paths:[{ from:'0x1000', to:'0x1200' }], returned:1 }, completeness:'partial', status:{ completeness:'partial', reason:'causal-budget' } }; },
};

const app = {
  store:{ get:key => state.get(key) ?? null },
  backend:{ binaryId:'fixture-bin', gen:1 },
  analysisQueries,
  workspace:null,
  activeProject:null,
  notes:null,
  lastGoal:null,
  viewer:null,
};
Object.defineProperties(app, {
  symbols:{ get(){ throw new Error('direct-symbol-index-read'); } },
  program:{ get(){ throw new Error('direct-program-index-read'); } },
  recognition:{ get(){ throw new Error('direct-recognition-index-read'); } },
  stringIndex:{ get(){ throw new Error('direct-string-index-read'); } },
});

const context = createHexAIContext(app);
assert.equal(context.analysisAuthority, 'AnalysisQueryAPI');
assert.equal(context.symbols, null);
assert.equal(context.program, null);
assert.deepEqual(context.functions, []);
assert.deepEqual(context.strings, []);

const model = await context.analyze(0x1000n);
assert.equal(model, projected);
assert.equal(functionCalls, 2, 'one stale Query snapshot must be retried exactly once');
assert.ok(snapshotCalls >= 2);

const unsupportedStrings = await context.searchStrings('abc', { limit:10 });
assert.equal(searchCalls, 1);
assert.equal(unsupportedStrings.complete, false,
  'all-unsupported typed search producers must never fabricate a complete empty string index');
assert.equal(unsupportedStrings.truncated, true);
assert.equal(unsupportedStrings.reason, 'typed-search-producer-unavailable');

const registry = createHexToolRegistry(context);
const functionResult = await registry.execute('get_function', { address:'0x1000' });
assert.equal(instructionCalls, 1);
assert.match(functionResult.result.assemblyExcerpt, /raw_mov eax, ebx/,
  'raw assembly must come from QueryAPI.instructions, not the semantic compatibility projection');
assert.equal(functionResult.result.analysisAuthority, 'AnalysisQueryAPI');

const xrefs = await registry.execute('get_xrefs', { address:'0x1000', limit:20 });
assert.equal(xrefCalls, 1);
assert.equal(xrefs.result.results.length, 1);
const callers = await registry.execute('get_callers', { address:'0x1000', limit:20 });
const callees = await registry.execute('get_callees', { address:'0x1000', limit:20 });
assert.equal(callerCalls, 1);
assert.equal(calleeCalls, 1);
assert.equal(callers.result.complete, true);
assert.equal(callees.result.complete, true);

const decompiled = await registry.execute('decompile_function', { functionAddress:'0x1000' });
assert.equal(decompileCalls, 1);
assert.equal(decompiled.result.pseudocodeExcerpt, 'short pseudo');
assert.equal(decompiled.result.complete, false,
  'partial QueryAPI decompiler evidence must remain partial even when the preview is short');
assert.equal(decompiled.result.reason, 'upstream-partial');

const paths = await registry.execute('find_paths', { from:'0x1000', to:'0x1200' });
assert.equal(causalCalls, 1);
assert.equal(paths.result.complete, false);
assert.equal(paths.result.truncated, true);
assert.equal(paths.result.reason, 'causal-budget');
assert.equal(paths.result.analysisAuthority, 'AnalysisQueryAPI');

console.log('ai QueryAPI authority cutover regressions: PASS');
