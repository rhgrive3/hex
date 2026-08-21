/* Format-neutral backend facade. Legacy ARM64/Mach-O worker remains a compatibility engine. */
import { LRU } from './lru.js';
import { augmentAnalysisResultWithChainedImports } from './chained.js';
import { markMachOSymbolTruthIncomplete, mergeMachOAnalysisResults } from './macho-analysis-merge.js';
import { AnalysisCache } from './cache/analysis-cache.js';
import { sha256BlobHex } from './cache/content-identity.js';
import { createBinaryIdFromDigest } from './core/identity/index.js';
import {
  ANALYSIS_ORCHESTRATION_ROUTE,
  ArtifactAnalysisOrchestrator,
  awaitCancellableProducer,
  createWorkerAnalysisArtifactDescriptor,
  normalizeAnalysisRoute,
} from './cache/artifact-orchestration.js';
import { X86_DECODER_SEMANTIC_VERSION } from './targets/architecture/x86_64/decoded-instruction.js';
import { X86_64_MACHINE_EFFECTS_SEMANTIC_VERSION } from './targets/architecture/x86_64/effects/common.js';
import {
  X86_SEMANTIC_FUNCTION_ANALYSIS_VERSION,
  X86_SEMANTIC_FUNCTION_MAX_DECODE_BYTES,
  X86_SEMANTIC_FUNCTION_SCHEMA_VERSION,
} from './targets/architecture/x86_64/semantic-function-contract.js';
import { RISCV64_DECODER_SEMANTIC_VERSION } from './targets/architecture/riscv64/decoded-instruction.js';
import { RISCV64_MACHINE_EFFECTS_SEMANTIC_VERSION } from './targets/architecture/riscv64/effects/common.js';
import { resolveRiscvIsaProfile } from './binary/riscv-isa.js';

/*
 * Per-architecture inputs to the shared semantic-function route.
 *
 * The route itself is architecture-neutral (js/analysis/semantic-function.js);
 * what differs is which decoder contract, which effects semantic version, and
 * which calling conventions are legal. `artifactKind` is pinned per
 * architecture rather than derived, so extending this table cannot silently
 * change an existing architecture's artifact identity and invalidate its
 * warm-reuse evidence.
 */
const SEMANTIC_FUNCTION_TARGETS = Object.freeze({
  x86_64: Object.freeze({
    artifactKind: 'phase5-x86-semantic-function',
    decoderContract: 'x86-64-decoded-instruction/v1',
    decoderSemanticVersion: X86_DECODER_SEMANTIC_VERSION,
    architectureSemanticVersion: X86_64_MACHINE_EFFECTS_SEMANTIC_VERSION,
    analysisVersion: X86_SEMANTIC_FUNCTION_ANALYSIS_VERSION,
    schemaVersion: X86_SEMANTIC_FUNCTION_SCHEMA_VERSION,
    abiIds: Object.freeze(['sysv-amd64', 'microsoft-x64']),
    defaultPlatform: (formatId) => (formatId === 'pe' ? 'windows' : 'linux'),
  }),
  riscv64: Object.freeze({
    artifactKind: 'phase6-riscv64-semantic-function',
    decoderContract: 'riscv64-decoded-instruction/v1',
    decoderSemanticVersion: RISCV64_DECODER_SEMANTIC_VERSION,
    architectureSemanticVersion: RISCV64_MACHINE_EFFECTS_SEMANTIC_VERSION,
    analysisVersion: RISCV64_MACHINE_EFFECTS_SEMANTIC_VERSION,
    schemaVersion: X86_SEMANTIC_FUNCTION_SCHEMA_VERSION,
    abiIds: Object.freeze(['lp64', 'lp64f', 'lp64d']),
    defaultPlatform: () => 'linux',
  }),
});

function semanticFunctionTarget(architecture) {
  const target = SEMANTIC_FUNCTION_TARGETS[String(architecture || 'x86_64')];
  if (!target) throw new TypeError(`semantic-function-unsupported-architecture:${architecture}`);
  return target;
}

export const CHUNK_ROWS = 1024;
export const CHUNK_BYTES = CHUNK_ROWS * 4;
const CHUNK_CACHE = 64;
const MAX_INFLIGHT = 6;

// Phase 4 production cutover: ArtifactStore/scheduler is the default analysis
// route. CURRENT remains available only through explicit route selection as the
// differential/compatibility oracle; there is no automatic fallback.
export const BACKEND_DEFAULT_ANALYSIS_ROUTE = ANALYSIS_ORCHESTRATION_ROUTE.ARTIFACT;
const DEFAULT_ARTIFACT_COMPLETENESS = 'complete';

function configuredAnalysisRoute() {
  // Test/CI-only rehearsal override. Browser production has no `process` and
  // therefore follows BACKEND_DEFAULT_ANALYSIS_ROUTE exactly.
  const rehearsal = typeof process !== 'undefined' ? process?.env?.HEX_ANALYSIS_ROUTE : null;
  return normalizeAnalysisRoute(rehearsal || BACKEND_DEFAULT_ANALYSIS_ROUTE);
}

const BACKEND_ANALYSIS_ARTIFACT_VERSIONS = Object.freeze({
  producer:'hex-current-backend-analysis-v1',
  loader:'hex-current-loader-orchestration-v1',
  architectureSemantic:'hex-current-semantic-oracle-v1',
  abiSemantic:'hex-current-abi-oracle-v1',
  semanticSchema:'hex-current-analysis-result-v1',
});

