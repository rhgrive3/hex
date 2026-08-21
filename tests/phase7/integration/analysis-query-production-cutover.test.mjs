import assert from 'node:assert/strict';
import { AnalysisQueryAPI, createAppAnalysisQueryAdapter } from '../../../js/analysis/query/index.js';

const identity = Object.freeze({
  binaryId:'bin_contract',
  projectRevision:0,
  analysisEpoch:1,
  artifactVersions:{ query:'1' },
});

const methodCalls = [];
const contractAdapter = {
  async currentIdentity() { return identity; },
};
for (const method of [
  'binaryInfo', 'functions', 'functionById', 'instructions', 'semanticIR', 'cfg',
  'callers', 'callees', 'xrefs', 'types', 'evidence', 'decompile', 'search', 'causalPath',
]) {
  contractAdapter[method] = async (...args) => {
    methodCalls.push(method);
    return {
      value:{ method, args:args.slice(1, -1) },
      status:{ completeness:'complete', producer:'contract-test' },
      cost:{ units:1 },
    };
  };
}

const contractApi = new AnalysisQueryAPI(contractAdapter);
const contractSnapshot = await contractApi.snapshot();
const invocations = [
  () => contractApi.binaryInfo(contractSnapshot),
  () => contractApi.functions(contractSnapshot, { text:'foo' }, { offset:0, limit:10 }),
  () => contractApi.function(contractSnapshot, '0x1000'),
  () => contractApi.instructions(contractSnapshot, { start:0x1000n, end:0x1010n }, { limit:10 }),
  () => contractApi.semanticIR(contractSnapshot, '0x1000'),
  () => contractApi.cfg(contractSnapshot, '0x1000'),
  () => contractApi.callers(contractSnapshot, '0x1000', { limit:10 }),
  () => contractApi.callees(contractSnapshot, '0x1000', { limit:10 }),
  () => contractApi.xrefs(contractSnapshot, '0x1000', { limit:10 }),
  () => contractApi.types(contractSnapshot, { functionId:'0x1000' }, { limit:10 }),
  () => contractApi.evidence(contractSnapshot, { functionId:'0x1000' }, { limit:10 }),
  () => contractApi.decompile(contractSnapshot, '0x1000'),
  () => contractApi.search(contractSnapshot, { kind:'hex', bytes:[0] }, { limit:10 }),
  () => contractApi.causalPath(contractSnapshot, { functionId:'0x1000' }, { functionId:'0x1000' }),
];
for (const invoke of invocations) {
  const result = await invoke();
  assert.equal(result.completeness, 'complete');
  assert.equal(result.status.producer, 'contract-test');
  assert.deepEqual(result.cost, { units:1 });
}
assert.deepEqual(methodCalls, [
  'binaryInfo', 'functions', 'functionById', 'instructions', 'semanticIR', 'cfg',
  'callers', 'callees', 'xrefs', 'types', 'evidence', 'decompile', 'search', 'causalPath',
]);

const semanticIr = Object.freeze({ schemaVersion:'semantic-ir/v2', nodes:[{ id:'n1' }] });
const cfg = Object.freeze({ schemaVersion:'cfg/v2', blocks:[{ id:'b0' }], edges:[] });
const region = Object.freeze({ id:'text', vmAddr:0x1000n, size:0x100n, exec:true, read:true, write:false });
let canonicalCalls = 0;
let bypassCalls = 0;
const x86App = {
  store:{
    get(key) {
      if (key === 'architecture') return 'x86_64';
      if (key === 'canDisassemble') return true;
      if (key === 'instructionAlignment') return 1;
      if (key === 'sliceIndex') return 0;
      if (key === 'regions') return [region];
      if (key === 'currentRegion') return region;
      if (key === 'fileInfo') return {
        formatId:'elf',
        slices:[{
          capability:{ architecture:'x86_64' },
          info:{ descriptor:{ formatId:'elf', formatMetadata:{ bits:64, platform:'System V' } } },
          regions:[region],
        }],
      };
      return null;
    },
  },
  backend:{
    binaryId:'bin_x86_live',
    gen:11,
    formatId:'elf',
    async binaryMetadata() {
      return { summary:{ format:'elf', arch:'x86_64', bits:64, platform:'System V' }, metadata:{} };
    },
    async analyzeSemanticFunction(options) {
      canonicalCalls++;
      assert.equal(options.architecture, 'x86_64');
      assert.equal(options.abiId, 'sysv-amd64');
      assert.equal(options.platform, 'unix');
      assert.equal(options.address, 0x1000n);
      assert.equal(options.length, 0x20);
      return {
        route:'phase5-shadow-v2',
        architectureId:'x86_64',
        abiId:options.abiId,
        pipeline:{ semanticIr, cfg, instrumentation:{ v2Executed:true } },
        decompiler:{ semantic:true, signature:'int f(void)', pseudocode:'int f(void) { return 1; }', lines:[], evidence:[] },
      };
    },
  },
  symbols:{
    functionCount:1,
    funcs:new BigUint64Array([0x1000n]),
    functionStartsComplete:true,
    functionAt(address) { return BigInt(address) >= 0x1000n && BigInt(address) < 0x1020n ? { start:0x1000n, end:0x1020n, index:0 } : null; },
    nameAt(address) { return BigInt(address) === 0x1000n ? 'f' : null; },
    label() { return null; },
    functionEvidence() { return { source:'test', confirmed:true }; },
  },
  validatedFunctionRange(address) {
    assert.equal(BigInt(address), 0x1000n);
    return { ok:true, start:0x1000n, end:0x1020n, region, function:{ start:0x1000n, end:0x1020n }, complete:true, reason:null, provenance:'test-range' };
  },
  executableRegionFor(address) {
    const value = BigInt(address);
    return value >= region.vmAddr && value < region.vmAddr + region.size ? region : null;
  },
  async analyzeFunctionAt() {
    bypassCalls++;
    throw new Error('legacy-product-route-must-not-run-for-x86');
  },
};

