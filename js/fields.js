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
    this.methodOwner = new Map();  // 実装アドレス(string) -> {className, sel, kind}
    this.classOfName = new Map();  // クラス名 -> クラス情報（別名）
    this.fieldCount = 0;

    const list = (model && model.classes) || [];
    for (const c of list) {
      if (!c || !c.name) continue;
      const byOffset = new Map();
      for (const iv of c.ivars || []) {
        byOffset.set(iv.offset, iv);
        this.fieldCount++;
      }
      const entry = {
        name: c.name,
        superName: c.superName || null,
        instanceSize: c.instanceSize || 0,
        ivars: c.ivars || [],
        byOffset,
        methods: c.methods || [],
        classMethods: c.classMethods || [],
        addr: c.addr,
      };
      this.classes.set(c.name, entry);
      this.classOfName.set(c.name, entry);
      for (const m of (c.methods || []).concat(c.classMethods || [])) {
        if (m.addr == null) continue;
        this.methodOwner.set(m.addr.toString(), {
          className: c.name, sel: m.sel || null, kind: m.kind || '-',
        });
      }
    }
  }

  get classCount() { return this.classes.size; }

  /** この関数はどのクラスのメソッドか。分からなければ null。 */
  ownerOf(funcAddr) {
    if (funcAddr == null) return null;
    return this.methodOwner.get(funcAddr.toString()) || null;
  }

  /** クラスの情報。 */
  classInfo(name) { return this.classes.get(name) || null; }

  /**
   * そのクラスの、その位置にあるフィールド。
   * ちょうど一致しなければ、その位置を含むフィールドを探す（構造体の途中を触る形）。
   */
  fieldAt(className, offset) {
    const c = this.classes.get(className);
    if (!c || offset == null) return null;
    const off = Number(offset);
    const exact = c.byOffset.get(off);
    if (exact) return { field: exact, className, exact: true, delta: 0 };
    for (const iv of c.ivars) {
      const size = iv.size || (iv.type && iv.type.bytes) || 0;
      if (size > 0 && off > iv.offset && off < iv.offset + size) {
        return { field: iv, className, exact: false, delta: off - iv.offset };
      }
    }
    // 親クラスの領域（自分の ivar の手前）は、親が持っている
    if (c.superName && off < (c.ivars.length ? c.ivars[0].offset : c.instanceSize)) {
      const up = this.fieldAt(c.superName, offset);
      if (up) return up;
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
  resolveAccess(access, className) {
    if (!access || !className) return null;
    if (access.base !== 'x0' && access.base !== 'x19' && access.base !== 'x20') return null;
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
      // self そのものだと確定できるのは x0 のときだけ。他は「その可能性がある」。
      certain: access.base === 'x0',
      viaRegister: access.base,
    };
  }
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

export const EMPTY_FIELDS = new FieldIndex(null);