export class StaleRequestError extends Error {
  constructor() {
    super('The analysis request belongs to a file or slice that is no longer active.');
    this.name = 'StaleRequestError';
    this.stale = true;
  }
}

function cancelledRequestError(message = 'Analysis request cancelled.') {
  const error = new Error(message);
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  return error;
}

function workerFailureError(workerName, event, fallback = 'The analysis worker failed.') {
  const message = event?.message || event?.error?.message || fallback;
  const error = event?.error instanceof Error ? event.error : new Error(message);
  if (!error.code) error.code = 'WORKER_FAILED';
  error.workerName = workerName;
  return error;
}

function carryCancellation(mapped, source) {
  mapped.requestId = source?.requestId ?? null;
  mapped.cancel = () => source?.cancel?.();
  return mapped;
}

export class Backend {
  constructor(options = {}) {
    this.legacyWorker = new Worker(new URL('./worker.js', import.meta.url));
    this.platformWorker = new Worker(new URL('./platform/worker.js', import.meta.url), { type: 'module' });
    this.worker = this.legacyWorker;
    this.seq = 1;
    this.analysisEpoch = 0;
    this.transportEpoch = 0;
    this.pending = new Map();
    this.cache = new LRU(CHUNK_CACHE);
    this.inflight = new Map();
    this.queue = [];
    this.file = null;
    this.formatId = 'unknown';
    this.platformInfo = null;
    this.legacyInfo = null;
    this.arm64Bridge = false;
    this.onSearchProgress = null;
    this.onScanProgress = null;
    this.onAnalysisProgress = null;
    this.onChunk = null;
    this.onFatal = null;
    this._archProbe = null;
    this._archProbeWorker = null;
    this._archProbeFinish = null;
    this._disasmWorker = null;
    this._disasmSeq = 1;
    this._disasmPending = new Map();
    this.contentHash = null;
    this.binaryId = null;
    this._binaryIdPromise = null;
    this.disposed = false;
    this.analysisRoute = normalizeAnalysisRoute(options.analysisRoute ?? configuredAnalysisRoute());
    this._artifactOrchestrator = options.artifactOrchestrator ?? null;
    this._artifactStoreOptions = options.artifactStoreOptions ?? {};
    this._artifactSchedulerOptions = options.artifactSchedulerOptions ?? {};
    this.analysisCache = options.analysisCache || new AnalysisCache(options.analysisCacheOptions);

    this.legacyWorker.onmessage = (event) => this._onMessage(event.data, 'legacy');
    this.platformWorker.onmessage = (event) => this._onMessage(event.data, 'platform');
    const failed = (workerName, event) => {
      const error = workerFailureError(workerName, event, 'The analysis worker failed to start.');
      this._rejectWorkerPending(workerName, error);
      if (this.onFatal) this.onFatal(error.message);
    };
    this.legacyWorker.onerror = (event) => failed('legacy', event);
    this.platformWorker.onerror = (event) => failed('platform', event);
    this.legacyWorker.onmessageerror = (event) => failed('legacy', event);
    this.platformWorker.onmessageerror = (event) => failed('platform', event);

    if (typeof document !== 'undefined') {
      this._memoryPressureHandler = () => {
        if (!document.hidden) return;
        this.dropQueued();
        this.cleanupMemory().catch(() => {});
      };
      document.addEventListener('visibilitychange', this._memoryPressureHandler, { passive: true });
    }
  }

  get gen() { return this.analysisEpoch; }

  setAnalysisRoute(route) {
    this.analysisRoute = normalizeAnalysisRoute(route);
    return this.analysisRoute;
  }

  analysisRouteInfo() {
    return Object.freeze({
      route:this.analysisRoute,
      defaultCutover:BACKEND_DEFAULT_ANALYSIS_ROUTE === ANALYSIS_ORCHESTRATION_ROUTE.ARTIFACT,
      canonicalIdentityRequired:true,
      completenessRequired:true,
      artifactRuntimeCreated:!!this._artifactOrchestrator,
      artifactRuntime:this._artifactOrchestrator?.stats?.() ?? null,
    });
  }

  _artifactRuntime() {
    if (!this._artifactOrchestrator) {
      this._artifactOrchestrator = new ArtifactAnalysisOrchestrator({
        storeOptions:this._artifactStoreOptions,
        schedulerOptions:this._artifactSchedulerOptions,
      });
    }
    return this._artifactOrchestrator;
  }

  _rejectWorkerPending(workerName, error) {
    for (const [id, pending] of this.pending) {
      if (pending.workerName !== workerName) continue;
      this.pending.delete(id);
      pending.reject(error);
    }
  }

  _onMessage(message, workerName) {
    if (!message) return;
    if (message.t === 'searchProgress' || message.t === 'scanProgress' || message.t === 'analysisProgress') {
      const pending = this.pending.get(message.requestId);
      if (!pending || pending.uiEpoch !== this.gen) return;
      if (pending.onProgress) pending.onProgress(message);
      else if (message.t === 'searchProgress' && this.onSearchProgress) this.onSearchProgress(message);
      else if (message.t === 'scanProgress' && this.onScanProgress) this.onScanProgress(message);
      else if (message.t === 'analysisProgress' && this.onAnalysisProgress) this.onAnalysisProgress(message);
      return;
    }
    if (message.t === 'fatal') {
      const error = workerFailureError(workerName, { message: message.error }, 'The analysis worker failed.');
      this._rejectWorkerPending(workerName, error);
      if (this.onFatal) this.onFatal(error.message);
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending || pending.workerName !== workerName) return;
    this.pending.delete(message.id);
    if (pending.uiEpoch !== this.gen || message.epoch !== pending.transportEpoch) {
      pending.reject(new StaleRequestError());
      return;
    }
    if (message.t === 'ok') pending.resolve(message.result);
    else pending.reject(new Error(message.error || 'Analysis failed.'));
  }