const x86Api = new AnalysisQueryAPI(createAppAnalysisQueryAdapter(x86App));
x86App.analysisQueries = x86Api;
assert.equal(x86App.analyzeFunctionAt.name, 'routedAnalyzeFunctionAt',
  'the real App analyzeFunctionAt entry must be replaced even when _fetchFunctionModel does not exist');

const routedX86 = await x86App.analyzeFunctionAt(0x1000n);
assert.equal(routedX86.architectureId, 'x86_64');
assert.equal(routedX86.decompiler.semantic, true);
assert.equal(bypassCalls, 0, 'production Function Workspace must not fall back to the old ARM-only method');
assert.equal(canonicalCalls, 1);

const x86Snapshot = await x86Api.snapshot();
assert.equal((await x86Api.semanticIR(x86Snapshot, '0x1000')).value, semanticIr);
assert.equal((await x86Api.cfg(x86Snapshot, '0x1000')).value, cfg);
assert.equal((await x86Api.decompile(x86Snapshot, '0x1000')).value.pseudocode, 'int f(void) { return 1; }');
assert.equal(canonicalCalls, 4, 'each immutable query reaches the canonical producer or its artifact warm path');

let riscvCalls = 0;
function riscvApp(flags) {
  return {
    store:{
      get(key) {
        if (key === 'architecture') return 'riscv64';
        if (key === 'sliceIndex') return 0;
        if (key === 'regions') return [region];
        if (key === 'fileInfo') return {
          formatId:'elf',
          slices:[{
            capability:{ architecture:'riscv64' },
            info:{ descriptor:{ formatId:'elf', formatMetadata:{ bits:64, platform:'System V' } } },
            regions:[region],
          }],
        };
        return null;
      },
    },
    backend:{
      binaryId:`bin_riscv_${String(flags)}`,
      gen:12,
      formatId:'elf',
      async binaryMetadata() {
        return { summary:{ format:'elf', arch:'riscv64', bits:64, platform:'System V' }, metadata:flags == null ? {} : { flags } };
      },
      async analyzeSemanticFunction(options) {
        riscvCalls++;
        assert.equal(options.architecture, 'riscv64');
        assert.equal(options.abiId, 'lp64d', 'EF_RISCV_FLOAT_ABI_DOUBLE must select LP64D');
        return {
          route:'phase5-shadow-v2',
          architectureId:'riscv64',
          abiId:options.abiId,
          pipeline:{ semanticIr, cfg },
          decompiler:{ semantic:true, pseudocode:'long f(void);', lines:[], evidence:[] },
        };
      },
    },
    symbols:x86App.symbols,
    validatedFunctionRange:x86App.validatedFunctionRange,
    executableRegionFor:x86App.executableRegionFor,
    async analyzeFunctionAt() { throw new Error('riscv must not use legacy analyzer'); },
  };
}

const rv = riscvApp(0x0004);
const rvApi = new AnalysisQueryAPI(createAppAnalysisQueryAdapter(rv));
rv.analysisQueries = rvApi;
const rvSnapshot = await rvApi.snapshot();
const rvFunction = await rvApi.function(rvSnapshot, '0x1000');
assert.equal(rvFunction.completeness, 'complete');
assert.equal(rvFunction.value.abiId, 'lp64d');
assert.equal(rvFunction.status.abiEvidence, 'elf-e-flags');
assert.equal(riscvCalls, 1);

const unprovenRv = riscvApp(null);
const unprovenApi = new AnalysisQueryAPI(createAppAnalysisQueryAdapter(unprovenRv));
unprovenRv.analysisQueries = unprovenApi;
const unprovenSnapshot = await unprovenApi.snapshot();
const unproven = await unprovenApi.function(unprovenSnapshot, '0x1000');
assert.equal(unproven.completeness, 'unsupported');
assert.equal(unproven.status.reason, 'riscv-elf-flags-unavailable');
assert.equal(riscvCalls, 1, 'missing ABI evidence must fail closed before semantic analysis');

const missingMethodApi = new AnalysisQueryAPI({ async currentIdentity() { return identity; } });
const missingSnapshot = await missingMethodApi.snapshot();
const missing = await missingMethodApi.causalPath(missingSnapshot, 'a', 'b');
assert.equal(missing.completeness, 'unsupported');
assert.match(missing.status.reason, /causalPath-unavailable/);

console.log('phase7 AnalysisQueryAPI public surface + production App cutover: PASS');
