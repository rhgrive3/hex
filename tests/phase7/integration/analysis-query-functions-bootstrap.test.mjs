import assert from 'node:assert/strict';
import { AnalysisQueryAPI } from '../../../js/analysis/query/api.js';
import { createAppAnalysisQueryAdapter } from '../../../js/analysis/query/product-adapter.js';

const region = Object.freeze({
  id:'text', name:'__text', vmAddr:0x1000n, size:0x100n,
  exec:true, read:true, write:false,
});
const state = new Map([
  ['architecture', 'arm64'],
  ['capability', Object.freeze({ architecture:'arm64', instructionAlignment:4 })],
  ['instructionAlignment', 4],
  ['sliceIndex', 0],
  ['currentRegion', region],
  ['regions', [region]],
  ['fileInfo', Object.freeze({ name:'fixture', formatId:'macho', size:0x100n })],
]);

function symbols(generation, complete, funcs = []) {
  const starts = new BigUint64Array(funcs);
  return {
    gen:generation,
    funcs:starts,
    functionStartsComplete:complete,
    functionDiscovery:{ complete },
    nameAt(address) { return BigInt(address) === 0x1000n ? 'fixture_function' : null; },
    functionAt(address) {
      const value = BigInt(address);
      return value >= 0x1000n && value < 0x1010n
        ? { start:0x1000n, end:0x1010n }
        : null;
    },
    functionEvidence() { return { source:'test-discovery', confidence:1, confirmed:true }; },
  };
}

let discoveryCalls = 0;
const app = {
  store:{ get:key => state.get(key) ?? null },
  backend:{ binaryId:'fixture-binary', gen:7, analysisRoute:'fixture' },
  symbols:symbols(1, false),
  codeRegion() { return region; },
  async ensureFunctions(requestedRegion) {
    discoveryCalls++;
    assert.equal(requestedRegion, region, 'typed producer should bootstrap the executable code region');
    if (this.symbols.functionStartsComplete) return this.symbols;
    this.symbols = symbols(2, true, [0x1000n]);
    return this.symbols;
  },
};

const api = new AnalysisQueryAPI(createAppAnalysisQueryAdapter(app));
const firstSnapshot = await api.snapshot();

const cancelled = new AbortController();
cancelled.abort(new Error('cancel-before-discovery'));
await assert.rejects(
  api.functions(firstSnapshot, {}, { offset:0, limit:20 }, { signal:cancelled.signal }),
  error => error?.name === 'AbortError',
  'an already-aborted query must terminate before any discovery work starts',
);
assert.equal(discoveryCalls, 0, 'cancellation must not bootstrap function discovery');

await assert.rejects(
  api.functions(firstSnapshot, {}, { offset:0, limit:20 }),
  error => error?.name === 'AnalysisSnapshotStaleError',
  'discovery that changes the symbol artifact must invalidate the pre-discovery snapshot',
);
assert.equal(discoveryCalls, 1);
assert.equal(app.symbols.functionStartsComplete, true);

const freshSnapshot = await api.snapshot();
const result = await api.functions(freshSnapshot, {}, { offset:0, limit:20 });
assert.equal(discoveryCalls, 1, 'complete discovery must short-circuit instead of rescanning on every query');
assert.equal(result.completeness, 'complete');
assert.equal(result.page?.total, 1);
assert.equal(result.page?.returned, 1);
assert.equal(result.value?.[0]?.address, 0x1000n);
assert.equal(result.value?.[0]?.name, 'fixture_function');
assert.equal(result.value?.[0]?.size, 0x10n);

const passiveApp = {
  ...app,
  symbols:symbols(11, false),
  ensureFunctions:undefined,
};
const passiveApi = new AnalysisQueryAPI(createAppAnalysisQueryAdapter(passiveApp));
const passiveSnapshot = await passiveApi.snapshot();
const passiveResult = await passiveApi.functions(passiveSnapshot, {}, { offset:0, limit:20 });
assert.equal(passiveResult.completeness, 'partial',
  'a host without a discovery producer must not fabricate a complete empty function inventory');
assert.equal(passiveResult.status?.reason, 'function-discovery-incomplete');
assert.equal(passiveResult.page?.total, 0);
assert.equal(passiveResult.page?.returned, 0,
  'incomplete empty discovery must preserve an explicit zero-row page instead of inventing rows');
assert.deepEqual(passiveResult.value, []);

console.log('analysis query function bootstrap: PASS');
