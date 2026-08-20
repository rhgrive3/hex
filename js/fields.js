/*
 * フィールド（ivar）の索引 — 「x0 + 0x20」を「self の hp」に変える層。
 *
 * このツールでいちばん効く一手。逆アセンブルの中でいちばん多いのは
 *
 *     ldr w8, [x0, #0x20]
 *
 * の形だが、これを「x0 が指す場所の 0x20 バイト目を読む」と説明しても、
 * 初心者には何のことか分からない。ところが Objective-C のクラス表には
 * メンバ変数の**名前と位置**が残っているので、
 *
 *     -[BattleManager applyDamage:] の中の [x0, #0x20]  →  self._hp（4 バイトの整数）
 *
 * まで戻せる。こうなると「HP を読んでいる」と言える。
 *
 * ここは索引と照合だけを担当する。日本語は作らない（narrate.js の仕事）。
 * 分からないものは null を返す。名前をでっち上げない。
 */

/** 名前の頭の下線とアンダースコアを落として、人が読む形にする。 */
export function plainFieldName(name) {
  return String(name || '').replace(/^_+/, '');
}

export class FieldIndex {
  /**
   * @param {object} model buildObjcModel の返り値
   */
  constructor(model) {
    this.classes = new Map();      // クラス名 -> {name, instanceSize, ivars, byOffset}
    this.methodOwner = new Map();  // 実装アドレス(string) -> owner[]（同一IMP共有を保持）
    this.classOfName = new Map();  // クラス名 -> クラス情報（別名）
    /*
     * 「位置が書いてある場所」→ フィールド。
     * いまのコンパイラは `ldr x0, [x0, x8]` と書き、+0x20 は x8 に読み込む。
     * その x8 の出どころ（_OBJC_IVAR_$_Class._field）が分かれば、
     * ずらし幅が命令に出ていなくてもフィールドを名指しできる。
     */
    this.byOffsetVar = new Map();  // アドレス(string) -> {className, field}
    this.fieldCount = 0;

    const list = (model && model.classes) || [];
    for (const c of list) {
      if (!c || !c.name) continue;
      const byOffset = new Map();
      for (const iv of c.ivars || []) {
        if (iv.offset != null && Number.isFinite(Number(iv.offset))) byOffset.set(Number(iv.offset), iv);
        if (iv.offsetVar != null) {
          this.byOffsetVar.set(iv.offsetVar.toString(), { className: c.name, field: iv });
        }
        this.fieldCount++;
      }
      /*
       * 宣言されたプロパティを ivar に結びつける。
       * 属性の V に裏の ivar 名が入っているので、`hp` ⇄ `_hp` の対応がそのまま取れる。
       * これで「表に書いてある名前」が 2 通りになり、片方が潰されていても拾える。
       */
      const propByIvar = new Map();
      for (const p of c.properties || []) {
        const key = p.ivar || ('_' + p.name);
        if (!propByIvar.has(key)) propByIvar.set(key, p);
      }
      for (const iv of c.ivars || []) {
        const p = propByIvar.get(iv.name);
        if (p) {
          iv.property = p;
          // 宣言された型の方が具体的なら、そちらも持っておく（上書きはしない）
          if (p.type && (!iv.type || iv.type.kind === 'unknown')) iv.declaredType = p.type;
        }
      }

      const entry = {
        name: c.name,
        superName: c.superName || null,
        instanceSize: c.instanceSize || 0,
        ivars: c.ivars || [],
        properties: c.properties || [],
        propertyByIvar: propByIvar,
        byOffset,
        methods: c.methods || [],
        classMethods: c.classMethods || [],
        addr: c.addr,
      };
      this.classes.set(c.name, entry);
      this.classOfName.set(c.name, entry);
      /* If an Objective-C selector is exactly a declared ivar/property accessor,
         retain that relationship on the method owner. The implementation may
         delegate through KVO/lazy-init helpers and never directly touch the ivar,
         but the runtime metadata still states what `foo` / `setFoo:` means. */
      const accessorField = (sel) => {
        const text = String(sel || '');
        let plain = null;
        const sm = /^set(.+):$/.exec(text);
        if (sm && sm[1]) plain = sm[1];
        else if (text && !text.includes(':')) plain = text;
        if (!plain) return null;
        const want = plain.replace(/^_+/, '').toLowerCase();
        for (const iv of c.ivars || []) {
          const names = [iv.name, iv.property && iv.property.name]
            .filter(Boolean).map((x) => plainFieldName(x).toLowerCase());
          if (names.includes(want)) return iv;
        }
        return null;
      };
      for (const m of (c.methods || []).concat(c.classMethods || [])) {
        if (m.addr == null) continue;
        const key = m.addr.toString();
        const owner = {
          className: c.name, sel: m.sel || null, kind: m.kind || '-',
          accessorField: accessorField(m.sel),
        };
        const owners = this.methodOwner.get(key) || [];
        if (!owners.some((x) => x.className === owner.className && x.sel === owner.sel && x.kind === owner.kind)) owners.push(owner);
        this.methodOwner.set(key, owners);
      }
    }
  }

  get classCount() { return this.classes.size; }

