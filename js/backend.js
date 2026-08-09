/*
 * Backend: the only thing that talks to the worker.
 * The UI asks for rows; it never sees Capstone, file offsets or postMessage.
 */
import { LRU } from './lru.js';

export const CHUNK_ROWS = 1024;
export const CHUNK_BYTES = CHUNK_ROWS * 4;
const CHUNK_CACHE = 64;          // ~64k instructions kept warm
const MAX_INFLIGHT = 6;

export class Backend {
  constructor() {
    this.worker = new Worker(new URL('./worker.js', import.meta.url));
    this.seq = 1;
    this.gen = 0;                    // bumped per file; stale chunks are dropped
    this.pending = new Map();
    this.cache = new LRU(CHUNK_CACHE);
    this.inflight = new Map();
    this.queue = [];
    this.onSearchProgress = null;
    this.onChunk = null;             // called when a chunk arrives
    this.onFatal = null;

    this.worker.onmessage = (e) => this._onMessage(e.data);
    this.worker.onerror = (e) => {
      const msg = e.message || 'The analysis worker failed to start.';
      if (this.onFatal) this.onFatal(msg);
    };
  }

  _onMessage(m) {
    if (!m) return;
    if (m.t === 'searchProgress') {
      if (this.onSearchProgress) this.onSearchProgress(m);
      return;
    }
    if (m.t === 'fatal') {
      if (this.onFatal) this.onFatal(m.error);
      return;
    }
    const p = this.pending.get(m.id);
    if (!p) return;
    this.pending.delete(m.id);
    if (m.t === 'ok') p.resolve(m.result);
    else p.reject(new Error(m.error || 'Analysis failed.'));
  }

  call(t, payload, transfer) {
    const id = this.seq++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage(Object.assign({ t, id }, payload), transfer || []);
    });
  }

  /* ── high level ─────────────────────────────────────────── */

  open(file) {
    this.gen++;                      // region ids repeat between files
    this.resetCache();
    return this.call('open', { file });
  }

  probe() { return this.call('probe', {}); }

  registerRegions(regions) { return this.call('setRegions', { regions }); }

  search(params) { return this.call('search', params); }

  cancelSearch() { this.worker.postMessage({ t: 'cancelSearch' }); }

  /** Drop cached rows, e.g. when switching region. */
  resetCache() {
    this.cache.clear();
    this.inflight.clear();
    this.queue.length = 0;
  }

  key(regionId, chunk) { return this.gen + ':' + regionId + '#' + chunk; }

  /** Cached chunk or undefined. Never blocks. */
  peek(regionId, chunk, wantAsm) {
    const c = this.cache.get(this.key(regionId, chunk));
    if (!c) return undefined;
    if (wantAsm && !c.mn) return undefined;   // cached bytes-only; needs a re-fetch
    return c;
  }

  /** Ask for a chunk; `onChunk` fires when it lands. */
  request(regionId, chunk, wantAsm) {
    const key = this.key(regionId, chunk);
    const inflight = this.inflight.get(key);
    if (inflight) {
      if (wantAsm && !inflight.wantAsm) inflight.wantAsm = true;  // upgrade for the retry
      return;
    }
    const cached = this.cache.get(key);
    if (cached && (!wantAsm || cached.mn)) return;

    const job = { regionId, chunk, wantAsm, key, gen: this.gen };
    this.inflight.set(key, job);
    if (this.inflight.size - this.queue.length > MAX_INFLIGHT) this.queue.push(job);
    else this._dispatch(job);
  }

  _dispatch(job) {
    this.call('chunk', { regionId: job.regionId, chunk: job.chunk, wantAsm: job.wantAsm })
      .then((res) => {
        this.inflight.delete(job.key);
        if (job.gen !== this.gen) return;          // belongs to a file we closed
        const entry = {
          bytes: res.bytes,
          rows: res.rows,
          mn: res.mn ? res.mn.split('\n') : null,
          ops: res.ops ? res.ops.split('\n') : null,
        };
        this.cache.set(job.key, entry);
        if (this.onChunk) this.onChunk(job.regionId, job.chunk);
      })
      .catch((err) => {
        this.inflight.delete(job.key);
        if (job.gen !== this.gen) return;
        const entry = { bytes: new Uint8Array(0), rows: 0, mn: null, ops: null, error: err.message };
        this.cache.set(job.key, entry);
        if (this.onChunk) this.onChunk(job.regionId, job.chunk, err);
      })
      .then(() => {
        const next = this.queue.shift();
        if (next) this._dispatch(next);
      });
  }

  /** Drop queued (not yet dispatched) work — used when the user jumps away. */
  dropQueued() {
    for (const job of this.queue) this.inflight.delete(job.key);
    this.queue.length = 0;
  }
}
