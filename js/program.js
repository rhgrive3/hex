/*
 * プログラム全体の索引 — 「誰が誰を呼び、誰が何を見ているか」。
 * 中身は型付き配列と二分探索。query arrayにはcomplete/capped metadataも付け、
 * edge cap到達時に「結果が無い」を「参照が無い」と誤解させない。
 */
import './words.js';

const Words = globalThis.Words;
export const KIND = Words.KIND;

function lowerBound(values, order, addr) {
  let lo = 0, hi = order.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (values[order[mid]] < addr) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
function lowerBoundDirect(values, addr) {
  let lo = 0, hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (values[mid] < addr) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
function completeness(array, capped, source, queryLimited = false) {
  const sourceCapped = !!capped;
  const locallyLimited = !!queryLimited;
  Object.defineProperties(array, {
    complete: { value: !sourceCapped && !locallyLimited, enumerable: false, configurable: true },
    capped: { value: sourceCapped, enumerable: false, configurable: true },
    queryLimited: { value: locallyLimited, enumerable: false, configurable: true },
    completenessSource: { value: source, enumerable: false, configurable: true },
    incompleteReason: {
      value: sourceCapped ? `${source}-source-capped` : (locallyLimited ? 'query-limit' : null),
      enumerable: false, configurable: true,
    },
  });
  return array;
}

export class ProgramIndex {
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
    this._byCallTo = null;
    this._byRefTo = null;
  }
  get callCount() { return this.callFrom.length; }
  get refCount() { return this.refFrom.length; }
  get statsComplete() { return this.kindsCovered >= this.words; }
  get graphCompleteness() { return Object.freeze({ callsComplete: !this.callsCapped, refsComplete: !this.refsCapped, statsComplete: this.statsComplete }); }

  _callToOrder() {
    if (!this._byCallTo) {
      const n = this.callTo.length, order = new Int32Array(n), to = this.callTo;
      for (let i = 0; i < n; i++) order[i] = i;
      order.sort((a, b) => (to[a] < to[b] ? -1 : to[a] > to[b] ? 1 : a - b));
      this._byCallTo = order;
    }
    return this._byCallTo;
  }
  _refToOrder() {
    if (!this._byRefTo) {
      const n = this.refTo.length, order = new Int32Array(n), to = this.refTo;
      for (let i = 0; i < n; i++) order[i] = i;
      order.sort((a, b) => (to[a] < to[b] ? -1 : to[a] > to[b] ? 1 : a - b));
      this._byRefTo = order;
    }
    return this._byRefTo;
  }
  functionStartOf(addr) {
    if (!this.symbols || !this.symbols.functionCount) return null;
    const fn = this.symbols.functionAt(addr);
    if (!fn || (fn.end != null && addr >= fn.end)) return null;
    return fn.start;
  }
  functionRange(addr) {
    if (!this.symbols || !this.symbols.functionCount) return null;
    const fn = this.symbols.functionAt(addr);
    if (!fn) return null;
    return { start: fn.start, end: fn.end != null ? fn.end : (this.region ? this.region.vmAddr + this.region.size : null) };
  }
  callSitesTo(target, limit = 500) {
    const order = this._callToOrder(), out = [];
    let i = lowerBound(this.callTo, order, target), queryLimited = false;
    for (; i < order.length; i++) {
      const k = order[i];
      if (this.callTo[k] !== target) break;
      if (out.length >= limit) { queryLimited = true; break; }
      out.push({ site: this.callFrom[k], caller: this.functionStartOf(this.callFrom[k]) });
    }
    return completeness(out, this.callsCapped, 'calls', queryLimited);
  }
  callersOf(target, limit = 200) {
    const seen = new Map();
    const sites = this.callSitesTo(target, Math.max(0, limit * 4));
    let queryLimited = sites.complete !== true;
    for (const c of sites) {
      const key = c.caller != null ? c.caller.toString() : 's' + c.site.toString();
      if (!seen.has(key)) {
        if (seen.size >= limit) { queryLimited = true; break; }
        seen.set(key, { addr: c.caller, site: c.site, count: 0 });
      }
      seen.get(key).count++;
    }
    return completeness(Array.from(seen.values()), this.callsCapped, 'calls', queryLimited);
  }
  calleesOf(start, end, limit = 200) {
    const out = new Map(); let i = lowerBoundDirect(this.callFrom, start), queryLimited = false;
    for (; i < this.callFrom.length; i++) {
      const from = this.callFrom[i]; if (end != null && from >= end) break;
      const to = this.callTo[i], key = to.toString();
      if (!out.has(key)) {
        if (out.size >= limit) { queryLimited = true; break; }
        out.set(key, { addr: to, site: from, count: 0 });
      }
      out.get(key).count++;
    }
    return completeness(Array.from(out.values()), this.callsCapped, 'calls', queryLimited);
  }
  callCountOf(target) {
    const order = this._callToOrder(); let i = lowerBound(this.callTo, order, target), n = 0;
    for (; i < order.length && this.callTo[order[i]] === target; i++) n++;
    return n;
  }
  refSitesTo(addr, span = 1n, limit = 500) {
    const order = this._refToOrder(), out = []; let i = lowerBound(this.refTo, order, addr), queryLimited = false;
    const hi = addr + (span > 0n ? span : 1n);
    for (; i < order.length; i++) {
      const k = order[i]; if (this.refTo[k] >= hi) break;
      if (out.length >= limit) { queryLimited = true; break; }
      out.push({ site: this.refFrom[k], target: this.refTo[k], kind: this.refKind[k] });
    }
    return completeness(out, this.refsCapped, 'refs', queryLimited);
  }
  functionsReferencing(addr, span = 1n, limit = 200) {
    const seen = new Map();
    const refs = this.refSitesTo(addr, span, Math.max(0, limit * 4));
    let queryLimited = refs.complete !== true;
    for (const r of refs) {
      const fn = this.functionStartOf(r.site), key = fn != null ? fn.toString() : 's' + r.site.toString();
      if (!seen.has(key)) {
        if (seen.size >= limit) { queryLimited = true; break; }
        seen.set(key, { addr: fn, site: r.site, kind: r.kind, count: 0 });
      }
      seen.get(key).count++;
    }
    return completeness(Array.from(seen.values()), this.refsCapped, 'refs', queryLimited);
  }
  refsFrom(start, end, limit = 400) {
    const out = []; let i = lowerBoundDirect(this.refFrom, start), queryLimited = false;
    for (; i < this.refFrom.length; i++) {
      const from = this.refFrom[i]; if (end != null && from >= end) break;
      if (out.length >= limit) { queryLimited = true; break; }
      out.push({ site: from, target: this.refTo[i], kind: this.refKind[i] });
    }
    return completeness(out, this.refsCapped, 'refs', queryLimited);
  }
  statsOf(start, end) {
    const stats = { total: 0, covered: true, arith: 0, mul: 0, div: 0, logic: 0, shift: 0, farith: 0, fmul: 0, fconv: 0, simd: 0, load: 0, store: 0, cmp: 0, condbr: 0, branch: 0, call: 0, indcall: 0, ret: 0, csel: 0, atomic: 0, movimm: 0, adrp: 0, trap: 0, other: 0 };
    if (!this.kinds.length) { stats.covered = false; return stats; }
    const first = Number((start - this.vmAddr) / 4n), lastAddr = end != null ? end : start + 4n;
    let last = Number((lastAddr - this.vmAddr) / 4n);
    if (!(first >= 0)) return stats;
    if (last > this.kindsCovered) { last = this.kindsCovered; stats.covered = false; }
    for (let i = first; i < last; i++) {
      const k = this.kinds[i]; stats.total++;
      switch (k) {
        case KIND.ARITH: stats.arith++; break; case KIND.MUL: stats.mul++; break; case KIND.DIV: stats.div++; break;
        case KIND.LOGIC: stats.logic++; break; case KIND.SHIFT: stats.shift++; break; case KIND.FARITH: stats.farith++; break;
        case KIND.FMUL: stats.fmul++; break; case KIND.FCONV: stats.fconv++; break; case KIND.SIMD: stats.simd++; break;
        case KIND.LOAD: stats.load++; break; case KIND.STORE: stats.store++; break; case KIND.CMP: stats.cmp++; break;
        case KIND.CONDBR: stats.condbr++; break; case KIND.BRANCH: stats.branch++; break; case KIND.CALL: stats.call++; break;
        case KIND.INDCALL: stats.indcall++; break; case KIND.RET: stats.ret++; break; case KIND.CSEL: stats.csel++; break;
        case KIND.ATOMIC: stats.atomic++; break; case KIND.MOVIMM: stats.movimm++; break; case KIND.ADRP: stats.adrp++; break;
        case KIND.TRAP: stats.trap++; break; case KIND.OTHER: stats.other++; break; default: break;
      }
    }
    stats.numeric = stats.mul + stats.div + stats.fmul + stats.farith;
    stats.memory = stats.load + stats.store;
    return stats;
  }
  mostCalled(limit = 20) {
    const counts = new Map();
    for (let i = 0; i < this.callTo.length; i++) { const key = this.callTo[i].toString(); counts.set(key, (counts.get(key) || 0) + 1); }
    const out = []; for (const [key, n] of counts) out.push({ addr: BigInt(key), count: n });
    out.sort((a, b) => b.count - a.count);
    return completeness(out.slice(0, limit), this.callsCapped, 'calls', out.length > limit);
  }
}

export const EMPTY_PROGRAM = new ProgramIndex(null, null, null);
