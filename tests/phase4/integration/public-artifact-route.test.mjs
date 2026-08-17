import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createBinaryIdFromDigest } from '../../../js/core/identity/index.js';

// Post-cutover proof must exercise the production default itself, not the
// rehearsal override. Preserve any caller-provided env value for process hygiene.
const previousRoute = process.env.HEX_ANALYSIS_ROUTE;
delete process.env.HEX_ANALYSIS_ROUTE;

const workers = [];
class ImmediateWorker {
  constructor(url) { this.url=String(url); this.onmessage=null; this.onerror=null; this.sent=[]; workers.push(this); }
  postMessage(message) {
    this.sent.push(message);
    if (message.t === 'analyze') queueMicrotask(() => this.onmessage?.({ data:{
      t:'ok', id:message.id, epoch:message.epoch,
      result:{ values:new BigUint64Array([1n,2n]), kinds:new Uint8Array([3,4]), big:0x1_0000_0000_0000_0001n },
    }}));
  }
  terminate() {}
}
globalThis.Worker = ImmediateWorker;

const { Backend, BACKEND_DEFAULT_ANALYSIS_ROUTE } = await import('../../../js/backend.js');
const { ANALYSIS_ORCHESTRATION_ROUTE } = await import('../../../js/cache/artifact-orchestration.js');
assert.equal(BACKEND_DEFAULT_ANALYSIS_ROUTE, ANALYSIS_ORCHESTRATION_ROUTE.ARTIFACT, 'production default must be artifact after Phase 4 cutover');

const bytes = Uint8Array.from({ length:4097 }, (_, i) => (i * 37 + 11) & 0xff);
const file = new Blob([bytes]);
const expectedBinaryId = createBinaryIdFromDigest(createHash('sha256').update(bytes).digest('hex'));
let request = null;
const artifactOrchestrator = {
  stats:() => ({ fixture:true }),
  async request(options) {
    request = options;
    const payload = await options.produce({ signal:options.signal ?? null });
    return { payload, reused:false, source:'fixture' };
  },
  close:async () => {},
  store:{ delete:async () => {} },
};
const backend = new Backend({ artifactOrchestrator });
backend.file = file;
backend.formatId = 'pe';
backend.platformInfo = { capability:{ architecture:'x86_64' }, slices:[{ capability:{ architecture:'x86_64' } }] };

assert.equal(backend.analysisRouteInfo().route, 'artifact', 'ambient production route must be artifact without override');
assert.equal(backend.analysisRouteInfo().defaultCutover, true, 'production default cutover must be active');
const result = await backend.analyze(0);
assert.equal(request.descriptor.binaryId, expectedBinaryId, 'ambient artifact route must bind canonical content SHA-256 BinaryId');
assert.equal(request.completeness, 'complete');
assert.equal(backend.binaryId, expectedBinaryId);
assert.ok(result.values instanceof BigUint64Array);
assert.ok(result.kinds instanceof Uint8Array);
assert.equal(typeof result.big, 'bigint');
assert.equal(workers.filter((worker) => /platform\/worker\.js/.test(worker.url))[0].sent.filter((message) => message.t === 'analyze').length, 1, 'artifact route must invoke existing producer exactly once');

await assert.rejects(
  backend.analyze(0, { route:'artifact', binaryId:expectedBinaryId }),
  /analysis-artifact-completeness-required/,
  'explicit artifact route keeps its strict completeness contract',
);
backend.dispose();

if (previousRoute == null) delete process.env.HEX_ANALYSIS_ROUTE;
else process.env.HEX_ANALYSIS_ROUTE = previousRoute;

console.log('PHASE4_PUBLIC_ARTIFACT_CUTOVER ' + JSON.stringify({
  productionDefault:'artifact',
  defaultCutover:true,
  binaryId:expectedBinaryId,
  completeness:'complete',
  producerInvocations:1,
  typedArrayPreserved:true,
  bigintPreserved:true,
  explicitCurrentOracleRetained:true,
}));
console.log('phase4 public artifact route cutover: PASS');
