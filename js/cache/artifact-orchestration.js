import { createArtifactDescriptor, createArtifactStore } from '../core/artifacts/index.js';
import { createEntityId, createSliceId } from '../core/identity/index.js';
import { AnalysisScheduler } from '../core/scheduler/index.js';
import { BudgetExceededError } from '../core/budgets/index.js';

export const ANALYSIS_ORCHESTRATION_ROUTE = Object.freeze({
  CURRENT: 'current',
  ARTIFACT: 'artifact',
});

export const WORKER_CACHE_MIGRATION_VERSION = 'hex-worker-cache-migration-v1';
export const WORKER_ANALYSIS_PAYLOAD_CODEC_VERSION = 'hex-worker-analysis-payload-v1';
export const CURRENT_WORKER_ANALYSIS_PRODUCER_ID = 'hex-current-worker-analysis';

const CANONICAL_BINARY_ID = /^bin_sha256_[0-9a-f]{64}$/i;
const CANONICAL_SLICE_ID = /^slice_[0-9a-f]{32}$/i;
const CANONICAL_ENTITY_ID = /^entity_[0-9a-f]{32}$/i;
const TYPED_ARRAYS = new Map([
  ['Int8Array', globalThis.Int8Array],
  ['Uint8Array', globalThis.Uint8Array],
  ['Uint8ClampedArray', globalThis.Uint8ClampedArray],
  ['Int16Array', globalThis.Int16Array],
  ['Uint16Array', globalThis.Uint16Array],
  ['Int32Array', globalThis.Int32Array],
  ['Uint32Array', globalThis.Uint32Array],
  ['Float32Array', globalThis.Float32Array],
  ['Float64Array', globalThis.Float64Array],
  ['BigInt64Array', globalThis.BigInt64Array],
  ['BigUint64Array', globalThis.BigUint64Array],
].filter(([, ctor]) => typeof ctor === 'function'));

function required(value, code) {
  const text = String(value ?? '').trim();
  if (!text) throw new TypeError(code);
  return text;
}

function abortError(signal) {
  return signal?.reason ?? new DOMException('Aborted', 'AbortError');
}

export function requireCanonicalBinaryId(value) {
  const binaryId = required(value, 'analysis-artifact-canonical-binary-id-required');
  if (!CANONICAL_BINARY_ID.test(binaryId)) throw new TypeError('analysis-artifact-canonical-binary-id-invalid');
  return binaryId.toLowerCase();
}

export function normalizeAnalysisRoute(route) {
  const value = String(route ?? '').trim();
  if (value === ANALYSIS_ORCHESTRATION_ROUTE.CURRENT || value === ANALYSIS_ORCHESTRATION_ROUTE.ARTIFACT) return value;
  throw new TypeError(`analysis-orchestration-route-invalid:${value || '<empty>'}`);
}

/**
 * Lossless transport codec for existing worker results. ArtifactStore v1 uses
 * canonical JSON, while current workers legitimately return BigInt and typed
 * arrays. The codec preserves those public result types without changing the
 * semantic producer or inventing another artifact identity.
 */
export function encodeWorkerAnalysisPayload(value) {
  const seen = new WeakSet();
  const encode = (input) => {
    if (input === null) return { t:'null' };
    if (input === undefined) return { t:'undefined' };
    const type = typeof input;
    if (type === 'string') return { t:'string', v:input };
    if (type === 'boolean') return { t:'boolean', v:input };
    if (type === 'bigint') return { t:'bigint', v:input.toString() };
    if (type === 'number') {
      if (Number.isNaN(input)) return { t:'number', v:'nan' };
      if (input === Infinity) return { t:'number', v:'infinity' };
      if (input === -Infinity) return { t:'number', v:'-infinity' };
      if (Object.is(input, -0)) return { t:'number', v:'-0' };
      return { t:'number', v:input };
    }
    if (type !== 'object') throw new TypeError(`analysis-artifact-payload-type-unsupported:${type}`);
    if (seen.has(input)) throw new TypeError('analysis-artifact-payload-cyclic');
    seen.add(input);
    try {
      if (input instanceof Date) return { t:'date', v:input.toISOString() };
      if (input instanceof ArrayBuffer) return { t:'array-buffer', v:Array.from(new Uint8Array(input)) };
      if (input instanceof DataView) return { t:'data-view', v:Array.from(new Uint8Array(input.buffer, input.byteOffset, input.byteLength)) };
      if (ArrayBuffer.isView(input)) {
        const name = input.constructor?.name;
        if (!TYPED_ARRAYS.has(name)) throw new TypeError(`analysis-artifact-typed-array-unsupported:${String(name)}`);
        const bigint = name === 'BigInt64Array' || name === 'BigUint64Array';
        return { t:'typed-array', c:name, v:Array.from(input, (entry) => bigint ? entry.toString() : entry) };
      }
      if (input instanceof Map) {
        return { t:'map', v:[...input.entries()].map(([key, entry]) => [encode(key), encode(entry)]) };
      }
      if (input instanceof Set) return { t:'set', v:[...input.values()].map(encode) };
      if (Array.isArray(input)) return { t:'array', v:input.map(encode) };
      const proto = Object.getPrototypeOf(input);
      if (proto !== Object.prototype && proto !== null) throw new TypeError(`analysis-artifact-object-prototype-unsupported:${input.constructor?.name || 'unknown'}`);
      return {
        t:'object',
        n:proto === null,
        v:Object.keys(input).sort().map((key) => [key, encode(input[key])]),
      };
    } finally {
      seen.delete(input);
    }
  };
  return { codec:WORKER_ANALYSIS_PAYLOAD_CODEC_VERSION, root:encode(value) };
}

