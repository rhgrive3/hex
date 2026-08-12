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
    this.onScanProgress = null;      // 文字列抽出・相互参照・関数推測の進み具合
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
    if (m.t === 'scanProgress') {
      if (this.onScanProgress) this.onScanProgress(m);
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

  /* ── 解析 ────────────────────────────────────────────────
     どれも worker 側で走査するので、UI は止まらない。
     cancelSearch() が走査全般の中断も兼ねている。 */

  analyze(sliceIndex) { return this.call('analyze', { sliceIndex }); }

  guessFunctions(regionId, limit) { return this.call('guessFunctions', { regionId, limit }); }

  /**
   * セクション全体を 1 パス走査して、呼び出しの辺・データ参照・語ごとの命令種別を取る。
   * これが「参照関係と制御フローを根拠にする」ための土台。1 ファイルにつき 1 回で足りる。
   */
  scanProgram(regionId) { return this.call('scanProgram', { regionId }); }

  /** そのフィールド（クラスの中の位置）を読み書きしている命令を全部探す。 */
  fieldAccess(params) { return this.call('fieldAccess', params); }

  /**
   * 値の「ふるまい」をセクション全体から集める。
   * 名前も文字列も残っていないアプリで、値を見分ける唯一の手がかりになる。
   * 1 ファイルにつき 1 回でよい。
   */
  valueShapes(regionId) { return this.call('valueShapes', { regionId }); }

  /**
   * 複数の位置を 1 回の走査でまとめて調べる。
   * 候補ごとにセクションを舐め直さないための入口（特定の決着に使う）。
   * @returns {Promise<Map<string, Array>>} ずらし幅（10 進の文字列）→ 読み書きした命令
   */
  fieldAccessMany(regionId, offsets) {
    return this.call('fieldAccess', { regionId, offsets }).then((res) => {
      const out = new Map();
      const groups = (res && res.groups) || {};
      for (const key of Object.keys(groups)) out.set(key, groups[key]);
      return out;
    });
  }

  strings(params) { return this.call('strings', params); }

  xrefs(params) { return this.call('xrefs', params); }

  /** 仮想アドレスの中身を読む。text: true で 0 終端の文字列として解釈。 */
  readAt(addr, len, text) { return this.call('readAt', { addr, len, text }); }

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

  /**
   * Await a chunk instead of painting when it lands. Used by range copy, which
   * needs rows the viewport has never shown; it bypasses the render queue so a
   * long copy cannot starve scrolling, and fills the same cache.
   */
  fetchChunk(regionId, chunk, wantAsm) {
    const key = this.key(regionId, chunk);
    const cached = this.cache.get(key);
    if (cached && !cached.error && (!wantAsm || cached.mn)) return Promise.resolve(cached);
    const gen = this.gen;
    return this.call('chunk', { regionId, chunk, wantAsm }).then((res) => {
      const entry = {
        bytes: res.bytes,
        rows: res.rows,
        mn: res.mn ? res.mn.split('\n') : null,
        ops: res.ops ? res.ops.split('\n') : null,
      };
      if (gen === this.gen) this.cache.set(key, entry);
      return entry;
    });
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