  _worker(name) { return name === 'platform' ? this.platformWorker : this.legacyWorker; }

  _callTo(workerName, t, payload = {}, transfer, onProgress) {
    if (this.disposed) {
      const error = new Error('Backend has been disposed.'); error.code = 'BACKEND_DISPOSED';
      const promise = Promise.reject(error); promise.requestId = null; promise.cancel = () => {}; return promise;
    }
    const id = this.seq++;
    this.lastRequestId = id;
    const uiEpoch = this.gen;
    const transportEpoch = this.transportEpoch;
    const promise = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, uiEpoch, transportEpoch, workerName, onProgress });
      try {
        this._worker(workerName).postMessage({ t, id, requestId: id, epoch: transportEpoch, ...payload }, transfer || []);
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
    promise.requestId = id;
    promise.cancel = () => this.cancel(id);
    return promise;
  }

  _engineWorker(t) {
    if (this.formatId === 'unknown' || this.formatId === 'macho') return 'legacy';
    if (this.arm64Bridge && !['analyze', 'metadata', 'memoryStats', 'cleanupMemory'].includes(t)) return 'legacy';
    return 'platform';
  }

  call(t, payload, transfer, onProgress) { return this._callTo(this._engineWorker(t), t, payload, transfer, onProgress); }

  _releaseDisassembly(error) {
    if (this._disasmWorker) { this._disasmWorker.terminate(); this._disasmWorker = null; }
    const failure = error || new Error('disassembly worker released');
    for (const pending of this._disasmPending.values()) pending.reject(failure);
    this._disasmPending.clear();
  }

  advanceEpoch() {
    if (this.disposed) return this.analysisEpoch;
    this.analysisEpoch++;
    this.resetCache();
    this._releaseDisassembly(new StaleRequestError());
    for (const worker of [this.legacyWorker, this.platformWorker]) worker.postMessage({ t: 'cancel', epoch: this.transportEpoch });
    for (const [id, pending] of this.pending) {
      if (pending.uiEpoch === this.gen) continue;
      this.pending.delete(id);
      pending.reject(new StaleRequestError());
    }
    return this.analysisEpoch;
  }

  async open(file) {
    if (this.disposed) {
      const error = new Error('Backend has been disposed.'); error.code = 'BACKEND_DISPOSED';
      throw error;
    }
    const previousTransportEpoch = this.transportEpoch;
    const openTransportEpoch = ++this.transportEpoch;
    for (const worker of [this.legacyWorker, this.platformWorker]) worker.postMessage({ t: 'cancel', epoch: previousTransportEpoch });
    const assertCurrent = () => {
      if (this.transportEpoch !== openTransportEpoch) throw new StaleRequestError();
    };
    const step = async (promise) => {
      try {
        const value = await promise;
        assertCurrent();
        return value;
      } catch (error) {
        assertCurrent();
        throw error;
      }
    };

    let detection = null;
    let platformError = null;
    try { detection = await step(this._callTo('platform', 'detect', { file })); }
    catch (error) { if (error?.stale) throw error; platformError = error; }
    assertCurrent();

    let nextFormat = 'unknown';
    let nextPlatform = null;
    let nextLegacy = null;
    let nextBridge = false;
    let result = null;
    if (detection?.formatId === 'macho') {
      nextFormat = 'macho';
      const legacy = await step(this._callTo('legacy', 'open', { file }));
      let normalized = null;
      try { normalized = await step(this._callTo('platform', 'open', { file }, null, (p) => this.onAnalysisProgress?.(p))); }
      catch (error) { if (error?.stale) throw error; platformError = error; }
      assertCurrent();
      legacy.formatId = 'macho';
      for (const slice of legacy.slices || []) slice.capability = legacySliceCapability(slice);
      legacy.capability = legacy.slices?.[0]?.capability || legacySliceCapability(null);
      legacy.platform = {
        compatibility:'hybrid-macho', sourceBackedDetection:true, detected:detection,
        normalizedDyldTruth:!!normalized, duplicateUniversalParseAvoided:false,
        ...(platformError ? { normalizedDyldError: platformError.message } : {}),
      };
      nextLegacy = legacy;
      nextPlatform = normalized
        ? { ...normalized, normalizedDyldTruth:true, compatibility:'hybrid-macho' }
        : { formatId:'macho', capability:legacy.capability, detection, normalizedDyldTruth:false, compatibility:'legacy-macho' };
      result = legacy;
    } else {
      let platformInfo = null;
      try { platformInfo = await step(this._callTo('platform', 'open', { file }, null, (p) => this.onAnalysisProgress?.(p))); }
      catch (error) { if (error?.stale) throw error; platformError = error; }
      assertCurrent();
      if (platformInfo) {
        nextPlatform = platformInfo;
        nextFormat = platformInfo.formatId || platformInfo.capability?.format || detection?.formatId || 'unknown';
        const capability = platformInfo.capability || platformInfo.slices?.[0]?.capability;
        nextBridge = capability?.architecture === 'arm64';
        if (nextBridge) {
          try {
            await step(this._callTo('legacy', 'open', { file }));
            const allRegions=[...(platformInfo.slices||[]).flatMap((slice)=>slice.regions||[]),platformInfo.raw].filter(Boolean);
            await step(this._callTo('legacy','setRegions',{regions:allRegions}));
          } catch (error) {
            if (error?.stale) throw error;
            nextBridge=false;
          }
        }
        result=platformInfo;
      } else {
        const legacy=await step(this._callTo('legacy','open',{file}));
        nextLegacy=legacy;
        if (platformError && legacy.format === 'Raw binary') legacy.warnings=[...(legacy.warnings||[]),platformError.message];
        result=legacy;
      }
    }
    assertCurrent();
    this.advanceEpoch();
    this.file=file;
    this.formatId=nextFormat;
    this.platformInfo=nextPlatform;
    this.legacyInfo=nextLegacy;
    this.arm64Bridge=nextBridge;
    this.contentHash=null;
    this.binaryId=null;
    this._binaryIdPromise=null;
    return result;
  }

  probe() {
    if (this.formatId === 'macho' || this.arm64Bridge) return this._callTo('legacy', 'probe', {});
    return this._callTo('platform', 'probe', {});
  }

  probeArchitectures() {
    if (this.disposed) return Promise.resolve({ ok:false, error:'Backend has been disposed.', support:{ arm64:false, x86_64:false } });
    if (this._archProbe) return this._archProbe;
    this._archProbe = new Promise((resolve) => {
      const worker = new Worker(new URL('./platform/capstone-probe-worker.js', import.meta.url));
      this._archProbeWorker = worker;
      let finished = false;
      const finish = (value) => {
        if (finished) return;
        finished = true;
        if (this._archProbeWorker === worker) this._archProbeWorker = null;
        try { worker.terminate(); } catch { /* best effort */ }
        resolve(value);
      };
      this._archProbeFinish = finish;
      worker.onmessage = (event) => finish(event.data);
      const fail = (event) => finish({ ok: false, error: event?.message || 'architecture probe worker failed', support: { arm64: false, x86_64: false } });
      worker.onerror = fail;
      worker.onmessageerror = fail;
      try { worker.postMessage({ t: 'probe' }); }
      catch (error) { finish({ ok:false, error:error.message, support:{ arm64:false, x86_64:false } }); }
    }).finally(() => { this._archProbe = null; this._archProbeFinish = null; });
    return this._archProbe;
  }

  registerRegions(regions) {
    const jobs = [this._callTo('platform', 'setRegions', { regions })];
    if (this.formatId === 'macho' || this.arm64Bridge) jobs.push(this._callTo('legacy', 'setRegions', { regions }));
    return Promise.all(jobs).then(() => ({ ok: true }));
  }

  search(params, onProgress) { return this.call('search', params, null, onProgress); }

  cancel(request) {
    const requestId = typeof request === 'number' ? request : request?.requestId ?? this.lastRequestId;
    if (requestId == null) return false;
    const pending = this.pending.get(requestId);
    if (!pending) return false;
    this.pending.delete(requestId);
    try { this._worker(pending.workerName).postMessage({ t: 'cancel', requestId, epoch: pending.transportEpoch }); } catch { /* local settlement is authoritative */ }
    pending.reject(cancelledRequestError());
    return true;
  }

  cancelSearch(request) { this.cancel(request); }

  analyze(sliceIndex, options = {}) {
    const explicitRoute = Object.hasOwn(options, 'route');
    const route = normalizeAnalysisRoute(options.route ?? this.analysisRoute);
    if (route === ANALYSIS_ORCHESTRATION_ROUTE.CURRENT) return this._analyzeCurrent(sliceIndex, options);
    if (explicitRoute) return this._analyzeArtifact(sliceIndex, options);
    return this._analyzeArtifactPublic(sliceIndex, options);
  }

  _analyzeCurrent(sliceIndex, options = {}) {
    if (this.formatId !== 'macho') {
      return awaitCancellableProducer(this._callTo('platform', 'analyze', { sliceIndex }), options.signal);
    }
    return this._analyzeCurrentMachO(sliceIndex, options);
  }

  async _analyzeCurrentMachO(sliceIndex, options = {}) {
    const uiEpoch = this.gen, transportEpoch = this.transportEpoch, file = this.file;
    const assertCurrent = () => {
      if (uiEpoch !== this.gen || transportEpoch !== this.transportEpoch || file !== this.file) throw new StaleRequestError();
    };
    const call = (workerName, t, payload) => awaitCancellableProducer(this._callTo(workerName, t, payload), options.signal);
    const legacy = await call('legacy', 'analyze', { sliceIndex });
    assertCurrent();
    const enriched = await augmentAnalysisResultWithChainedImports(file, sliceIndex, legacy);
    assertCurrent();
    if (options.signal?.aborted) throw options.signal.reason || new DOMException('Aborted', 'AbortError');
    if (!this.platformInfo?.normalizedDyldTruth) {
      return markMachOSymbolTruthIncomplete(enriched, this.legacyInfo?.platform?.normalizedDyldError || 'normalized-macho-analysis-unavailable');
    }
    try {
      const normalized = await call('platform', 'analyze', { sliceIndex });
      assertCurrent();
      return mergeMachOAnalysisResults(enriched, normalized);
    } catch (error) {
      if (error?.name === 'AbortError' || options.signal?.aborted) throw options.signal?.reason || error;
      if (error?.stale) throw error;
      assertCurrent();
      return markMachOSymbolTruthIncomplete(enriched, error?.message || 'normalized-macho-analysis-failed');
    }
  }

  _analysisArtifactDescriptor(sliceIndex, options = {}) {
    const capability = this.formatId === 'macho'
      ? (this.legacyInfo?.slices?.[sliceIndex]?.capability || this.platformInfo?.slices?.[sliceIndex]?.capability || this.platformInfo?.capability)
      : (this.platformInfo?.slices?.[sliceIndex]?.capability || this.platformInfo?.capability);
    const architecture = capability?.architecture || 'unknown';
    return createWorkerAnalysisArtifactDescriptor({
      binaryId:options.binaryId,
      sliceIndex:Number(sliceIndex),
      architecture,
      artifactKind:'backend-analysis-result',
      producerVersion:options.producerVersion ?? BACKEND_ANALYSIS_ARTIFACT_VERSIONS.producer,
      loaderVersion:options.loaderVersion ?? BACKEND_ANALYSIS_ARTIFACT_VERSIONS.loader,
      architectureSemanticVersion:options.architectureSemanticVersion ?? BACKEND_ANALYSIS_ARTIFACT_VERSIONS.architectureSemantic,
      abiSemanticVersion:options.abiSemanticVersion ?? BACKEND_ANALYSIS_ARTIFACT_VERSIONS.abiSemantic,
      semanticSchemaVersion:options.semanticSchemaVersion ?? BACKEND_ANALYSIS_ARTIFACT_VERSIONS.semanticSchema,
      config:{ sliceIndex:Number(sliceIndex), formatId:this.formatId, architecture, ...(options.config || {}) },
      originRefs:[`binary:${String(options.binaryId || '')}`],
    });
  }

  _semanticFunctionArtifactDescriptor(options = {}) {
    const abiId = String(options.abiId || '');
    if (!abiId) throw new TypeError('semantic-function-abi-id-required');
    const architecture = String(options.architecture || 'x86_64');
    const target = semanticFunctionTarget(architecture);
    return createWorkerAnalysisArtifactDescriptor({
      binaryId:options.binaryId,
      sliceIndex:Number(options.sliceIndex ?? 0),
      architecture,
      artifactKind:target.artifactKind,
      producerVersion:target.analysisVersion,
      loaderVersion:BACKEND_ANALYSIS_ARTIFACT_VERSIONS.loader,
      architectureSemanticVersion:target.architectureSemanticVersion,
      abiSemanticVersion:`${abiId}@${String(options.abiSemanticVersion || '1')}`,
      semanticSchemaVersion:target.schemaVersion,
      config:{
        address:BigInt(options.address).toString(),
        length:Number(options.length),
        architecture,
        abiId,
        platform:String(options.platform || 'unknown'),
        decoderSemanticVersion:target.decoderSemanticVersion,
        analysisVersion:target.analysisVersion,
        functionPrototype:options.functionPrototype ?? null,
        dataEndianness:String(options.dataEndianness || 'unknown'),
        instructionEndianness:String(options.instructionEndianness || 'unknown'),
        ...(options.riscvIsa == null ? {} : { riscvIsa:options.riscvIsa }),
      },
      keyExtras:{
        decoderContract:target.decoderContract,
        decoderSemanticVersion:target.decoderSemanticVersion,
        semanticRoute:'machine-effects>semantic-ir-v2>cfg>ssa>memoryssa>compat>shared-decompiler',
      },
      upstreamArtifactIds:options.upstreamArtifactIds ?? [],
      originRefs:[`binary:${String(options.binaryId)}`, `virtual-address:${BigInt(options.address).toString()}`],
    });
  }

  /**
   * Production Backend/API orchestration for the shared semantic-function
   * route. It adds no legacy fallback and promotes no capability by itself: the
   * architecture must already be registered with an exact lifter and a
   * supported calling convention.
   */
  async analyzeSemanticFunction(options = {}) {
    const address = BigInt(options.address);
    const length = Number(options.length);
    if (!Number.isSafeInteger(length) || length < 1 || length > X86_SEMANTIC_FUNCTION_MAX_DECODE_BYTES) {
      throw new TypeError('semantic-function-bounded-length-required');
    }
    const architecture = String(options.architecture || 'x86_64');
    const target = semanticFunctionTarget(architecture);
    const abiId = String(options.abiId || '');
    if (!target.abiIds.includes(abiId)) throw new TypeError(`semantic-function-${architecture}-abi-required`);
    const sliceIndex = Number(options.sliceIndex ?? 0);
    const formatMetadata = this.platformInfo?.productDescriptor?.formatMetadata
      || this.platformInfo?.slices?.[sliceIndex]?.info?.descriptor?.formatMetadata
      || {};
    const dataEndianness = String(options.dataEndianness || formatMetadata.endian || this.platformInfo?.capability?.endianness || 'unknown');
    const instructionEndianness = String(options.instructionEndianness || (architecture === 'arm64' ? 'little' : dataEndianness));
    const riscvIsa = architecture === 'riscv64'
      ? (options.riscvIsa || resolveRiscvIsaProfile(formatMetadata.riscvIsa, address, { allowAssumed:true }))
      : null;
    const binaryId = options.binaryId ?? await this.ensureBinaryId({ signal:options.signal, onProgress:options.onIdentityProgress });
    const descriptor = this._semanticFunctionArtifactDescriptor({
      ...options, architecture, binaryId, address, length, abiId, dataEndianness, instructionEndianness, riscvIsa,
    });
    const uiEpoch = this.gen, transportEpoch = this.transportEpoch, file = this.file;
    const result = await this._artifactRuntime().request({
      descriptor,
      signal:options.signal ?? null,
      budget:options.budget ?? null,
      priority:options.priority ?? 'current',
      // Artifact completeness describes whether this bounded analysis request
      // finished, not whether every decoded instruction has exact semantics.
      completeness:options.completeness ?? 'complete',
      validate:(payload) => payload?.route === 'phase5-shadow-v2'
        && payload?.pipeline?.instrumentation?.v2Executed === true
        && payload?.abiId === abiId,
      creation:{ backend:'Backend', route:'phase5-shadow-v2', abiId, address:address.toString(), length },
      produce:async ({ signal }) => {
        const decoded = await this.disassembleAt(address, { architecture, length, signal, riscvIsa });
        if (!decoded?.supported || !decoded?.found || !decoded.instructions?.length) throw new Error(`semantic-function-${architecture}-decode-unavailable`);
        const decodedWithOrigins = decoded.instructions.map((instruction) => {
          const instructionAddress = BigInt(instruction.address);
          const instructionLength = Number(instruction.length ?? instruction.size);
          const relative = instructionAddress - address;
          const byteStart = decoded.fileOffset == null ? null : BigInt(decoded.fileOffset) + relative;
          return {
            ...instruction,
            origin:{
              byteRanges:byteStart == null ? [] : [{ binaryId, start:byteStart, length:instructionLength }],
              virtualRanges:[{ sliceId:descriptor.sliceId, start:instructionAddress, length:instructionLength }],
            },
          };
        });
        return await awaitCancellableProducer(this._callTo('platform', 'semanticFunction', {
          input:{
            binaryId,
            sliceId:descriptor.sliceId,
            architecture,
            platform:options.platform || target.defaultPlatform(this.formatId),
            abiId,
            decoderSemanticVersion:target.decoderSemanticVersion,
            analysisVersion:target.analysisVersion,
            instructions:decodedWithOrigins,
            name:options.name,
            functionPrototype:options.functionPrototype ?? null,
            dataEndianness,
            instructionEndianness,
            ...(riscvIsa == null ? {} : { architectureProfile:riscvIsa }),
            machineEffectsContext:{
              dataEndianness,
              instructionEndianness,
              ...(riscvIsa?.instructionAlignment == null ? {} : { instructionAlignment:Number(riscvIsa.instructionAlignment) }),
            },
          },
        }), signal);
      },
    });
    if (uiEpoch !== this.gen || transportEpoch !== this.transportEpoch || file !== this.file) {
      await this._artifactRuntime().store.delete(descriptor.artifactId).catch(() => {});
      throw new StaleRequestError();
    }
    return Object.freeze({ ...result.payload, artifactId:descriptor.artifactId, reused:result.reused === true });
  }

  async ensureBinaryId(options = {}) {
    if (this.binaryId) return this.binaryId;
    if (!this.file) throw new Error('binary-id-file-unavailable');
    const file = this.file;
    if (!this._binaryIdPromise) {
      this._binaryIdPromise = sha256BlobHex(file, {
        chunkBytes:options.chunkBytes,
        signal:options.signal ?? null,
        onProgress:options.onProgress,
      }).then((result) => {
        if (this.file !== file) throw new StaleRequestError();
        const binaryId = createBinaryIdFromDigest(result.hex);
        this.binaryId = binaryId;
        return binaryId;
      }).catch((error) => {
        this._binaryIdPromise = null;
        throw error;
      });
    }
    return this._binaryIdPromise;
  }

  async _analyzeArtifactPublic(sliceIndex, options = {}) {
    const binaryId = options.binaryId ?? await this.ensureBinaryId({ signal:options.signal, onProgress:options.onIdentityProgress });
    if (options.signal?.aborted) throw options.signal.reason || new DOMException('Aborted', 'AbortError');
    return this._analyzeArtifact(sliceIndex, {
      ...options,
      binaryId,
      completeness:Object.hasOwn(options, 'completeness') ? options.completeness : DEFAULT_ARTIFACT_COMPLETENESS,
    });
  }

  async _analyzeArtifact(sliceIndex, options = {}) {
    if (!Object.hasOwn(options, 'completeness')) throw new TypeError('analysis-artifact-completeness-required');
    const uiEpoch = this.gen, transportEpoch = this.transportEpoch, file = this.file;
    const descriptor = this._analysisArtifactDescriptor(sliceIndex, options);
    if (uiEpoch !== this.gen || transportEpoch !== this.transportEpoch || file !== this.file) throw new StaleRequestError();
    const result = await this._artifactRuntime().request({
      descriptor,
      signal:options.signal ?? null,
      budget:options.budget ?? null,
      priority:options.priority ?? 'current',
      completeness:options.completeness,
      validate:options.validate ?? null,
      creation:{ backend:'Backend', formatId:this.formatId, sliceIndex:Number(sliceIndex) },
      produce:({ signal }) => this._analyzeCurrent(sliceIndex, { ...options, route:ANALYSIS_ORCHESTRATION_ROUTE.CURRENT, signal }),
    });
    if (uiEpoch !== this.gen || transportEpoch !== this.transportEpoch || file !== this.file) {
      await this._artifactRuntime().store.delete(descriptor.artifactId).catch(() => {});
      throw new StaleRequestError();
    }
    return result.payload;
  }

  guessFunctions(regionId, limit, onProgress) { return this.call('guessFunctions', { regionId, limit }, null, onProgress); }
  scanProgram(regionId, onProgress, limits = {}) { return this.call('scanProgram', { regionId, ...limits }, null, onProgress); }
  fieldAccess(params, onProgress) { return this.call('fieldAccess', params, null, onProgress); }
  valueShapes(regionId, onProgress) { return this.call('valueShapes', { regionId }, null, onProgress); }
  fieldAccessMany(regionId, offsets) {
    const request = this.call('fieldAccess', { regionId, offsets });
    const mapped = request.then((res) => {
      const out = new Map();
      for (const key of Object.keys(res?.groups || {})) out.set(key, res.groups[key]);
      return out;
    });
    return carryCancellation(mapped, request);
  }
  strings(params, onProgress) { return this.call('strings', params, null, onProgress); }
  xrefs(params, onProgress) { return this.call('xrefs', params, null, onProgress); }
  readAt(addr, len, text) { return this.call('readAt', { addr, len, text }); }
  binaryMetadata(kind = 'summary', start = 0, limit = 500) {
    if (this.formatId !== 'macho') return this._callTo('platform', 'metadata', { kind, start, limit });
    const slice = this.legacyInfo?.slices?.[0] || null;
    const capability = slice?.capability || this.platformInfo?.capability || null;
    if (kind === 'summary') {
      return Promise.resolve({
        summary: { format: 'macho', arch: capability?.architecture || 'unknown', bits: capability?.bits || 0, endian: capability?.endianness || 'unknown', sections: slice?.regions?.length || 0 },
        metadata: { compatibility: 'legacy-macho', duplicateUniversalParseAvoided: true }, capability,
      });
    }
    return Promise.resolve({ kind, start, total: 0, items: [], next: null, compatibility: 'legacy-macho', unsupported: true });
  }

  async ensureContentHash(onProgress, signal = null) {
    if (this.contentHash) return this.contentHash;
    const result = await awaitCancellableProducer(this._callTo('platform', 'hash', {}, null, onProgress), signal);
    this.contentHash = result.hash;
    return this.contentHash;
  }

  async disassembleAt(addr, options = {}) {
    const uiEpoch = this.gen;
    const architecture = options.architecture || this.platformInfo?.capability?.architecture || 'arm64';
    const support = await this.probeArchitectures();
    if (uiEpoch !== this.gen) throw new StaleRequestError();
    if (!support?.support?.[architecture]) return { supported: false, architecture, instructions: [] };
    if (this.formatId === 'macho') return { supported: false, architecture, instructions: [], compatibility: 'legacy-viewer' };
    const read = await awaitCancellableProducer(this._callTo('platform', 'readAt', { addr, len: Math.min(1024 * 1024, options.length || 4096), text: false }), options.signal ?? null);
    if (uiEpoch !== this.gen) throw new StaleRequestError();
    if (!read?.found) return { supported: true, architecture, instructions: [], found: false };
    const formatMetadata = this.platformInfo?.productDescriptor?.formatMetadata || {};
    const riscvIsa = architecture === 'riscv64'
      ? (options.riscvIsa || resolveRiscvIsaProfile(formatMetadata.riscvIsa, addr, { allowAssumed:true }))
      : null;
    if (riscvIsa?.code === false) return { supported:true, architecture, found:true, instructions:[], region:read.region ?? null, fileOffset:read.fileOffset ?? null, riscvIsa };
    const result = await awaitCancellableProducer(this._disassembleBytes(read.bytes, addr, architecture, uiEpoch, { riscvIsa }), options.signal ?? null);
    if (uiEpoch !== this.gen) throw new StaleRequestError();
    return { supported: true, architecture, found: true, region:read.region ?? null, fileOffset:read.fileOffset ?? null, ...(riscvIsa == null ? {} : { riscvIsa }), ...result };
  }

  _disassembleBytes(bytes, address, architecture, uiEpoch = this.gen, decodeContext = {}) {
    if (!this._disasmWorker) {
      this._disasmWorker = new Worker(new URL('./platform/capstone-disasm-worker.js', import.meta.url));
      const worker = this._disasmWorker;
      worker.onmessage = (event) => {
        const pending = this._disasmPending.get(event.data?.id);
        if (!pending) return;
        this._disasmPending.delete(event.data.id);
        if (pending.uiEpoch !== this.gen) { pending.reject(new StaleRequestError()); return; }
        if (event.data.ok) pending.resolve(event.data); else pending.reject(new Error(event.data.error || 'disassembly failed'));
      };
      const fail = (event) => {
        if (this._disasmWorker !== worker) return;
        this._releaseDisassembly(workerFailureError('disassembly', event, 'disassembly worker failed'));
      };
      worker.onerror = fail;
      worker.onmessageerror = fail;
    }
    const id = this._disasmSeq++;
    const copy = bytes instanceof Uint8Array ? bytes.slice() : new Uint8Array(bytes);
    const promise = new Promise((resolve, reject) => {
      this._disasmPending.set(id, { resolve, reject, uiEpoch });
      try {
        this._disasmWorker.postMessage({ id, architecture, address, bytes: copy, riscvIsa:decodeContext.riscvIsa ?? null }, [copy.buffer]);
      } catch (error) {
        this._disasmPending.delete(id);
        reject(error);
      }
    });
    promise.cancel = () => {
      const pending = this._disasmPending.get(id);
      if (!pending) return;
      this._disasmPending.delete(id);
      pending.reject(cancelledRequestError('disassembly cancelled'));
    };
    return promise;
  }

  async loadAnalysisCache(options = {}) {
    const hash = await this.ensureContentHash(options.onProgress, options.signal);
    return this.analysisCache.get(hash, { artifactId:options.artifactId });
  }
  async saveAnalysisCache(data, options = {}) {
    const hash = await this.ensureContentHash(options.onProgress, options.signal);
    return this.analysisCache.put(hash, data, { artifactId:options.artifactId });
  }
  memoryStats() { return this._callTo('platform', 'memoryStats', {}); }
  cleanupMemory() {
    this.resetCache();
    this._releaseDisassembly(new Error('disassembly worker released for memory pressure'));
    return this._callTo('platform', 'cleanupMemory', {});
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    const failure = new Error('Backend has been disposed.'); failure.code = 'BACKEND_DISPOSED';
    this.analysisEpoch++; this.transportEpoch++;
    this.binaryId = null; this._binaryIdPromise = null;
    this.resetCache();
    this._releaseDisassembly(failure);
    this._archProbeFinish?.({ ok:false, error:failure.message, support:{ arm64:false, x86_64:false } });
    this._archProbeFinish = null; this._archProbeWorker = null;
    for (const pending of this.pending.values()) pending.reject(failure);
    this.pending.clear();
    for (const worker of [this.legacyWorker, this.platformWorker]) { try { worker.terminate(); } catch { /* best effort */ } }
    this._artifactOrchestrator?.close?.().catch?.(() => {});
    if (typeof document !== 'undefined' && this._memoryPressureHandler) {
      document.removeEventListener('visibilitychange', this._memoryPressureHandler);
      this._memoryPressureHandler = null;
    }
  }

  resetCache() {
    this.cache.clear();
    this.inflight.clear();
    this.queue.length = 0;
  }

  key(regionId, chunk) { return this.gen + ':' + regionId + '#' + chunk; }

  peek(regionId, chunk, wantAsm) {
    const entry = this.cache.get(this.key(regionId, chunk));
    if (!entry) return undefined;
    if (wantAsm && !entry.mn) return undefined;
    return entry;
  }

  fetchChunk(regionId, chunk, wantAsm) {
    const key = this.key(regionId, chunk);
    const cached = this.cache.get(key);
    if (cached && !cached.error && (!wantAsm || cached.mn)) return Promise.resolve(cached);
    const gen = this.gen;
    const request = this.call('chunk', { regionId, chunk, wantAsm });
    const mapped = request.then((res) => {
      const entry = normalizeChunk(res);
      if (gen === this.gen) this.cache.set(key, entry);
      return entry;
    });
    return carryCancellation(mapped, request);
  }

  request(regionId, chunk, wantAsm) {
    const key = this.key(regionId, chunk);
    const inflight = this.inflight.get(key);
    if (inflight) {
      if (wantAsm && !inflight.wantAsm) inflight.wantAsm = true;
      return;
    }
    const cached = this.cache.get(key);
    if (cached && (!wantAsm || cached.mn)) return;
    const job = { regionId, chunk, wantAsm: !!wantAsm, key, gen: this.gen, dispatchedWantAsm: null };
    this.inflight.set(key, job);
    const dispatched = this.inflight.size - this.queue.length;
    if (dispatched > MAX_INFLIGHT) this.queue.push(job);
    else this._dispatch(job);
  }

  _dispatch(job) {
    job.dispatchedWantAsm = !!job.wantAsm;
    this.call('chunk', { regionId: job.regionId, chunk: job.chunk, wantAsm: job.dispatchedWantAsm })
      .then((res) => {
        const entry = normalizeChunk(res);
        this.inflight.delete(job.key);
        if (job.gen !== this.gen) return;
        this.cache.set(job.key, entry);
        this.onChunk?.(job.regionId, job.chunk);

        if (job.wantAsm && !entry.mn) {
          const retry = { ...job, wantAsm: true, dispatchedWantAsm: null };
          this.inflight.set(job.key, retry);
          this.queue.unshift(retry);
        }
      })
      .catch((err) => {
        this.inflight.delete(job.key);
        if (job.gen !== this.gen || err?.stale) return;
        this.cache.set(job.key, { bytes: new Uint8Array(0), rows: 0, mn: null, ops: null, error: err.message });
        this.onChunk?.(job.regionId, job.chunk, err);
      })
      .then(() => {
        const next = this.queue.shift();
        if (next) this._dispatch(next);
      });
  }

  dropQueued() {
    for (const job of this.queue) this.inflight.delete(job.key);
    this.queue.length = 0;
  }
}

