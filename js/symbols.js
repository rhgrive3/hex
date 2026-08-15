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
    /* 1 = 外へ公開されている名前（エクスポート）。0 = このファイルの中だけ。 */
    this.flags = r.flags || new Uint8Array(this.addrs.length);
    this.funcs = r.funcs || new BigUint64Array(0);
    /* Optional exact function ends. A zero/missing entry means unknown. */
    this.funcEnds = r.funcEnds || null;
    /* Executable regions are the trust boundary for containment. */
    this.functionRegions = [];
    this.setFunctionRegions(r.regions || [], false);
    this.capped = !!r.capped;
    /* True only when LC_FUNCTION_STARTS itself was parsed successfully. ObjC,
       vtables and other metadata may add exact starts without making the list
       complete, so functionCount alone must never suppress stripped recovery. */
    this.functionStartsExact = !!r.functionStartsExact;
    this.guessed = false;          // 関数一覧が推測によるものか
    /* 自分で付け直した名前。元の名前より優先される（IDA の Rename と同じ）。
       アドレス（10 進の文字列）→ 名前。names.js の NoteStore が中身の持ち主。 */
    this.renames = new Map();
    /* Rename は元の symbol table に存在しない stripped function にも付く。
       nearest() を描画ごと O(rename count) にしないため、変更時だけ sorted index を再構築する。 */
    this._renameAddrs = [];
    this.gen = ++SymbolIndex.gen;  // 解説のキャッシュ鍵に使う
  }

  _refreshRenameAddrs() {
    const out = [];
    for (const key of this.renames.keys()) {
      try { out.push(BigInt(key)); } catch { /* malformed persisted key: ignore */ }
    }
    out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    this._renameAddrs = out;
  }

  /**
   * 自分で付けた名前を差し込む。空文字なら元の名前に戻す。
   * ここを通すと、命令一覧・関数一覧・呼び出し元まで一斉に新しい名前になる。
   */
  rename(addr, name) {
    if (addr == null) return;
    const k = addr.toString();
    if (name) this.renames.set(k, name);
    else this.renames.delete(k);
    this._refreshRenameAddrs();
    this.gen = ++SymbolIndex.gen;
  }

  /** 自分で付けた名前だけを引く。 */
  renamedAt(addr) {
    return addr == null ? null : (this.renames.get(addr.toString()) || null);
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
    const mine = this.renames.size ? this.renames.get(addr.toString()) : null;
    if (mine) return { name: mine, addr, kind: SYM_DEFINED, mine: true };
    const i = this._floor(this.addrs, addr);
    if (i < 0 || this.addrs[i] !== addr) return null;
    return { name: this.names[i], addr: this.addrs[i], kind: this.kinds[i] };
  }

  /**
   * そのアドレスを含む一番近い名前。`+0x1C` のような差も返す。
   * within を超えて離れているものは、無関係とみなして返さない。
   *
   * 重要: 関数境界を越えて前の関数の symbol を借りない。
   * stripped binary では次の関数に exact symbol が無いことが普通なので、これを
   * 許すと「別関数名+0x...」を現在関数の名前として表示してしまう。
   * Rename は元 symbol table に無い関数にも付くため、rename index も同時に検索する。
   */
  nearest(addr, within = 0x40000n) {
    const symbolIndex = this._floor(this.addrs, addr);
    const renameIndex = this._floor(this._renameAddrs, addr);

    const symbolAddr = symbolIndex >= 0 ? this.addrs[symbolIndex] : null;
    const renameAddr = renameIndex >= 0 ? this._renameAddrs[renameIndex] : null;

    let base = null;
    let name = null;
    let kind = SYM_DEFINED;
    let mine = false;

    /* Same-address rename wins over the original symbol. */
    if (renameAddr != null && (symbolAddr == null || renameAddr >= symbolAddr)) {
      base = renameAddr;
      name = this.renames.get(renameAddr.toString()) || null;
      mine = !!name;
    } else if (symbolAddr != null) {
      base = symbolAddr;
      name = this.names[symbolIndex];
      kind = this.kinds[symbolIndex];
    }

    if (base == null || !name) return null;

    /* Do not leak a label from a previous function into an unnamed function.
       Local labels/symbols inside the current function remain valid because their
       address is >= the current function start. */
    const fi = this._floor(this.funcs, addr);
    if (fi >= 0) {
      const functionStart = this.funcs[fi];
      if (base < functionStart) return null;
    }

    const delta = addr - base;
    if (delta > within) return null;
    return { name, addr: base, kind, delta, mine };
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

  /** その名前が外へ公開されているか（エクスポートされているか）。 */
  isExported(index) { return !!(this.flags && this.flags[index]); }

  /** そのアドレスが関数の先頭かどうか。 */
  isFunctionStart(addr) {
    const i = this._floor(this.funcs, addr);
    return i >= 0 && this.funcs[i] === addr;
  }

  /**
   * Function containment must never be inferred across executable-region gaps.
   * `bump=false` is used only by the constructor before `gen` is initialized.
   */
  setFunctionRegions(regions, bump = true) {
    const out = [];
    for (const region of regions || []) {
      if (!region || !region.exec || region.vmAddr == null || region.size == null) continue;
      try {
        const start = BigInt(region.vmAddr);
        const size = BigInt(region.size);
        if (size <= 0n) continue;
        out.push({ start, end: start + size, id: region.id ?? null });
      } catch { /* malformed/untrusted region metadata: ignore */ }
    }
    out.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
    this.functionRegions = out;
    if (bump) this.gen = ++SymbolIndex.gen;
    return out.length;
  }

  _functionRegion(addr) {
    const rs = this.functionRegions;
    let lo = 0, hi = rs.length - 1, best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (rs[mid].start <= addr) { best = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    if (best < 0) return null;
    const r = rs[best];
    return addr < r.end ? r : null;
  }

  _functionEnd(index) {
    if (index < 0 || index >= this.funcs.length) return null;
    const start = this.funcs[index];
    const region = this._functionRegion(start);

    if (this.funcEnds && index < this.funcEnds.length) {
      const explicit = this.funcEnds[index];
      if (explicit != null && explicit > start) {
        if (region && explicit > region.end) return null;
        return explicit;
      }
    }

    if (index + 1 >= this.funcs.length) return null;
    const next = this.funcs[index + 1];
    if (next <= start || next - start > 0x40000n) return null;

    if (this.functionRegions.length) {
      const nextRegion = this._functionRegion(next);
      if (!region || !nextRegion || nextRegion !== region) return null;
    }
    return next;
  }

  /**
   * そのアドレスを含む関数の {start, end}。分からなければ null。
   * Exact starts are always safe. Interior addresses require a trusted end:
   * an explicit size/end, or a reasonably bounded next start in the same
   * executable region. The last known function never absorbs trailing bytes.
   */
  functionAt(addr) {
    const i = this._floor(this.funcs, addr);
    if (i < 0) return null;
    const start = this.funcs[i];
    const end = this._functionEnd(i);
    if (addr === start) return { start, end, index: i };
    if (end == null || addr >= end) return null;

    if (this.functionRegions.length) {
      const startRegion = this._functionRegion(start);
      const addrRegion = this._functionRegion(addr);
      if (!startRegion || !addrRegion || startRegion !== addrRegion) return null;
    }
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
      const trustedEnd = this._functionEnd(i);
      const end = trustedEnd != null && (hi == null || trustedEnd <= hi) ? trustedEnd : null;
      const e = this.exact(a);
      out.push({
        addr: a,
        name: e ? e.name : null,
        size: end != null && end > a ? end - a : null,
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
      out.push({ addr: a, name: this.names[i], kind: this.kinds[i], exported: this.isExported(i) });
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
      merged.push({ addr: this.addrs[i], name: this.names[i], kind: this.kinds[i], ext: this.flags[i] });
    }
    for (const e of fresh) merged.push({ addr: e.addr, name: e.name, kind: SYM_DEFINED, ext: 0 });
    merged.sort((a, b) => (a.addr < b.addr ? -1 : a.addr > b.addr ? 1 : 0));

    const addrs = new BigUint64Array(merged.length);
    const kinds = new Uint8Array(merged.length);
    const flags = new Uint8Array(merged.length);
    const names = new Array(merged.length);
    for (let i = 0; i < merged.length; i++) {
      addrs[i] = merged[i].addr; kinds[i] = merged[i].kind; names[i] = merged[i].name;
      flags[i] = merged[i].ext || 0;
    }
    this.addrs = addrs; this.kinds = kinds; this.names = names; this.flags = flags;
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
    /* Existing end metadata is index-aligned and is invalid after insertion. */
    this.funcEnds = null;
    this.gen = ++SymbolIndex.gen;
    return added;
  }

  /** 推測で得た関数の先頭を取り込む（LC_FUNCTION_STARTS がないとき）。 */
  setGuessedFunctions(starts) {
    this.funcs = starts || new BigUint64Array(0);
    this.funcEnds = null;
    this.guessed = true;
    this.gen = ++SymbolIndex.gen;
  }
}

SymbolIndex.gen = 0;

/** 空の索引。ファイルを開く前や、Mach-O でないファイル用。 */
export const EMPTY_INDEX = new SymbolIndex();
