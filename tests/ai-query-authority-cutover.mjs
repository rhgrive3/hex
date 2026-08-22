import assert from 'node:assert/strict';
import { createHexAIContext } from '../js/ai/ui/hex-context.js';
import { createHexToolRegistry } from '../js/ai/tools/registry.js';
import { irFor } from '../js/ir.js';

const projected = {
  functionId:'fn',
  startAddress:0x1000n,
  semanticIrVersion:'2.0.0',
  compat:{ projection:'semantic-ir-v2-to-v1', version:'test' },
  instructions:[],
  blocks:[],
  values:[],
  truncated:false,
  defUse(){ return null; },
};
assert.equal(irFor(projected), projected,
  'canonical v2 compatibility IR must not be re-lifted by the legacy ARM64 path');

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
let searchCalls = 0;
let decompileCalls = 0;
let xrefCalls = 0;
let callerCalls = 0;
let calleeCalls = 0;
let causalCalls = 0;

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
    return { value:rows.slice(page.offset, page.offset + page.limit), page:{ offset:page.offset, limit:page.limit, returned:rows.length, total:rows.length, next:null }, completeness:'complete', status:{ completeness:'complete' } };
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
assert.notEqual(model, projected, 'presentation may clone canonical compatibility IR');
assert.equal(model?.compat?.projection, 'semantic-ir-v2-to-v1');
assert.equal(irFor(model), model,
  'a cloned canonical compatibility model must remain semantic IR rather than being re-lifted');
assert.equal(functionCalls, 2, 'one stale Query snapshot must be retried exactly once');
assert.ok(snapshotCalls >= 2);

const assembly = await context.getInstructions(0x1000n, { limit:20 });
assert.equal(instructionCalls, 1);
assert.equal(assembly.results[0].mnemonic, 'raw_mov',
  'raw assembly must come from QueryAPI.instructions, not semantic compatibility IR');

const unsupportedStrings = await context.searchStrings('abc', { limit:10 });
assert.equal(searchCalls, 1);
assert.equal(unsupportedStrings.complete, false);
assert.equal(unsupportedStrings.truncated, true);
assert.equal(unsupportedStrings.reason, 'typed-search-producer-unavailable');

// The repository-wide cancellation contract preserves explicit falsy reasons.
// The Query facade must not regress them back to a synthetic AbortError.
for (const [label, invoke, reason] of [
  ['inherited Query method', (signal) => context.getInstructions(0x1000n, { signal }), false],
  ['inherited analysis method', (signal) => context.analyze(0x1000n, null, { signal }), 0],
  ['facade Query method', (signal) => context.searchStrings('abc', { signal }), ''],
]) {
  const controller = new AbortController();
  controller.abort(reason);
  let caught = Symbol('not-caught');
  try {
    await invoke(controller.signal);
    assert.fail(`${label} must reject an aborted request`);
  } catch (error) {
    caught = error;
  }
  assert.ok(Object.is(caught, reason), `${label} must preserve the exact falsy AbortSignal.reason`);
}

const registry = createHexToolRegistry(context);
const xrefs = await registry.execute('get_xrefs', { address:'0x1000', limit:20 });
const callers = await registry.execute('get_callers', { address:'0x1000', limit:20 });
const callees = await registry.execute('get_callees', { address:'0x1000', limit:20 });
assert.equal(xrefCalls, 1);
assert.equal(callerCalls, 1);
assert.equal(calleeCalls, 1);
assert.equal(xrefs.result.complete, true);
assert.equal(callers.result.complete, true);
assert.equal(callees.result.complete, true);

const decompiled = await registry.execute('decompile_function', { functionAddress:'0x1000' });
assert.equal(decompileCalls, 1);
assert.equal(decompiled.result.pseudocodeExcerpt, 'short pseudo');
assert.equal(decompiled.result.complete, false,
  'partial QueryAPI decompiler evidence must remain partial even with a short preview');
assert.equal(decompiled.result.reason, 'upstream-partial');

const paths = await registry.execute('find_paths', { from:'0x1000', to:'0x1200' });
assert.equal(causalCalls, 1);
assert.equal(paths.result.complete, false);
assert.equal(paths.result.truncated, true);
assert.equal(paths.result.reason, 'causal-budget');
assert.equal(paths.result.analysisAuthority, 'AnalysisQueryAPI');

console.log('ai QueryAPI authority cutover regressions: PASS');
