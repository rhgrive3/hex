import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import {
  ArtifactStore,
  MemoryArtifactBackend,
  createArtifactDescriptor,
} from '../../../js/core/artifacts/index.js';
import {
  AnalysisScheduler,
  SchedulerCycleError,
} from '../../../js/core/scheduler/index.js';
import { BudgetExceededError } from '../../../js/core/budgets/index.js';
import {
  ProjectArtifactIndex,
  createArtifactRef,
  isArtifactRef,
} from '../../../js/project/artifact-index.js';
import {
  createHexProject,
  serializeHexProject,
} from '../../../js/project/index.js';
import { CachedByteSource, InstrumentedByteSource } from '../../../js/bytesource/cached.js';
import { ByteSource } from '../../../js/binary/source.js';

const SCALE = Object.freeze([10, 100, 1_000, 10_000]);
const REQUIRED_RAW_COUNTERS = Object.freeze([
  'determinismFailures',
  'underInvalidationFailures',
  'overInvalidationFailures',
  'corruptionAcceptanceFailures',
  'partialPublishFailures',
  'warmUnexpectedProducerInvocations',
  'coalescingFailures',
  'cancellationFailures',
  'wholeFileMaterializationFailures',
  'coldWarmMismatchCount',
  'ownershipViolations',
]);

function freshRawFailures() {
  const out = Object.create(null);
  for (const name of REQUIRED_RAW_COUNTERS) out[name] = 0;
  Object.assign(out, {
    dependencyInvalidationFailures: 0,
    cycleDetectionFailures: 0,
    priorityDeterminismFailures: 0,
    budgetFailures: 0,
    projectSeparationFailures: 0,
    hexprojPayloadProhibitionFailures: 0,
    pagingFailures: 0,
    scalingFailures: 0,
    producerInvocationFailures: 0,
  });
  return out;
}

function baseDescriptorInput(overrides = {}) {
  const versions = {
    loader: 'loader-v1',
    architectureSemantic: 'arch-v1',
    abiSemantic: 'abi-v1',
    semanticSchema: 'semantic-v1',
    ...(overrides.versions || {}),
  };
  return {
    binaryId: 'binary:p4-6-oracle',
    sliceId: 'slice:arm64',
    entityId: 'function:0x1000',
    artifactKind: 'semantic-ir',
    producerId: 'oracle-producer',
    producerVersion: '1',
    versions,
    config: { mode: 'strict', threshold: 7 },
    keyExtras: { feature: 'baseline' },
    upstreamArtifactIds: [],
    originRefs: ['origin:baseline'],
    ...overrides,
    versions,
  };
}

function descriptor(overrides = {}) {
  return createArtifactDescriptor(baseDescriptorInput(overrides));
}