export function decodeWorkerAnalysisPayload(payload) {
  if (!payload || payload.codec !== WORKER_ANALYSIS_PAYLOAD_CODEC_VERSION || !payload.root) {
    throw new TypeError('analysis-artifact-payload-codec-mismatch');
  }
  const decode = (node) => {
    if (!node || typeof node !== 'object') throw new TypeError('analysis-artifact-payload-node-invalid');
    switch (node.t) {
      case 'null': return null;
      case 'undefined': return undefined;
      case 'string': return String(node.v);
      case 'boolean': return !!node.v;
      case 'bigint': return BigInt(node.v);
      case 'number':
        if (node.v === 'nan') return NaN;
        if (node.v === 'infinity') return Infinity;
        if (node.v === '-infinity') return -Infinity;
        if (node.v === '-0') return -0;
        return Number(node.v);
      case 'date': return new Date(node.v);
      case 'array-buffer': return Uint8Array.from(node.v || []).buffer;
      case 'data-view': {
        const bytes = Uint8Array.from(node.v || []);
        return new DataView(bytes.buffer);
      }
      case 'typed-array': {
        const ctor = TYPED_ARRAYS.get(String(node.c));
        if (!ctor) throw new TypeError(`analysis-artifact-typed-array-unsupported:${String(node.c)}`);
        const bigint = node.c === 'BigInt64Array' || node.c === 'BigUint64Array';
        return new ctor((node.v || []).map((entry) => bigint ? BigInt(entry) : Number(entry)));
      }
      case 'map': return new Map((node.v || []).map(([key, entry]) => [decode(key), decode(entry)]));
      case 'set': return new Set((node.v || []).map(decode));
      case 'array': return (node.v || []).map(decode);
      case 'object': {
        const out = node.n ? Object.create(null) : {};
        for (const [key, entry] of node.v || []) Object.defineProperty(out, key, { value:decode(entry), enumerable:true, configurable:true, writable:true });
        return out;
      }
      default: throw new TypeError(`analysis-artifact-payload-node-unsupported:${String(node.t)}`);
    }
  };
  return decode(payload.root);
}

/**
 * Bind the scheduler's cancellation signal to the existing worker request.
 * The worker remains the only semantic producer; cancellation only controls
 * whether its result is accepted/published.
 */
export function awaitCancellableProducer(operation, signal) {
  const promise = Promise.resolve(operation);
  if (!signal) return promise;

  let cancelled = false;
  const cancelProducer = () => {
    if (cancelled) return;
    cancelled = true;
    try { operation?.cancel?.(); } catch { /* cancellation reason remains authoritative */ }
  };

  if (signal.aborted) {
    cancelProducer();
    return Promise.reject(abortError(signal));
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      fn(value);
    };
    const onAbort = () => {
      cancelProducer();
      finish(reject, abortError(signal));
    };
    signal.addEventListener('abort', onAbort, { once:true });
    promise.then((value) => finish(resolve, value), (error) => finish(reject, error));
  });
}

/**
 * Build the migration descriptor through the canonical P4 ArtifactId contract.
 * The legacy FNV/cache key is intentionally not accepted as BinaryId. Slice and
 * entity identities are generated through the frozen P4 identity API unless an
 * already-canonical identity is supplied.
 */
