import { createArtifactDescriptor, createArtifactStore } from '../core/artifacts/index.js';
import { AnalysisScheduler } from '../core/scheduler/index.js';
import { BudgetExceededError } from '../core/budgets/index.js';

export const ANALYSIS_ORCHESTRATION_ROUTE = Object.freeze({
  CURRENT: 'current',
  ARTIFACT: 'artifact',
});

export const WORKER_CACHE_MIGRATION_VERSION = 'hex-worker-cache-migration-v1';
export const CURRENT_WORKER_ANALYSIS_PRODUCER_ID = 'hex-current-worker-analysis';

function required(value, code) {
  const text = String(value ?? '').trim();
  if (!text) throw new TypeError(code);
  return text;
}

function abortError(signal) {
  return signal?.reason || new DOMException('Aborted', 'AbortError');
}

export function normalizeAnalysisRoute(route) {
  const value = String(route ?? '').trim();
  if (value === ANALYSIS_ORCHESTRATION_ROUTE.CURRENT || value === ANALYSIS_ORCHESTRATION_ROUTE.ARTIFACT) return value;
  throw new TypeError(`analysis-orchestration-route-invalid:${value || '<empty>'}`);
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
 * All semantic/version dimensions are required from the caller so no weak
 * legacy cache identity can become an ambient default.
 */
export function createWorkerAnalysisArtifactDescriptor(input = {}) {
  return createArtifactDescriptor({
    binaryId:required(input.binaryId, 'analysis-artifact-binary-id-required'),
    sliceId:input.sliceId == null ? null : String(input.sliceId),
    entityId:input.entityId == null ? null : String(input.entityId),
    artifactKind:required(input.artifactKind ?? 'worker-analysis-result', 'analysis-artifact-kind-required'),
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
    if (storeOptions.allowMemoryFallback === true && !store) {
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
      validate,
      creation:{
        migrationContract:WORKER_CACHE_MIGRATION_VERSION,
        sourceRoute:ANALYSIS_ORCHESTRATION_ROUTE.CURRENT,
        ...(creation || {}),
      },
      produce:async (context) => {
        this.metrics.producerInvocations++;
        return produce(context);
      },
    });

    return request.then((result) => {
      if (result.reused) this.metrics.warmReuses++;
      else this.metrics.coldPublishes++;
      return result;
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
      ...this.metrics,
      scheduler:this.scheduler.stats(),
      store:this.store.stats(),
    });
  }

  async close() {
    await this.store.close();
  }
}