function nowMs() {
  return globalThis.performance?.now?.() ?? Date.now();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(predicate, { timeoutMs = 1_000, intervalMs = 1 } = {}) {
  const start = nowMs();
  while (!predicate()) {
    if (nowMs() - start > timeoutMs) throw new Error('oracle-wait-timeout');
    await sleep(intervalMs);
  }
}

function abortError(message = 'oracle-aborted') {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function addCase(report, name, category, ownerLane, fn) {
  return Promise.resolve().then(fn).then(
    (detail) => {
      report.verificationCases.push({ name, category, ownerLane, status: 'pass', detail: detail ?? null });
      return true;
    },
    (error) => {
      report.verificationCases.push({
        name,
        category,
        ownerLane,
        status: 'fail',
        error: String(error?.message || error),
        code: error?.code || null,
      });
      return false;
    },
  );
}

function count(report, counter, amount = 1) {
  report.rawFailures[counter] = (report.rawFailures[counter] || 0) + amount;
}

async function oracleArtifactIdentity(report) {
  await addCase(report, 'ArtifactId determinism', 'A', 'p4-0', () => {
    const input = baseDescriptorInput({
      config: {
        object: { z: 3, a: 1, m: 2 },
        map: new Map([['z', 3], ['a', 1]]),
        set: new Set(['z', 'a', 'm']),
      },
    });
    const expected = createArtifactDescriptor(input).artifactId;
    for (let i = 0; i < 100; i++) {
      if (createArtifactDescriptor(input).artifactId !== expected) count(report, 'determinismFailures');
    }
    assert.equal(report.rawFailures.determinismFailures, 0);
    return { repetitions: 100, artifactId: expected };
  });

  await addCase(report, 'Map insertion independence', 'A', 'p4-0', () => {
    const a = descriptor({ config: { map: new Map([['a', 1], ['b', 2], ['c', 3]]) } });
    const b = descriptor({ config: { map: new Map([['c', 3], ['b', 2], ['a', 1]]) } });
    if (a.artifactId !== b.artifactId) count(report, 'determinismFailures');
    assert.equal(a.artifactId, b.artifactId);
    return { artifactId: a.artifactId };
  });

  await addCase(report, 'object insertion independence', 'A', 'p4-0', () => {
    const left = {};
    left.z = 3; left.a = 1; left.m = 2;
    const right = {};
    right.m = 2; right.z = 3; right.a = 1;
    const a = descriptor({ config: left });
    const b = descriptor({ config: right });
    if (a.artifactId !== b.artifactId) count(report, 'determinismFailures');
    assert.equal(a.artifactId, b.artifactId);
    return { artifactId: a.artifactId };
  });

  await addCase(report, 'under-invalidation', 'A', 'p4-0', () => {
    const baseline = descriptor();
    const mutations = [
      ['binaryId', { binaryId: 'binary:changed' }],
      ['sliceId', { sliceId: 'slice:changed' }],
      ['entityId', { entityId: 'function:changed' }],
      ['artifactKind', { artifactKind: 'memory-ssa' }],
      ['producerId', { producerId: 'producer:changed' }],
      ['producerVersion', { producerVersion: '2' }],
      ['loaderVersion', { versions: { loader: 'loader-v2' } }],
      ['architectureSemanticVersion', { versions: { architectureSemantic: 'arch-v2' } }],
      ['abiSemanticVersion', { versions: { abiSemantic: 'abi-v2' } }],
      ['semanticSchemaVersion', { versions: { semanticSchema: 'semantic-v2' } }],
      ['config', { config: { mode: 'strict', threshold: 8 } }],
      ['keyExtras', { keyExtras: { feature: 'changed' } }],
      ['upstreamArtifactIds', { upstreamArtifactIds: ['artifact_upstream_changed'] }],
    ];
    const collisions = [];
    for (const [name, mutation] of mutations) {
      const changed = descriptor(mutation);
      if (changed.artifactId === baseline.artifactId) {
        collisions.push(name);
        count(report, 'underInvalidationFailures');
      }
    }
    assert.deepEqual(collisions, [], `ArtifactKey failed to invalidate: ${collisions.join(', ')}`);
    return { dimensionsChecked: mutations.length, collisions };
  });

  await addCase(report, 'over-invalidation', 'A', 'p4-0', () => {
    const baseline = descriptor({ originRefs: ['origin:a', 'origin:b'] });
    const variants = [
      descriptor({ originRefs: ['origin:b', 'origin:a'] }),
      descriptor({ originRefs: ['origin:unrelated-provenance'] }),
      descriptor({
        config: { threshold: 7, mode: 'strict' },
        upstreamArtifactIds: [],
      }),
    ];
    const changed = variants.filter((value) => value.artifactId !== baseline.artifactId).length;
    count(report, 'overInvalidationFailures', changed);
    assert.equal(changed, 0, 'non-key/provenance ordering changed ArtifactId');
    return { variantsChecked: variants.length };
  });
}

async function oracleStore(report) {
  await addCase(report, 'content corruption', 'G', 'p4-1', async () => {
    const entries = new Map();
    const backend = new MemoryArtifactBackend({ entries });
    const store = new ArtifactStore({ backend });
    const d = descriptor({ entityId: 'corruption' });
    await store.publish(d, { value: 123 });
    store.evictHot(d.artifactId);
    const raw = entries.get(d.artifactId);
    const bytes = new Uint8Array(raw.payload);
    bytes[0] ^= 0xff;
    raw.payload = bytes.buffer;
    const got = await store.get(d);
    if (got.status === 'hit') count(report, 'corruptionAcceptanceFailures');
    assert.notEqual(got.status, 'hit');
    assert.equal(await backend.has(d.artifactId), false, 'corrupt artifact was not removed');
    return { result: got.status, reason: got.reason };
  });

  await addCase(report, 'atomic publishing', 'F', 'p4-1', async () => {
    const backend = new MemoryArtifactBackend();
    const store = new ArtifactStore({ backend });
    const d = descriptor({ entityId: 'atomic' });
    await store.publish(d, { revision: 1 });
    let conflict = false;
    try { await store.publish(d, { revision: 2 }); }
    catch { conflict = true; }
    store.evictHot(d.artifactId);
    const got = await store.get(d);
    const valid = conflict && got.status === 'hit' && got.payload?.revision === 1;
    if (!valid) count(report, 'partialPublishFailures');
    assert.equal(valid, true, 'immutable publish did not preserve the committed artifact');
    return { conflictRejected: conflict, committedRevision: got.payload?.revision ?? null };
  });

  await addCase(report, 'cancelled publication', 'F', 'p4-1', async () => {
    let committedResolve;
    const committed = new Promise((resolve) => { committedResolve = resolve; });
    class RacingBackend extends MemoryArtifactBackend {
      async putAtomic(record, payload, options = {}) {
        const result = await super.putAtomic(record, payload, options);
        committedResolve();
        await sleep(20);
        if (options.signal?.aborted) throw options.signal.reason || abortError();
        return result;
      }
    }
    const backend = new RacingBackend();
    const store = new ArtifactStore({ backend });
    const d = descriptor({ entityId: 'cancel-publish' });
    const controller = new AbortController();
    const publishing = store.publish(d, { value: 'must-not-survive' }, { signal: controller.signal });
    await committed;
    controller.abort(abortError('cancel-after-backend-commit'));
    let rejected = false;
    try { await publishing; } catch { rejected = true; }
    const survives = await backend.has(d.artifactId);
    if (!rejected || survives) count(report, 'partialPublishFailures');
    assert.equal(rejected, true);
    assert.equal(survives, false, 'cancelled publication remained visible');
    return { rejected, survives };
  });

  await addCase(report, 'dependency invalidation', 'C', 'p4-1', async () => {
    const backend = new MemoryArtifactBackend();
    const store = new ArtifactStore({ backend });
    const upstream = descriptor({ entityId: 'dep-upstream', artifactKind: 'decoded' });
    const parent = descriptor({ entityId: 'dep-parent', upstreamArtifactIds: [upstream.artifactId] });
    await store.publish(upstream, { value: 'upstream' });
    await store.publish(parent, { value: 'parent' });
    await backend.delete(upstream.artifactId);
    store.evictHot(parent.artifactId);
    const got = await store.get(parent);
    if (got.status === 'hit' || got.reason !== 'missing-upstream') count(report, 'dependencyInvalidationFailures');
    assert.equal(got.status, 'miss');
    assert.equal(got.reason, 'missing-upstream');
    return { status: got.status, reason: got.reason };
  });

  await addCase(report, 'warm reopen + producer invocation count + cold/warm equivalence', 'G', 'p4-1', async () => {
    const backend = new MemoryArtifactBackend({ reason: 'oracle-reopen-backend' });
    const d = descriptor({ entityId: 'warm-reopen' });
    let invocations = 0;
    const store1 = new ArtifactStore({ backend });
    const scheduler1 = new AnalysisScheduler({ store: store1, maxConcurrency: 1 });
    const cold = await scheduler1.request({ descriptor: d, produce: async () => { invocations++; return { value: [1, 2, 3], nested: { ok: true } }; } });
    store1.evictHot();
    const store2 = new ArtifactStore({ backend });
    const scheduler2 = new AnalysisScheduler({ store: store2, maxConcurrency: 1 });
    const warm = await scheduler2.request({ descriptor: d, produce: async () => { invocations++; return { value: ['unexpected'] }; } });
    if (invocations !== 1) count(report, 'warmUnexpectedProducerInvocations', Math.abs(invocations - 1));
    if (invocations !== 1) count(report, 'producerInvocationFailures');
    if (JSON.stringify(cold.payload) !== JSON.stringify(warm.payload)) count(report, 'coldWarmMismatchCount');
    assert.equal(invocations, 1);
    assert.deepEqual(warm.payload, cold.payload);
    return { producerInvocations: invocations, coldReused: cold.reused, warmReused: warm.reused, warmSource: warm.source };
  });
}

async function oracleScheduler(report) {
  await addCase(report, 'DAG cycles', 'D', 'p4-2', async () => {
    const store = new ArtifactStore({ backend: new MemoryArtifactBackend() });
    const scheduler = new AnalysisScheduler({ store, maxConcurrency: 1 });
    const a = Object.freeze({ artifactId: 'artifact_cycle_a', producerVersion: '1', versions: { semanticSchema: 's1' }, upstreamArtifactIds: ['artifact_cycle_b'] });
    const b = Object.freeze({ artifactId: 'artifact_cycle_b', producerVersion: '1', versions: { semanticSchema: 's1' }, upstreamArtifactIds: ['artifact_cycle_a'] });
    const requestA = { descriptor: a, dependencies: [], produce: async () => ({ a: 1 }) };
    const requestB = { descriptor: b, dependencies: [requestA], produce: async () => ({ b: 1 }) };
    requestA.dependencies = [requestB];
    let cycle = null;
    try { await scheduler.request(requestA); } catch (error) { cycle = error; }
    if (!(cycle instanceof SchedulerCycleError)) count(report, 'cycleDetectionFailures');
    assert.ok(cycle instanceof SchedulerCycleError, `expected SchedulerCycleError, got ${cycle?.name || 'none'}`);
    return { path: cycle.path };
  });

  await addCase(report, 'priority determinism', 'D', 'p4-2', async () => {
    const store = new ArtifactStore({ backend: new MemoryArtifactBackend() });
    const scheduler = new AnalysisScheduler({ store, maxConcurrency: 1, starvationInterval: 1_000_000_000 });
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let blockerStarted = false;
    const blocker = descriptor({ entityId: 'priority-blocker' });
    const blockerPromise = scheduler.request({
      descriptor: blocker,
      priority: 0,
      produce: async () => { blockerStarted = true; await gate; return { ok: true }; },
    });
    await waitUntil(() => blockerStarted);

    const specs = [
      ['p2-a', 2], ['p1-b', 1], ['p3-a', 3], ['p1-a', 1], ['p0-a', 0], ['p2-b', 2],
    ];
    const actual = [];
    const tasks = specs.map(([name, priority]) => {
      const d = descriptor({ entityId: `priority:${name}` });
      return {
        name, priority, descriptor: d,
        promise: scheduler.request({ descriptor: d, priority, produce: async () => { actual.push(name); return { name }; } }),
      };
    });
    await waitUntil(() => scheduler.stats().queued === tasks.length);
    release();
    await blockerPromise;
    await Promise.all(tasks.map((task) => task.promise));
    const expected = [...tasks].sort((a, b) => a.priority - b.priority || a.descriptor.artifactId.localeCompare(b.descriptor.artifactId)).map((task) => task.name);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) count(report, 'priorityDeterminismFailures');
    assert.deepEqual(actual, expected);
    return { expected, actual };
  });

  await addCase(report, 'cancellation propagation', 'E', 'p4-2', async () => {
    const store = new ArtifactStore({ backend: new MemoryArtifactBackend() });
    const scheduler = new AnalysisScheduler({ store, maxConcurrency: 1 });
    const child = descriptor({ entityId: 'cancel-child' });
    const parent = descriptor({ entityId: 'cancel-parent', upstreamArtifactIds: [child.artifactId] });
    let releaseChild;
    const childGate = new Promise((resolve) => { releaseChild = resolve; });
    let childSignal = null;
    let childStarted = false;
    const childRequest = {
      descriptor: child,
      produce: async ({ signal }) => { childSignal = signal; childStarted = true; await childGate; return { child: true }; },
    };
    const controller = new AbortController();
    const parentPromise = scheduler.request({
      descriptor: parent,
      signal: controller.signal,
      dependencies: [childRequest],
      produce: async () => ({ parent: true }),
    });
    await waitUntil(() => childStarted);
    controller.abort(abortError('parent-cancelled'));
    await sleep(10);
    const propagated = childSignal?.aborted === true;
    if (!propagated) count(report, 'cancellationFailures');
    releaseChild();
    try { await parentPromise; } catch { /* expected cancellation */ }
    assert.equal(propagated, true, 'parent cancellation did not abort the exclusively spawned dependency');
    return { propagated };
  });

  await addCase(report, 'budget behavior', 'E', 'p4-2', async () => {
    const backend = new MemoryArtifactBackend();
    const store = new ArtifactStore({ backend });
    const scheduler = new AnalysisScheduler({ store, maxConcurrency: 1 });
    const d = descriptor({ entityId: 'budget' });
    let error = null;
    try {
      await scheduler.request({
        descriptor: d,
        budget: { workUnits: 1 },
        produce: async ({ budget }) => { budget.consume('workUnits', 2); return { impossible: true }; },
      });
    } catch (caught) { error = caught; }
    const published = await backend.has(d.artifactId);
    if (!(error instanceof BudgetExceededError) || published) count(report, 'budgetFailures');
    assert.ok(error instanceof BudgetExceededError);
    assert.equal(published, false);
    return { error: error.code, published, budgetExhaustions: scheduler.stats().budgetExhaustions };
  });
}

async function oracleProject(report) {
  await addCase(report, 'user-fact separation', 'I', 'p4-3', () => {
    const valid = createArtifactRef({ scope: 'function:1', kind: 'ssa', artifactId: 'artifact_example' });
    const index = new ProjectArtifactIndex([valid]);
    const refs = index.toProjectReferences();
    const invalid = { ...valid, payload: { derived: true } };
    const separated = refs.length === 1 && !Object.hasOwn(refs[0], 'payload') && !Object.hasOwn(refs[0], 'record') && !isArtifactRef(invalid);
    if (!separated) count(report, 'projectSeparationFailures');
    assert.equal(separated, true);
    return { refs: refs.length, payloadBearingRefAccepted: isArtifactRef(invalid) };
  });

  await addCase(report, '.hexproj payload prohibition', 'I', 'p4-7', () => {
    const project = createHexProject({
      binaryHash: 'binary:p4-6',
      cacheReferences: [{
        version: 1,
        scope: 'function:1',
        kind: 'ssa',
        artifactId: 'artifact_payload_probe',
        payload: { derived: 'MUST-NOT-BE-IN-HEXPROJ' },
      }],
    });
    const serialized = serializeHexProject(project);
    const containsPayload = serialized.includes('MUST-NOT-BE-IN-HEXPROJ') || /"payload"\s*:/.test(serialized);
    if (containsPayload) count(report, 'hexprojPayloadProhibitionFailures');
    assert.equal(containsPayload, false, '.hexproj serialized a derived ArtifactStore payload');
    return { containsPayload };
  });
}

class SparseOracleSource extends ByteSource {
  constructor(size) {
    super(size, { maxReadLength: 1024 * 1024 });
  }

  async read(offset, length) {
    const range = this.validateRange(offset, length);
    const out = new Uint8Array(range.length);
    for (let i = 0; i < out.length; i++) out[i] = Number((range.offset + BigInt(i)) % 251n);
    return out;
  }
}

function expectedSparse(offset, length) {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = Number((BigInt(offset) + BigInt(i)) % 251n);
  return out;
}

async function oraclePaging(report) {
  await addCase(report, 'paged source behavior + large-file bounds', 'J', 'p4-4', async () => {
    const logicalSize = 1n << 30n;
    const sparse = new SparseOracleSource(logicalSize);
    const instrumented = new InstrumentedByteSource(sparse);
    const pageSize = 4 * 1024;
    const cached = new CachedByteSource(instrumented, { pageSize, maxCachedBytes: pageSize * 4 });
    const reads = [
      [0n, 31],
      [4090n, 40],
      [128n * 1024n * 1024n + 17n, 127],
      [logicalSize - 257n, 257],
    ];
    for (const [offset, length] of reads) {
      const actual = await cached.readExactly(offset, length);
      assert.deepEqual(actual, expectedSparse(offset, length));
    }
    const metrics = instrumented.metrics();
    const wholeFile = metrics.largestSingleRead >= Number(logicalSize) || BigInt(metrics.totalRequested) >= logicalSize;
    if (wholeFile) count(report, 'wholeFileMaterializationFailures');
    if (metrics.largestSingleRead > pageSize) count(report, 'pagingFailures');
    assert.equal(wholeFile, false);
    assert.ok(metrics.largestSingleRead <= pageSize, `backend read ${metrics.largestSingleRead} exceeded page size ${pageSize}`);
    return { logicalSize: logicalSize.toString(), pageSize, ...metrics, cache: cached.memoryStats() };
  });
}

async function coalescingScale(size) {
  const backend = new MemoryArtifactBackend();
  const store = new ArtifactStore({ backend });
  const scheduler = new AnalysisScheduler({ store, maxConcurrency: 2 });
  const d = descriptor({ entityId: `scale:coalesce:${size}` });
  let invocations = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let started = false;
  const requests = [];
  const start = nowMs();
  for (let i = 0; i < size; i++) {
    requests.push(scheduler.request({
      descriptor: d,
      produce: async () => { invocations++; started = true; await gate; return { size }; },
    }));
  }
  await waitUntil(() => started);
  release();
  await Promise.all(requests);
  const elapsedMs = nowMs() - start;
  return { size, elapsedMs, invocations, scheduler: scheduler.stats() };
}

async function oracleScaling(report) {
  await addCase(report, 'coalescing + complexity scaling', 'D', 'p4-2', async () => {
    const rows = [];
    for (const size of SCALE) {
      const startIdentity = nowMs();
      for (let i = 0; i < size; i++) descriptor({ entityId: `scale:id:${size}:${i}` });
      const identityMs = nowMs() - startIdentity;

      const index = new ProjectArtifactIndex();
      const startIndex = nowMs();
      for (let i = 0; i < size; i++) index.bind({ scope: `function:${i}`, kind: 'ssa', artifactId: `artifact_scale_${i}` });
      const listed = index.list();
      const projectIndexMs = nowMs() - startIndex;
      assert.equal(listed.length, size);

      const coalescing = await coalescingScale(size);
      if (coalescing.invocations !== 1 || coalescing.scheduler.coalescedRequests !== size - 1) count(report, 'coalescingFailures');
      const queueUpperBound = 4 + size * 2;
      if (coalescing.scheduler.queueOperations > queueUpperBound) count(report, 'scalingFailures');
      rows.push({
        size,
        identityMs,
        identityPerItemMs: identityMs / size,
        projectIndexMs,
        projectIndexPerItemMs: projectIndexMs / size,
        coalescingMs: coalescing.elapsedMs,
        coalescingPerItemMs: coalescing.elapsedMs / size,
        producerInvocations: coalescing.invocations,
        coalescedRequests: coalescing.scheduler.coalescedRequests,
        queueOperations: coalescing.scheduler.queueOperations,
      });
    }

    for (const field of ['identityPerItemMs', 'projectIndexPerItemMs', 'coalescingPerItemMs']) {
      const baseline = Math.max(rows.at(-2)[field], 0.000001);
      const latest = rows.at(-1)[field];
      if (latest > baseline * 20 && latest * rows.at(-1).size > 100) count(report, 'scalingFailures');
    }
    assert.equal(report.rawFailures.coalescingFailures, 0, 'coalescing did not collapse N consumers to one producer');
    assert.equal(report.rawFailures.scalingFailures, 0, 'scaling oracle detected superlinear/explosive growth');
    report.performance.scaling = rows;
    return { scales: SCALE, rows };
  });
}

export async function runVerificationOracles() {
  const report = {
    schemaVersion: 1,
    suite: 'hex-phase4-independent-verification',
    verificationCases: [],
    rawFailures: freshRawFailures(),
    performance: { scaling: [] },
  };
  await oracleArtifactIdentity(report);
  await oracleStore(report);
  await oracleScheduler(report);
  await oracleProject(report);
  await oraclePaging(report);
  await oracleScaling(report);
  return report;
}

function totalFailures(rawFailures) {
  return Object.values(rawFailures).reduce((sum, value) => sum + (Number(value) || 0), 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await runVerificationOracles();
  console.log('PHASE4_VERIFICATION_ORACLES ' + JSON.stringify(report));
  if (totalFailures(report.rawFailures) > 0) process.exitCode = 1;
}
