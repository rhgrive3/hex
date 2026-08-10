/*
 * 名前（シンボル）と関数の切れ目を、アドレスから引けるようにする索引。
 *
 * ワーカーからは型付き配列で受け取る。数十万件あっても、
 * 1 回の検索は二分探索なので 20 回程度の比較で終わる。
 * 描画のたびに全行ぶん引かれるので、ここが遅いとスクロールが死ぬ。
 */

export const SYM_DEFINED = 0;   // このファイルの中で定義された名前
export const SYM_STUB = 1;      // 外部ライブラリへの中継地点 (__stubs)
export const SYM_POINTER = 2;   // 外部関数のアドレスを入れる箱 (__got など)

export class SymbolIndex {
  constructor(result) {
    const r = result || {};
    this.addrs = r.addrs || new BigUint64Array(0);
    this.kinds = r.kinds || new Uint8Array(0);
    this.names = r.names ? r.names.split('\n') : [];
    this.funcs = r.funcs || new BigUint64Array(0);
    this.capped = !!r.capped;
    this.guessed = false;          // 関数一覧が推測によるものか
    this.gen = ++SymbolIndex.gen;  // 解説のキャッシュ鍵に使う
  }

  get symbolCount() { return this.addrs.length; }
  get functionCount() { return this.funcs.length; }
  get hasNames() { return this.addrs.length > 0; }

  /** addr 以下で最も近いシンボルの添字。なければ -1。 */
  _floor(arr, addr) {
    let lo = 0, hi = arr.length - 1, best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid] <= addr) { best = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    return best;
  }

  /** ちょうどそのアドレスに付いた名前。なければ null。 */
  exact(addr) {
    const i = this._floor(this.addrs, addr);
    if (i < 0 || this.addrs[i] !== addr) return null;
    return { name: this.names[i], addr: this.addrs[i], kind: this.kinds[i] };
  }

  /**
   * そのアドレスを含む一番近い名前。`+0x1C` のような差も返す。
   * within を超えて離れているものは、無関係とみなして返さない。
   */
  nearest(addr, within = 0x40000n) {
    const i = this._floor(this.addrs, addr);
    if (i < 0) return null;
    const delta = addr - this.addrs[i];
    if (delta > within) return null;
    return { name: this.names[i], addr: this.addrs[i], kind: this.kinds[i], delta };
  }

  /** 表示用: 「_foo」または「_foo+0x1C」。名前がなければ null。 */
  label(addr) {
    const s = this.nearest(addr);
    if (!s) return null;
    return s.delta === 0n ? s.name : s.name + '+0x' + s.delta.toString(16).toUpperCase();
  }

  /** ちょうどそのアドレスの名前だけ（分岐先の表示に使う）。 */
  nameAt(addr) {
    const e = this.exact(addr);
    return e ? e.name : null;
  }

  /** そのアドレスが関数の先頭かどうか。 */
  isFunctionStart(addr) {
    const i = this._floor(this.funcs, addr);
    return i >= 0 && this.funcs[i] === addr;
  }

  /** そのアドレスを含む関数の {start, end}。分からなければ null。 */
  functionAt(addr) {
    const i = this._floor(this.funcs, addr);
    if (i < 0) return null;
    const start = this.funcs[i];
    const end = i + 1 < this.funcs.length ? this.funcs[i + 1] : null;
    return { start, end, index: i };
  }

  /** 関数の一覧を作る。名前があれば付ける。region で範囲を絞る。 */
  functionList(region, max = 50000) {
    const out = [];
    const lo = region ? region.vmAddr : 0n;
    const hi = region ? region.vmAddr + region.size : null;
    for (let i = 0; i < this.funcs.length && out.length < max; i++) {
      const a = this.funcs[i];
      if (a < lo) continue;
      if (hi != null && a >= hi) break;
      const next = i + 1 < this.funcs.length ? this.funcs[i + 1] : hi;
      const e = this.exact(a);
      out.push({
        addr: a,
        name: e ? e.name : null,
        size: next != null && next > a ? next - a : null,
      });
    }
    return out;
  }

  /** 名前つきシンボルの一覧（範囲つき、種類で絞れる）。 */
  symbolList({ region, kind, max = 50000 } = {}) {
    const out = [];
    const lo = region ? region.vmAddr : null;
    const hi = region ? region.vmAddr + region.size : null;
    for (let i = 0; i < this.addrs.length && out.length < max; i++) {
      const a = this.addrs[i];
      if (lo != null && (a < lo || a >= hi)) continue;
      if (kind != null && this.kinds[i] !== kind) continue;
      out.push({ addr: a, name: this.names[i], kind: this.kinds[i] });
    }
    return out;
  }

  /**
   * 名前をあとから足す（Objective-C のクラス表から復元したものなど）。
   * アドレス順を保ったまま差し込む。同じアドレスに既に名前があればそちらを優先。
   *
   * @param {Array<{addr:BigInt,name:string}>} entries
   */
  addNames(entries) {
    if (!entries || !entries.length) return 0;
    const have = new Set();
    for (let i = 0; i < this.addrs.length; i++) have.add(this.addrs[i]);
    const fresh = [];
    for (const e of entries) {
      if (!e || e.addr == null || !e.name || have.has(e.addr)) continue;
      have.add(e.addr);
      fresh.push(e);
    }
    if (!fresh.length) return 0;

    const merged = [];
    for (let i = 0; i < this.addrs.length; i++) {
      merged.push({ addr: this.addrs[i], name: this.names[i], kind: this.kinds[i] });
    }
    for (const e of fresh) merged.push({ addr: e.addr, name: e.name, kind: SYM_DEFINED });
    merged.sort((a, b) => (a.addr < b.addr ? -1 : a.addr > b.addr ? 1 : 0));

    const addrs = new BigUint64Array(merged.length);
    const kinds = new Uint8Array(merged.length);
    const names = new Array(merged.length);
    for (let i = 0; i < merged.length; i++) {
      addrs[i] = merged[i].addr; kinds[i] = merged[i].kind; names[i] = merged[i].name;
    }
    this.addrs = addrs; this.kinds = kinds; this.names = names;
    this.gen = ++SymbolIndex.gen;
    return fresh.length;
  }

  /**
   * 関数の先頭を足す。Objective-C のメソッドの実装アドレスは、
   * それ自体が確実な関数の先頭なので、切れ目の情報がないファイルで特に効く。
   */
  addFunctions(list) {
    if (!list || !list.length) return 0;
    const have = new Set();
    for (let i = 0; i < this.funcs.length; i++) have.add(this.funcs[i]);
    const all = Array.from(have);
    let added = 0;
    for (const a of list) {
      if (a == null || have.has(a)) continue;
      have.add(a); all.push(a); added++;
    }
    if (!added) return 0;
    all.sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
    const out = new BigUint64Array(all.length);
    for (let i = 0; i < all.length; i++) out[i] = all[i];
    this.funcs = out;
    this.gen = ++SymbolIndex.gen;
    return added;
  }

  /** 推測で得た関数の先頭を取り込む（LC_FUNCTION_STARTS がないとき）。 */
  setGuessedFunctions(starts) {
    this.funcs = starts || new BigUint64Array(0);
    this.guessed = true;
    this.gen = ++SymbolIndex.gen;
  }
}

SymbolIndex.gen = 0;

/** 空の索引。ファイルを開く前や、Mach-O でないファイル用。 */
export const EMPTY_INDEX = new SymbolIndex();