export function createWorkerAnalysisArtifactDescriptor(input = {}) {
  const binaryId = requireCanonicalBinaryId(input.binaryId);
  const artifactKind = required(input.artifactKind ?? 'worker-analysis-result', 'analysis-artifact-kind-required');
  const architecture = required(input.architecture ?? 'unknown', 'analysis-artifact-architecture-required');
  const sliceId = input.sliceId == null
    ? createSliceId({ binaryId, index:input.sliceIndex ?? 0, architecture })
    : required(input.sliceId, 'analysis-artifact-slice-id-required');
  if (!CANONICAL_SLICE_ID.test(sliceId)) throw new TypeError('analysis-artifact-slice-id-not-canonical');
  const entityId = input.entityId == null
    ? createEntityId({ binaryId, sliceId, kind:'worker-analysis', identity:{ artifactKind, sliceIndex:input.sliceIndex ?? 0 } })
    : required(input.entityId, 'analysis-artifact-entity-id-required');
  if (!CANONICAL_ENTITY_ID.test(entityId)) throw new TypeError('analysis-artifact-entity-id-not-canonical');

  return createArtifactDescriptor({
    binaryId,
    sliceId,
    entityId,
    artifactKind,
    producerId:required(input.producerId ?? CURRENT_WORKER_ANALYSIS_PRODUCER_ID, 'analysis-artifact-producer-id-required'),
    producerVersion:required(input.producerVersion, 'analysis-artifact-producer-version-required'),
    versions:{
      loader:required(input.loaderVersion, 'analysis-artifact-loader-version-required'),
      architectureSemantic:required(input.architectureSemanticVersion, 'analysis-artifact-architecture-version-required'),
      abiSemantic:required(input.abiSemanticVersion, 'analysis-artifact-abi-version-required'),
      semanticSchema:required(input.semanticSchemaVersion, 'analysis-artifact-schema-version-required'),
    },
    config:input.config ?? {},
    keyExtras:{
      migrationContract:WORKER_CACHE_MIGRATION_VERSION,
      payloadCodec:WORKER_ANALYSIS_PAYLOAD_CODEC_VERSION,
      ...(input.keyExtras ?? {}),
    },
    upstreamArtifactIds:input.upstreamArtifactIds ?? [],
    originRefs:input.originRefs ?? [],
  });
}

/**
 * P4 migration runtime. It uses the canonical ArtifactStore and the canonical
 * AnalysisScheduler only. If no store is injected, persistence is strict:
 * unavailable IndexedDB is an error, never a silent old-route fallback.
 */
export class ArtifactAnalysisOrchestrator {
  constructor({ store = null, scheduler = null, storeOptions = {}, schedulerOptions = {} } = {}) {
    if (storeOptions.allowMemoryFallback === true && !store && !scheduler?.store) {
      throw new TypeError('analysis-artifact-memory-fallback-requires-explicit-store');
    }
    const resolvedStore = store || scheduler?.store || createArtifactStore({ ...storeOptions, allowMemoryFallback:false });
    if (scheduler && scheduler.store !== resolvedStore) throw new TypeError('analysis-artifact-scheduler-store-mismatch');
    this.store = resolvedStore;
    this.scheduler = scheduler || new AnalysisScheduler({ store:resolvedStore, ...schedulerOptions });
    this.metrics = {
      requests:0,
      producerInvocations:0,
      coldPublishes:0,
      warmReuses:0,
      failures:0,
      cancellations:0,
      budgetExhaustions:0,
    };
  }

  request({ descriptor, produce, signal = null, budget = null, priority = 'current', completeness = 'complete', validate = null, creation = null } = {}) {
    if (!descriptor?.artifactId) return Promise.reject(new TypeError('analysis-artifact-descriptor-required'));
    if (typeof produce !== 'function') return Promise.reject(new TypeError('analysis-artifact-producer-required'));
    this.metrics.requests++;

    const request = this.scheduler.request({
      descriptor,
      signal,
      budget,
      priority,
      completeness,
      validate:typeof validate === 'function'
        ? (encodedPayload, record, context) => validate(decodeWorkerAnalysisPayload(encodedPayload), record, context)
        : null,
      creation:{
        migrationContract:WORKER_CACHE_MIGRATION_VERSION,
        payloadCodec:WORKER_ANALYSIS_PAYLOAD_CODEC_VERSION,
        sourceRoute:ANALYSIS_ORCHESTRATION_ROUTE.CURRENT,
        ...(creation || {}),
      },
      produce:async (context) => {
        this.metrics.producerInvocations++;
        return encodeWorkerAnalysisPayload(await produce(context));
      },
    });

    return request.then((result) => {
      if (result.reused) this.metrics.warmReuses++;
      else this.metrics.coldPublishes++;
      return { ...result, payload:decodeWorkerAnalysisPayload(result.payload) };
    }, (error) => {
      this.metrics.failures++;
      if (error?.name === 'AbortError') this.metrics.cancellations++;
      if (error instanceof BudgetExceededError || error?.code === 'budget-exhausted') this.metrics.budgetExhaustions++;
      throw error;
    });
  }

  stats() {
    return Object.freeze({
      migrationVersion:WORKER_CACHE_MIGRATION_VERSION,
      payloadCodecVersion:WORKER_ANALYSIS_PAYLOAD_CODEC_VERSION,
      ...this.metrics,
      scheduler:this.scheduler.stats(),
      store:this.store.stats(),
    });
  }

  async close() {
    await this.store.close();
  }
}