function normalizeChunk(res) {
  return { bytes: res.bytes, rows: res.rows, mn: res.mn ? res.mn.split('\n') : null, ops: res.ops ? res.ops.split('\n') : null };
}

function legacySliceCapability(slice) {
  const info = slice?.info || {};
  const architecture = info.architecture || (info.ilp32 ? 'arm64_32' : info.cpuSub === 'arm64e' ? 'arm64e' : info.isArm64 ? 'arm64' : String(info.cpu || 'unknown').toLowerCase());
  const aarch64 = architecture === 'arm64' || architecture === 'arm64e' || architecture === 'arm64_32';
  const partial = architecture === 'arm64e' || architecture === 'arm64_32';
  const limitations = architecture === 'arm64e' ? ['pointer-authentication'] : architecture === 'arm64_32' ? ['ilp32-pointer-abi'] : [];
  return Object.freeze({
    format:'macho', architecture, endianness:'little', bits:info.is64===false?32:64,
    pointerBits:info.pointerBits || (info.ilp32?32:(info.is64===false?32:64)), ilp32:!!info.ilp32,
    canDisassemble:aarch64, canAnalyzeDataflow:aarch64, canEmulate:false, viewerCanDisassemble:aarch64,
    instructionAlignment:aarch64?4:(architecture==='arm'?2:1), fixedInstructionSize:aarch64?4:null,
    analysisLevel:partial?'partial':aarch64?'full':'data-only', limitations, engineVerified:false,
  });
}