  /** この関数はどのクラスのメソッドか。共有IMPなら曖昧さを明示する。 */
  ownerOf(funcAddr) {
    const owners = this.ownersOf(funcAddr);
    if (!owners.length) return null;
    if (owners.length === 1) return owners[0];
    return { className: null, sel: null, kind: null, accessorField: null, ambiguous: true, owners };
  }

  /** 同じIMPを共有する全owner。呼び出し側が文脈で絞り込めるよう保持する。 */
  ownersOf(funcAddr) {
    if (funcAddr == null) return [];
    return (this.methodOwner.get(funcAddr.toString()) || []).slice();
  }

  /** クラスの情報。 */
  classInfo(name) { return this.classes.get(name) || null; }

  /**
   * そのクラスの、その位置にあるフィールド。
   * ちょうど一致しなければ、その位置を含むフィールドを探す（構造体の途中を触る形）。
   */
  fieldAt(className, offset) {
    if (offset == null) return null;
    const off = Number(offset);
    if (!Number.isFinite(off)) return null;
    const visited = new Set();
    let currentName = className;
    let depth = 0;
    while (currentName && depth++ < 256) {
      if (visited.has(currentName)) return null;
      visited.add(currentName);
      const c = this.classes.get(currentName);
      if (!c) return null;
      const exact = c.byOffset.get(off);
      if (exact) return { field: exact, className: currentName, exact: true, delta: 0 };
      for (const iv of c.ivars) {
        if (iv.offset == null || !Number.isFinite(Number(iv.offset))) continue;
        const ivOffset = Number(iv.offset);
        const size = iv.size || (iv.type && iv.type.bytes) || 0;
        if (size > 0 && off > ivOffset && off < ivOffset + size) {
          return { field: iv, className: currentName, exact: false, delta: off - ivOffset };
        }
      }
      const firstLocated = c.ivars.find((iv) => iv.offset != null && Number.isFinite(Number(iv.offset)));
      const firstOwnOffset = firstLocated ? Number(firstLocated.offset) : c.instanceSize;
      if (!c.superName || !(off < firstOwnOffset)) return null;
      currentName = c.superName;
    }
    return null;
  }

  /**
   * 名前でフィールドを探す。「HP を探したい」の受け口。
   * @param {RegExp|string} query
   * @returns {Array<{className:string, field:object}>}
   */
  findFields(query, limit = 200) {
    const re = query instanceof RegExp ? query : new RegExp(escapeRe(String(query)), 'i');
    const out = [];
    for (const c of this.classes.values()) {
      for (const iv of c.ivars) {
        re.lastIndex = 0;
        if (!re.test(iv.name)) continue;
        out.push({ className: c.name, field: iv });
        if (out.length >= limit) return out;
      }
    }
    return out;
  }

  /** クラスを名前で探す。 */
  findClasses(query, limit = 200) {
    const re = query instanceof RegExp ? query : new RegExp(escapeRe(String(query)), 'i');
    const out = [];
    for (const c of this.classes.values()) {
      re.lastIndex = 0;
      if (re.test(c.name)) out.push(c);
      if (out.length >= limit) break;
    }
    return out;
  }

  /**
   * 命令 1 つのメモリアクセスを、フィールドとして解決する。
   *
   * self（x0）を経由したアクセスだけを対象にする。
   * ほかのレジスタは何を指しているか分からないので、**推測で当てはめない**。
   *
   * @param {object} access {base:'x0', disp:BigInt}
   * @param {string} className この関数が属するクラス
   */
  /**
   * 「位置が書いてある場所」からフィールドを引く。
   * `adrp/ldr` で _OBJC_IVAR_$_… を読んだアドレスをそのまま渡す。
   */
  fieldAtOffsetVar(addr) {
    if (addr == null) return null;
    return this.byOffsetVar.get(addr.toString()) || null;
  }

  resolveAccess(access, className) {
    if (!access) return null;
    /*
     * 位置変数ごしのアクセス（いまの Objective-C の普通の形）。
     * ここはクラス名が分からなくても解ける — 変数そのものがクラスを名乗っている。
     */
    if (access.indexAddr != null) {
      const via = this.fieldAtOffsetVar(access.indexAddr);
      if (via) {
        return {
          className: via.className,
          name: via.field.name,
          plain: plainFieldName(via.field.name),
          offset: via.field.offset,
          size: via.field.size,
          type: via.field.type,
          exact: true,
          certain: access.self === true || className === via.className,
          viaRegister: access.base,
          viaOffsetVar: true,
        };
      }
    }
    if (!className) return null;
    /*
     * self がどのレジスタに載っているかは、呼ぶ側が dataflow で追ってから渡す。
     * それが無いときだけ、よく使われる 3 本を当てにする（推測なので certain は付けない）。
     */
    if (access.self !== true &&
        access.base !== 'x0' && access.base !== 'x19' && access.base !== 'x20') return null;
    if (access.disp == null) return null;
    const hit = this.fieldAt(className, access.disp);
    if (!hit) return null;
    return {
      className: hit.className,
      name: hit.field.name,
      plain: plainFieldName(hit.field.name),
      offset: hit.field.offset,
      size: hit.field.size,
      type: hit.field.type,
      exact: hit.exact,
      // A physical x0 name is not provenance: a call or definition may have replaced entry self.
      certain: access.self === true,
      viaRegister: access.base,
    };
  }
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

export const EMPTY_FIELDS = new FieldIndex(null);
