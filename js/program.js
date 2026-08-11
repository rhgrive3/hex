/*
 * プログラム全体の索引 — 「誰が誰を呼び、誰が何を見ているか」。
 *
 * worker の scanProgram が 1 パスで集めた事実を、アドレスから引ける形にする。
 * ここがあるおかげで、このツールは
 *
 *   × 「damage という文字列の近くだから、この関数はダメージ計算っぽい」
 *   ○ 「この関数は 0x1004A2B0 の文字列を参照していて、
 *       BattleManager から呼ばれていて、中で 3 回の掛け算をしている」
 *
 * と言えるようになる。前者は推測、後者は事実。この差がこのツールの中心。
 *
 * 中身はすべて型付き配列と二分探索なので、数十万の辺があってもメモリも時間も食わない。
 * 日本語は 1 文字も作らない（言語に依存しない層）。
 */
/*
 * words.js は worker（classic worker）からも読めるように import/export を持たない。
 * 読み込むとグローバルへ Words が生えるので、ここではそれを受け取る。
 */
import './words.js';

const Words = globalThis.Words;
export const KIND = Words.KIND;

/** 二分探索: sorted[order[i]] が addr 以上になる最初の位置。 */
function lowerBound(values, order, addr) {
  let lo = 0, hi = order.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (values[order[mid]] < addr) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** そのまま昇順に並んでいる配列用。 */
function lowerBoundDirect(values, addr) {
  let lo = 0, hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (values[mid] < addr) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export class ProgramIndex {
  /**
   * @param {object} scan  worker の scanProgram の返り値
   * @param {object} symbols  SymbolIndex（関数の切れ目を持っている）
   * @param {object} region  対象のセクション
   */
  constructor(scan, symbols, region) {
    const s = scan || {};
    this.region = region || null;
    this.symbols = symbols || null;
    this.vmAddr = s.vmAddr != null ? s.vmAddr : (region ? region.vmAddr : 0n);
    this.callFrom = s.callFrom || new BigUint64Array(0);
    this.callTo = s.callTo || new BigUint64Array(0);
    this.refFrom = s.refFrom || new BigUint64Array(0);
    this.refTo = s.refTo || new BigUint64Array(0);
    this.refKind = s.refKind || new Uint8Array(0);
    this.kinds = s.kinds || new Uint8Array(0);
    this.kindsCovered = s.kindsCovered || 0;
    this.callsCapped = !!s.callsCapped;
    this.refsCapped = !!s.refsCapped;
    this.words = s.words || 0;
    this.gen = symbols && symbols.gen != null ? symbols.gen : 0;

    // 呼び出し先・参照先から引くための並び替え（使うときに 1 回だけ作る）
    this._byCallTo = null;
    this._byRefTo = null;
  }

  get callCount() { return this.callFrom.length; }
  get refCount() { return this.refFrom.length; }
  /** 語ごとの命令種別を最後まで持てているか。持てていなければ統計は「一部のみ」。 */
  get statsComplete() { return this.kindsCovered >= this.words; }

  _callToOrder() {
    if (!this._byCallTo) {
      const n = this.callTo.length;
      const order = new Int32Array(n);
      for (let i = 0; i < n; i++) order[i] = i;
      const to = this.callTo;
      order.sort((a, b) => (to[a] < to[b] ? -1 : to[a] > to[b] ? 1 : a - b));
      this._byCallTo = order;
    }
    return this._byCallTo;
  }

  _refToOrder() {
    if (!this._byRefTo) {
      const n = this.refTo.length;
      const order = new Int32Array(n);
      for (let i = 0; i < n; i++) order[i] = i;
      const to = this.refTo;
      order.sort((a, b) => (to[a] < to[b] ? -1 : to[a] > to[b] ? 1 : a - b));
      this._byRefTo = order;
    }
    return this._byRefTo;
  }

  /** そのアドレスを含む関数の先頭。分からなければ null。 */
  functionStartOf(addr) {
    if (!this.symbols || !this.symbols.functionCount) return null;
    const fn = this.symbols.functionAt(addr);
    if (!fn) return null;
    if (fn.end != null && addr >= fn.end) return null;
    return fn.start;
  }

  /** 関数の範囲 {start, end}。end は次の関数の先頭（含まない）。 */
  functionRange(addr) {
    if (!this.symbols || !this.symbols.functionCount) return null;
    const fn = this.symbols.functionAt(addr);
    if (!fn) return null;
    const end = fn.end != null ? fn.end
      : (this.region ? this.region.vmAddr + this.region.size : null);
    return { start: fn.start, end };
  }

  /* ── 呼び出し関係 ─────────────────────────────────────────── */

  /**
   * この関数を呼んでいる場所。
   * @returns {Array<{site:BigInt, caller:BigInt|null}>}
   */
  callSitesTo(target, limit = 500) {
    const order = this._callToOrder();
    const out = [];
    let i = lowerBound(this.callTo, order, target);
    for (; i < order.length && out.length < limit; i++) {
      const k = order[i];
      if (this.callTo[k] !== target) break;
      out.push({ site: this.callFrom[k], caller: this.functionStartOf(this.callFrom[k]) });
    }
    return out;
  }

  /** 呼び出し元の関数の一覧（重複をまとめたもの）。 */
  callersOf(target, limit = 200) {
    const seen = new Map();
    for (const c of this.callSitesTo(target, limit * 4)) {
      const key = c.caller != null ? c.caller.toString() : 's' + c.site.toString();
      if (!seen.has(key)) {
        seen.set(key, { addr: c.caller, site: c.site, count: 0 });
        if (seen.size >= limit) { seen.get(key).count++; break; }
      }
      seen.get(key).count++;
    }
    return Array.from(seen.values());
  }

  /** この関数が呼んでいる先（まとめたもの）。 */
  calleesOf(start, end, limit = 200) {
    const out = new Map();
    let i = lowerBoundDirect(this.callFrom, start);
    for (; i < this.callFrom.length; i++) {
      const from = this.callFrom[i];
      if (end != null && from >= end) break;
      const to = this.callTo[i];
      const key = to.toString();
      if (!out.has(key)) {
        if (out.size >= limit) break;
        out.set(key, { addr: to, site: from, count: 0 });
      }
      out.get(key).count++;
    }
    return Array.from(out.values());
  }

  /** 何回呼ばれているか（よく使われる処理ほど「アプリの本筋」に近い）。 */
  callCountOf(target) {
    const order = this._callToOrder();
    let i = lowerBound(this.callTo, order, target);
    let n = 0;
    for (; i < order.length; i++) {
      if (this.callTo[order[i]] !== target) break;
      n++;
    }
    return n;
  }

  /* ── データ参照 ───────────────────────────────────────────── */

  /**
   * このアドレスを指している命令。文字列 → それを使っている場所、がこれ。
   * @param {BigInt} addr
   * @param {BigInt} [span] 何バイトぶんを同じものとみなすか（文字列の長さなど）
   */
  refSitesTo(addr, span = 1n, limit = 500) {
    const order = this._refToOrder();
    const out = [];
    let i = lowerBound(this.refTo, order, addr);
    const hi = addr + (span > 0n ? span : 1n);
    for (; i < order.length && out.length < limit; i++) {
      const k = order[i];
      if (this.refTo[k] >= hi) break;
      out.push({ site: this.refFrom[k], target: this.refTo[k], kind: this.refKind[k] });
    }
    return out;
  }

  /** そのアドレスを参照している関数（重複なし）。 */
  functionsReferencing(addr, span = 1n, limit = 200) {
    const seen = new Map();
    for (const r of this.refSitesTo(addr, span, limit * 4)) {
      const fn = this.functionStartOf(r.site);
      const key = fn != null ? fn.toString() : 's' + r.site.toString();
      if (!seen.has(key)) {
        if (seen.size >= limit) break;
        seen.set(key, { addr: fn, site: r.site, kind: r.kind, count: 0 });
      }
      seen.get(key).count++;
    }
    return Array.from(seen.values());
  }

  /** その関数が指しているアドレス（文字列やデータ）。 */
  refsFrom(start, end, limit = 400) {
    const out = [];
    let i = lowerBoundDirect(this.refFrom, start);
    for (; i < this.refFrom.length && out.length < limit; i++) {
      const from = this.refFrom[i];
      if (end != null && from >= end) break;
      out.push({ site: from, target: this.refTo[i], kind: this.refKind[i] });
    }
    return out;
  }

  /* ── 関数ごとの命令の統計 ─────────────────────────────────
     語ごとの分類を数えるだけなので、逆アセンブルは要らない。
     「掛け算が 3 回ある」「メモリへの書き込みが 2 回ある」は推測ではなく事実。 */

  statsOf(start, end) {
    const stats = {
      total: 0, covered: true,
      arith: 0, mul: 0, div: 0, logic: 0, shift: 0,
      farith: 0, fmul: 0, fconv: 0, simd: 0,
      load: 0, store: 0, cmp: 0, condbr: 0, branch: 0,
      call: 0, indcall: 0, ret: 0, csel: 0, atomic: 0, movimm: 0, adrp: 0,
      trap: 0, other: 0,
    };
    if (!this.kinds.length) { stats.covered = false; return stats; }
    const first = Number((start - this.vmAddr) / 4n);
    const lastAddr = end != null ? end : start + 4n;
    let last = Number((lastAddr - this.vmAddr) / 4n);
    if (!(first >= 0)) return stats;
    if (last > this.kindsCovered) { last = this.kindsCovered; stats.covered = false; }
    for (let i = first; i < last; i++) {
      const k = this.kinds[i];
      stats.total++;
      switch (k) {
        case KIND.ARITH: stats.arith++; break;
        case KIND.MUL: stats.mul++; break;
        case KIND.DIV: stats.div++; break;
        case KIND.LOGIC: stats.logic++; break;
        case KIND.SHIFT: stats.shift++; break;
        case KIND.FARITH: stats.farith++; break;
        case KIND.FMUL: stats.fmul++; break;
        case KIND.FCONV: stats.fconv++; break;
        case KIND.SIMD: stats.simd++; break;
        case KIND.LOAD: stats.load++; break;
        case KIND.STORE: stats.store++; break;
        case KIND.CMP: stats.cmp++; break;
        case KIND.CONDBR: stats.condbr++; break;
        case KIND.BRANCH: stats.branch++; break;
        case KIND.CALL: stats.call++; break;
        case KIND.INDCALL: stats.indcall++; break;
        case KIND.RET: stats.ret++; break;
        case KIND.CSEL: stats.csel++; break;
        case KIND.ATOMIC: stats.atomic++; break;
        case KIND.MOVIMM: stats.movimm++; break;
        case KIND.ADRP: stats.adrp++; break;
        case KIND.TRAP: stats.trap++; break;
        case KIND.OTHER: stats.other++; break;
        default: break;
      }
    }
    // 「数の計算をしている」ことのまとめ（ダメージ計算などを探す手がかり）
    stats.numeric = stats.mul + stats.div + stats.fmul + stats.farith;
    stats.memory = stats.load + stats.store;
    return stats;
  }

  /** よく呼ばれている関数の順。アプリの本筋に近いものが上に来る。 */
  mostCalled(limit = 20) {
    const counts = new Map();
    for (let i = 0; i < this.callTo.length; i++) {
      const key = this.callTo[i].toString();
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    const out = [];
    for (const [key, n] of counts) out.push({ addr: BigInt(key), count: n });
    out.sort((a, b) => b.count - a.count);
    return out.slice(0, limit);
  }
}

/** 空の索引。走査していないファイルでも UI が落ちないように。 */
export const EMPTY_PROGRAM = new ProgramIndex(null, null, null);
