/* Format-neutral backend facade. Legacy ARM64/Mach-O worker remains a compatibility engine. */
import { LRU } from './lru.js';
import { augmentAnalysisResultWithChainedImports } from './chained.js';
import { AnalysisCache } from './cache/analysis-cache.js';

export const CHUNK_ROWS = 1024;
export const CHUNK_BYTES = CHUNK_ROWS * 4;
const CHUNK_CACHE = 64;
const MAX_INFLIGHT = 6;

export class StaleRequestError extends Error {
  constructor() {
    super('The analysis request belongs to a file or slice that is no longer active.');
    this.name = 'StaleRequestError';
    this.stale = true;
  }
}

export class Backend {
  constructor() {
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
    this._disasmWorker = null;
    this._disasmSeq = 1;
    this._disasmPending = new Map();
    this.contentHash = null;
    this.analysisCache = new AnalysisCache();

    this.legacyWorker.onmessage = (event) => this._onMessage(event.data, 'legacy');
    this.platformWorker.onmessage = (event) => this._onMessage(event.data, 'platform');
    const failed = (event) => {
      const msg = event?.message || 'The analysis worker failed to start.';
      if (this.onFatal) this.onFatal(msg);
    };
    this.legacyWorker.onerror = failed;
    this.platformWorker.onerror = failed;

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
      if (this.onFatal) this.onFatal(message.error);
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
    const id = this.seq++;
    this.lastRequestId = id;
    const uiEpoch = this.gen;
    const transportEpoch = this.transportEpoch;
    const promise = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, uiEpoch, transportEpoch, workerName, onProgress });
      this._worker(workerName).postMessage({ t, id, requestId: id, epoch: transportEpoch, ...payload }, transfer || []);
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
    this.transportEpoch++;
    let detection = null;
    let platformError = null;
    try { detection = await this._callTo('platform', 'detect', { file }); }
    catch (error) { if (error?.stale) throw error; platformError = error; }

    let nextFormat = 'unknown';
    let nextPlatform = null;
    let nextLegacy = null;
    let nextBridge = false;
    let result = null;
    if (detection?.formatId === 'macho') {
      nextFormat = 'macho';
      const legacy = await this._callTo('legacy', 'open', { file });
      legacy.formatId = 'macho';
      for (const slice of legacy.slices || []) slice.capability = legacySliceCapability(slice);
      legacy.capability = legacy.slices?.[0]?.capability || legacySliceCapability(null);
      legacy.platform = { compatibility:'legacy-macho', sourceBackedDetection:true, detected:detection, duplicateUniversalParseAvoided:true };
      nextLegacy = legacy;
      nextPlatform = { formatId:'macho', capability:legacy.capability, detection, compatibility:'legacy-macho' };
      result = legacy;
    } else {
      let platformInfo = null;
      try { platformInfo = await this._callTo('platform', 'open', { file }, null, (p) => this.onAnalysisProgress?.(p)); }
      catch (error) { if (error?.stale) throw error; platformError = error; }
      if (platformInfo) {
        nextPlatform = platformInfo;
        nextFormat = platformInfo.formatId || platformInfo.capability?.format || detection?.formatId || 'unknown';
        const capability = platformInfo.capability || platformInfo.slices?.[0]?.capability;
        nextBridge = capability?.architecture === 'arm64';
        if (nextBridge) {
          try {
            await this._callTo('legacy', 'open', { file });
            const allRegions=[...(platformInfo.slices||[]).flatMap((slice)=>slice.regions||[]),platformInfo.raw].filter(Boolean);
            await this._callTo('legacy','setRegions',{regions:allRegions});
          } catch { nextBridge=false; }
        }
        result=platformInfo;
      } else {
        const legacy=await this._callTo('legacy','open',{file});
        nextLegacy=legacy;
        if (platformError && legacy.format === 'Raw binary') legacy.warnings=[...(legacy.warnings||[]),platformError.message];
        result=legacy;
      }
    }
    this.advanceEpoch();
    this.file=file;
    this.formatId=nextFormat;
    this.platformInfo=nextPlatform;
    this.legacyInfo=nextLegacy;
    this.arm64Bridge=nextBridge;
    this.contentHash=null;
    return result;
  }

  probe() {
    if (this.formatId === 'macho' || this.arm64Bridge) return this._callTo('legacy', 'probe', {});
    return this._callTo('platform', 'probe', {});
  }

  probeArchitectures() {
    if (this._archProbe) return this._archProbe;
    this._archProbe = new Promise((resolve) => {
      const worker = new Worker(new URL('./platform/capstone-probe-worker.js', import.meta.url));
      const finish = (value) => { worker.terminate(); resolve(value); };
      worker.onmessage = (event) => finish(event.data);
      worker.onerror = (event) => finish({ ok: false, error: event.message, support: { arm64: false, x86_64: false } });
      worker.postMessage({ t: 'probe' });
    }).finally(() => { this._archProbe = null; });
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
    if (requestId == null) return;
    const pending = this.pending.get(requestId);
    if (pending) this._worker(pending.workerName).postMessage({ t: 'cancel', requestId, epoch: pending.transportEpoch });
  }

  cancelSearch(request) { this.cancel(request); }

  analyze(sliceIndex) {
    const worker = this.formatId === 'macho' ? 'legacy' : 'platform';
    const file = this.file;
    return this._callTo(worker, 'analyze', { sliceIndex }).then((result) => {
      if (this.formatId !== 'macho') return result;
      return augmentAnalysisResultWithChainedImports(file, sliceIndex, result);
    });
  }

  guessFunctions(regionId, limit, onProgress) { return this.call('guessFunctions', { regionId, limit }, null, onProgress); }
  scanProgram(regionId, onProgress) { return this.call('scanProgram', { regionId }, null, onProgress); }
  fieldAccess(params, onProgress) { return this.call('fieldAccess', params, null, onProgress); }
  valueShapes(regionId, onProgress) { return this.call('valueShapes', { regionId }, null, onProgress); }
  fieldAccessMany(regionId, offsets) {
    return this.call('fieldAccess', { regionId, offsets }).then((res) => {
      const out = new Map();
      for (const key of Object.keys(res?.groups || {})) out.set(key, res.groups[key]);
      return out;
    });
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

  async ensureContentHash(onProgress) {
    if (this.contentHash) return this.contentHash;
    const result = await this._callTo('platform', 'hash', {}, null, onProgress);
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
    const read = await this._callTo('platform', 'readAt', { addr, len: Math.min(1024 * 1024, options.length || 4096), text: false });
    if (uiEpoch !== this.gen) throw new StaleRequestError();
    if (!read?.found) return { supported: true, architecture, instructions: [], found: false };
    const result = await this._disassembleBytes(read.bytes, addr, architecture, uiEpoch);
    if (uiEpoch !== this.gen) throw new StaleRequestError();
    return { supported: true, architecture, found: true, ...result };
  }

  _disassembleBytes(bytes, address, architecture, uiEpoch = this.gen) {
    if (!this._disasmWorker) {
      this._disasmWorker = new Worker(new URL('./platform/capstone-disasm-worker.js', import.meta.url));
      this._disasmWorker.onmessage = (event) => {
        const pending = this._disasmPending.get(event.data?.id);
        if (!pending) return;
        this._disasmPending.delete(event.data.id);
        if (pending.uiEpoch !== this.gen) { pending.reject(new StaleRequestError()); return; }
        if (event.data.ok) pending.resolve(event.data); else pending.reject(new Error(event.data.error || 'disassembly failed'));
      };
    }
    const id = this._disasmSeq++;
    const copy = bytes instanceof Uint8Array ? bytes.slice() : new Uint8Array(bytes);
    return new Promise((resolve, reject) => {
      this._disasmPending.set(id, { resolve, reject, uiEpoch });
      this._disasmWorker.postMessage({ id, architecture, address, bytes: copy }, [copy.buffer]);
    });
  }

  async loadAnalysisCache() { const hash = await this.ensureContentHash(); return this.analysisCache.get(hash); }
  async saveAnalysisCache(data) { const hash = await this.ensureContentHash(); return this.analysisCache.put(hash, data); }
  memoryStats() { return this._callTo('platform', 'memoryStats', {}); }
  cleanupMemory() {
    this.resetCache();
    this._releaseDisassembly(new Error('disassembly worker released for memory pressure'));
    return this._callTo('platform', 'cleanupMemory', {});
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
    return this.call('chunk', { regionId, chunk, wantAsm }).then((res) => {
      const entry = normalizeChunk(res);
      if (gen === this.gen) this.cache.set(key, entry);
      return entry;
    });
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
    // Snapshot what was actually placed on the wire. `job.wantAsm` may be
    // upgraded while this request is already executing.
    job.dispatchedWantAsm = !!job.wantAsm;
    this.call('chunk', { regionId: job.regionId, chunk: job.chunk, wantAsm: job.dispatchedWantAsm })
      .then((res) => {
        const entry = normalizeChunk(res);
        this.inflight.delete(job.key);
        if (job.gen !== this.gen) return;
        this.cache.set(job.key, entry);
        this.onChunk?.(job.regionId, job.chunk);

        if (job.wantAsm && !entry.mn) {
          // The consumer upgraded bytes-only -> assembly after dispatch. Queue
          // one real assembly request instead of pretending the original wire
          // request changed retroactively. It occupies the slot freed above.
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
