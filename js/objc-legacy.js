/*
 * Objective-C のクラス表を読んで、関数に本当の名前を戻す。
 *
 * 配布用のアプリは自作の関数名を削ってあるので、関数一覧は sub_100123456 だらけになる。
 * ところが Objective-C のメソッドは、実行時にクラス名とメソッド名で探せる必要があるため、
 * **名前と実装アドレスの対応表がバイナリの中に必ず残っている**。これを読めば
 *
 *   sub_100123456  →  -[LoginViewController loginButtonTapped:]
 *
 * まで戻せる。「この関数はアプリの何をしているのか」に対する、いちばん強い答え。
 *
 * ここは読み取りだけを担当し、ファイルへの実際のアクセスは呼び出し側から
 * read(addr, len) として渡してもらう（worker でも node のテストでも動くように）。
 *
 * 読めなかったものは、いっさい名前を付けずに黙って飛ばす。
 * 表の形が想定と違うときに、でたらめな名前を付けるのがいちばん困るため。
 */

/* ── 構造体の中の位置（64 ビット） ────────────────────────── */

const PTR = 8;
const CLASS_ISA = 0;
const CLASS_SUPER = 8;          // class_t.superclass
const CLASS_DATA = 32;          // class_t.data — 下位ビットはフラグ
const RO_INSTANCE_SIZE = 8;     // class_ro_t.instanceSize
const RO_NAME = 24;             // class_ro_t.name
const RO_METHODS = 32;          // class_ro_t.baseMethods
const RO_IVARS = 48;            // class_ro_t.ivars ← ここが「フィールドの名前」の在り処
const RO_PROPS = 64;            // class_ro_t.baseProperties ← 宣言された名前と型
const RO_SIZE = 72;             // baseProperties まで読むのに必要な長さ
const CLASS_SIZE = 40;

const PROP_STRIDE = 16;         // property_t = name* + attributes*
const MAX_PROPS = 400;

const IVAR_STRIDE_MIN = 32;     // ivar_t = offset* + name* + type* + alignment + size
const MAX_IVARS = 400;

const REL_FLAG = 0x80000000;    // relative/small method entries
const DIRECT_SEL_FLAG = 0x40000000; // selector field points directly at cstring
const ENTSIZE_MASK = 0xfffc;
export function decodeMethodListHeader(rawEntsize) {
  const raw=Number(rawEntsize)>>>0;
  return { relative:!!(raw&REL_FLAG), directSelector:!!(raw&DIRECT_SEL_FLAG), stride:raw&ENTSIZE_MASK };
}

const MAX_CLASSES = 20000;
const MAX_METHODS = 60000;
const MAX_NAME = 512;

/**
 * ポインタとして読む。
 *
 * iOS 15 以降のアプリは、ポインタをそのままの形では持っていない。
 * 起動時に dyld が埋める形（chained fixups）で書いてあって、1 個の 64 ビットが
 * こうなっている:
 *
 *     bit 63     … 1 なら「他のライブラリの記号を入れる」（bind）
 *     bit 51-62  … 次のポインタまでの距離
 *     bit 36-43  … アドレスの上位 8 ビット
 *     bit  0-35  … **イメージの先頭からの距離**（アドレスそのものではない）
 *
 * つまり下位 36 ビットを取り出しただけでは、イメージの先頭（ふつう 0x100000000）が
 * 抜け落ちる。0x1018a13a8 のつもりが 0x18a13a8 になり、そこには何も無いので
 * クラス表が 1 個も読めない。ここを取り違えると、このツールでいちばん効く
 * 「値の名前が残っている表」がまるごと失われる。
 *
 * @param {BigInt} v      その 8 バイトをそのまま読んだ値
 * @param {BigInt} [base] イメージの先頭（__TEXT の vmaddr）。無ければ足さない。
 */
export function sanitizePointer(v, base, pointerFormat = null) {
  if (v === 0n) return null;
  const format = pointerFormat == null ? null : Number(pointerFormat);
  if (format === 2 || format === 6) {
    if (((v >> 63n) & 1n) !== 0n) return null;
    const target = v & 0xfffffffffn;
    if (format === 6) return base == null ? null : BigInt(base) + target;
    const high8 = (v >> 36n) & 0xffn;
    return target | (high8 << 56n);
  }
  if (format != null) return null;
  /* Some modern Mach-O metadata fields contain a bare image-relative offset
     without the chained-pointer next/high bits.  When the image base is known,
     a non-zero value below that base cannot be a valid in-image VM address;
     interpret it as the same image-relative form instead of trying to read
     page zero.  Plain legacy VM pointers remain unchanged because they are
     already >= base. */
  if (base != null && v < BigInt(base)) return BigInt(base) + v;
  if (v < 0x0001000000000000n) return v;          // 素のポインタ（古い形式）
  const low = v & 0x0000000fffffffffn;
  if (low === 0n) return null;

  /*
   * 最上位ビットは「他のライブラリの記号を入れる」印（bind）。
   * そこに書いてあるのはアドレスではなく取り込み表の番号なので、
   * このファイルの中を指しているようには見えないなら、読めたことにしない。
   * （親クラスが NSObject のときにここへ来る。番号をアドレスと取り違えると、
   *   たまたま同じ値だった別のクラスを親として拾ってしまう。）
   */
  if (v & 0x8000000000000000n) {
    return (base == null || low >= base) ? low : null;
  }

  /*
   * 形式が 2 つある。target にアドレスそのものが入っているもの（DYLD_CHAINED_PTR_64）と、
   * イメージ先頭からの距離が入っているもの（同 _64_OFFSET）。
   * 距離のほうは必ずイメージ先頭より小さいので、そこで見分けられる。
   */
  if (base != null && low < base) return base + low;
  return low;
}

function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }
function i32(b, o) { return u32(b, o) | 0; }
function u64(b, o) {
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(b[o + i]);
  return v;
}

/**
 * read(addr, len) を、64 KiB ごとにまとめて読むように包む。
 * クラス表は飛び飛びに読むので、素直に呼ぶと往復が多くなりすぎる。
 */
export function pagedReader(read, pageBytes = 65536, maxPages = 96) {
  const pages = new Map();
  const direct = async (addr, len, soft) => {
    const got = await read(addr, len);
    if (!got || !got.length) return null;
    // soft: 短くても受け取る（0 で終わる文字列は、区画の端に置かれていることがある）
    if (got.length >= len) return got.subarray(0, len);
    return soft ? got : null;
  };
  return async function get(addr, len, soft) {
    if (addr == null || len <= 0) return null;
    const page = (addr / BigInt(pageBytes)) * BigInt(pageBytes);
    const off = Number(addr - page);
    if (off + len <= pageBytes) {
      const key = page.toString();
      let buf = pages.get(key);
      if (buf === undefined) {
        buf = await read(page, pageBytes);
        if (pages.size >= maxPages) pages.delete(pages.keys().next().value);
        pages.set(key, buf || null);
      }
      if (buf && off + len <= buf.length) return buf.subarray(off, off + len);
      if (soft && buf && off < buf.length) return buf.subarray(off);
      /*
       * まとめ読みが途中で切れることがある（区画の境目をまたいだとき）。
       * クラス表は区画をまたいで散らばっているので、その場合は
       * 必要なぶんだけ読み直す。ここで諦めると、名前がまるごと取れなくなる。
       */
      return direct(addr, len, soft);
    }
    return direct(addr, len, soft);
  };
}

/** 0 で終わる文字列を読む。読めなければ null。 */
async function cstring(get, addr) {
  if (addr == null) return null;
  // 区画の端に置かれた名前も読めるように、短い読み取りも受け取る
  const buf = await get(addr, MAX_NAME, true);
  if (!buf) return null;
  let s = '';
  for (let i = 0; i < buf.length; i++) {
    const c = buf[i];
    if (c === 0) return s.length ? s : null;
    if (c < 0x20 || c >= 0x7f) return null;      // 読めない → 名前ではない
    s += String.fromCharCode(c);
  }
  return null;                                   // 終端が見つからない
}

function cleanPointer(get, value) { return sanitizePointer(value, get.base, get.pointerFormat); }

async function pointer(get, addr) {
  const b = await get(addr, PTR);
  return b ? cleanPointer(get, u64(b, 0)) : null;
}

/**
 * メソッド一覧を読む。
 *
 * 形式が 2 つある。
 *   従来型: 1 件 24 バイト（名前・型・実装のポインタが 3 本）
 *   相対型: 1 件 12 バイト（それぞれの位置からの差で書く。iOS 14 以降はこちら）
 * 相対型の「名前」は、名前そのものではなく名前を指すポインタを指していることがある
 * ので、1 段たどってみて、だめなら直接読む。
 */
async function readMethods(get, listAddr, out, className, prefix, budget) {
  if (listAddr == null) return;
  const head = await get(listAddr, 8);
  if (!head) return;
  const entsize = u32(head, 0);
  const count = u32(head, 4);
  if (!count || count > 20000) return;
  const { relative, directSelector, stride } = decodeMethodListHeader(entsize);
  if (relative ? stride < 12 : stride < 24) return;

  for (let i = 0; i < count && out.length < budget; i++) {
    const entry = listAddr + 8n + BigInt(i) * BigInt(stride);
    const b = await get(entry, relative ? 12 : 24);
    if (!b) return;

    let nameAddr = null;
    let imp = null;
    if (relative) {
      const nameField = entry + 0n;
      const impField = entry + 8n;
      const nameTarget = nameField + BigInt(i32(b, 0));
      imp = impField + BigInt(i32(b, 8));
      if (directSelector) nameAddr = nameTarget;
      else {
        nameAddr = await pointer(get, nameTarget);
        if (nameAddr == null || await cstring(get, nameAddr) == null) nameAddr = nameTarget;
      }
    } else {
      nameAddr = cleanPointer(get, u64(b, 0));
      imp = cleanPointer(get, u64(b, 16));
    }
    if (imp == null) continue;
    const sel = await cstring(get, nameAddr);
    if (!sel) continue;                          // 名前が読めないなら付けない
    out.push({
      addr: imp,
      name: prefix + '[' + className + ' ' + sel + ']',
      sel, kind: prefix, className,
    });
  }
}

/* ── フィールド（ivar）──────────────────────────────────────
 *
 * ここがこのファイルでいちばん価値のある部分。
 *
 * Objective-C のクラスには、**メンバ変数の名前・型・位置**の表が必ず残っている。
 * これを読むと、逆アセンブルに出てくる
 *
 *     ldr w8, [x0, #0x20]
 *
 * が「self の _hp（4 バイトの整数）を読み込む」に変わる。
 * 「x0 + 0x20 の値」と言われても初心者には何のことか分からないが、
 * 「HP を読み込んでいる」なら誰にでも分かる。この差はとても大きい。
 */

/**
 * 型エンコーディング（"i" や "@\"NSString\"" など）を、意味の分かる形にする。
 * 読めなければ kind:'unknown'。適当な名前は付けない。
 */
export function decodeTypeEncoding(enc) {
  const s = String(enc || '').trim();
  if (!s) return { kind: 'unknown', enc: s };
  const c = s[0];
  switch (c) {
    case 'c': return { kind: 'int', bytes: 1, signed: true, enc: s };
    case 'C': return { kind: 'int', bytes: 1, signed: false, enc: s };
    case 'B': return { kind: 'bool', bytes: 1, enc: s };
    case 's': return { kind: 'int', bytes: 2, signed: true, enc: s };
    case 'S': return { kind: 'int', bytes: 2, signed: false, enc: s };
    case 'i': return { kind: 'int', bytes: 4, signed: true, enc: s };
    case 'I': return { kind: 'int', bytes: 4, signed: false, enc: s };
    case 'l': return { kind: 'int', bytes: 4, signed: true, enc: s };
    case 'L': return { kind: 'int', bytes: 4, signed: false, enc: s };
    case 'q': return { kind: 'int', bytes: 8, signed: true, enc: s };
    case 'Q': return { kind: 'int', bytes: 8, signed: false, enc: s };
    case 'f': return { kind: 'float', bytes: 4, enc: s };
    case 'd': return { kind: 'float', bytes: 8, enc: s };
    case '*': return { kind: 'cstring', bytes: 8, enc: s };
    case '#': return { kind: 'class', bytes: 8, enc: s };
    case ':': return { kind: 'selector', bytes: 8, enc: s };
    case '^': return { kind: 'pointer', bytes: 8, enc: s, to: s.slice(1) };
    case '{': {
      const name = /^\{([^=}]*)/.exec(s);
      return { kind: 'struct', enc: s, name: name ? name[1] : null };
    }
    case '[': return { kind: 'array', enc: s };
    case '@': {
      const m = /^@"([^"]+)"/.exec(s);
      if (m) return { kind: 'object', bytes: 8, enc: s, className: m[1] };
      if (s === '@?') return { kind: 'block', bytes: 8, enc: s };
      return { kind: 'object', bytes: 8, enc: s, className: null };
    }
    default: return { kind: 'unknown', enc: s };
  }
}

/** ivar のオフセットは、__objc_ivar に置かれた変数の中身。1 段たどって読む。 */
async function ivarOffset(get, slotAddr) {
  if (slotAddr == null) return null;
  const b = await get(slotAddr, 4);
  if (!b) return null;
  // 実体は 32 ビットだが、8 バイト確保されていることがある。下位 32 ビットを読む。
  const v = u32(b, 0);
  if (v > 0x100000) return null;              // クラスの大きさとしてありえない
  return v;
}

/** ivar_list_t を読む。読めない項目は黙って飛ばす。 */
async function readIvars(get, listAddr) {
  const out = [];
  if (listAddr == null) return out;
  const head = await get(listAddr, 8);
  if (!head) return out;
  const entsize = u32(head, 0);
  const count = u32(head, 4);
  if (!count || count > MAX_IVARS) return out;
  const stride = entsize & 0xffff;
  if (stride < IVAR_STRIDE_MIN) return out;

  for (let i = 0; i < count; i++) {
    const entry = listAddr + 8n + BigInt(i) * BigInt(stride);
    const b = await get(entry, IVAR_STRIDE_MIN);
    if (!b) break;
    /*
     * 位置そのものではなく「位置が書いてある場所」も覚えておく。
     *
     * いまの Objective-C は、フィールドの位置を命令に埋め込まない:
     *
     *     adrp x8, _OBJC_IVAR_$_SceneDelegate._window@PAGE
     *     ldr  w8, [x8, …]          ← ここに +0x20 が入っている
     *     ldr  x0, [x0, x8]         ← self の中を、その位置で読む
     *
     * 命令には `#0x20` がどこにも出てこないので、ずらし幅だけを見ていると
     * 「self の何を読んでいるか」が永久に分からない。分かるのは
     * **どの位置変数を読んだか**で、それはこのアドレスで引ける。
     */
    const offsetVar = cleanPointer(get, u64(b, 0));
    const offset = await ivarOffset(get, offsetVar);
    const name = await cstring(get, cleanPointer(get, u64(b, 8)));
    if (!name) continue;                      // 名前が読めないものだけ採らない
    const typeEnc = await cstring(get, cleanPointer(get, u64(b, 16)));
    const size = u32(b, 28);
    out.push({
      name,
      offset,
      offsetVar,
      size: size > 0 && size <= 4096 ? size : null,
      type: decodeTypeEncoding(typeEnc),
    });
  }
  out.sort((a, b2) => {
    if (a.offset == null) return b2.offset == null ? 0 : 1;
    if (b2.offset == null) return -1;
    return a.offset - b2.offset;
  });
  return out;
}

/* ── プロパティ（@property）────────────────────────────────
 *
 * ivar の表と並んで、クラスには **宣言されたプロパティ** の表も残っている。
 * これが効くのは、ivar だけでは分からないことが 2 つ分かるため。
 *
 *   1. 人が書いた名前そのもの。ivar は `_hp` だが、プロパティは `hp`。
 *      さらに `_a1` のように潰された ivar でも、プロパティ名は残ることがある。
 *   2. 宣言された型。ivar の型エンコーディングより詳しいことが多く、
 *      `@"NSNumber"` なのか `i` なのかがはっきりする。
 *
 * 属性の文字列は `Ti,N,V_hp` のような形で、
 *   T… 型エンコーディング / V… 裏で使っている ivar の名前 /
 *   R 読み取り専用 / N nonatomic / & strong / C copy / W weak / G,S 別名のアクセサ
 * が並ぶ。V があれば「プロパティ名 ↔ ivar」の対応がそのまま取れる。
 */

/** `Ti,N,V_hp` をほどく。読めないものは黙って飛ばす。 */
export function parsePropertyAttributes(attr) {
  const out = { type: null, ivar: null, readonly: false, weak: false, getter: null, setter: null };
  const s = String(attr || '');
  if (!s) return out;
  // 型エンコーディングにはカンマが入らない（構造体は {..} の中に入る）ので、
  // 素直に区切ってよい。ただし {} と "" の中の区切りは守る。
  const parts = [];
  let depth = 0, quote = false, cur = '';
  for (const ch of s) {
    if (ch === '"') quote = !quote;
    else if (!quote && (ch === '{' || ch === '(' || ch === '[')) depth++;
    else if (!quote && (ch === '}' || ch === ')' || ch === ']')) depth--;
    if (ch === ',' && depth === 0 && !quote) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur) parts.push(cur);

  for (const p of parts) {
    const k = p[0];
    const v = p.slice(1);
    switch (k) {
      case 'T': out.type = v; break;
      case 'V': out.ivar = v; break;
      case 'R': out.readonly = true; break;
      case 'W': out.weak = true; break;
      case 'G': out.getter = v; break;
      case 'S': out.setter = v; break;
      default: break;
    }
  }
  return out;
}

/** property_list_t を読む。読めない項目は黙って飛ばす。 */
async function readProperties(get, listAddr) {
  const out = [];
  if (listAddr == null) return out;
  const head = await get(listAddr, 8);
  if (!head) return out;
  const entsize = u32(head, 0);
  const count = u32(head, 4);
  if (!count || count > MAX_PROPS) return out;
  const stride = entsize & 0xffff;
  if (stride < PROP_STRIDE) return out;

  for (let i = 0; i < count; i++) {
    const entry = listAddr + 8n + BigInt(i) * BigInt(stride);
    const b = await get(entry, PROP_STRIDE);
    if (!b) break;
    const name = await cstring(get, cleanPointer(get, u64(b, 0)));
    if (!name) continue;
    const attrText = await cstring(get, cleanPointer(get, u64(b, 8)));
    const attrs = parsePropertyAttributes(attrText);
    out.push({
      name,
      ivar: attrs.ivar,
      readonly: attrs.readonly,
      weak: attrs.weak,
      getter: attrs.getter || name,
      setter: attrs.setter || ('set' + name.charAt(0).toUpperCase() + name.slice(1) + ':'),
      type: attrs.type ? decodeTypeEncoding(attrs.type) : null,
      attributes: attrText || null,
    });
  }
  return out;
}

/** クラス 1 つぶん（インスタンスメソッドとクラスメソッドの両方）。 */
async function readClass(get, classAddr, out, seen, meta) {
  if (classAddr == null || seen.has(classAddr.toString())) return null;
  seen.add(classAddr.toString());

  const cls = await get(classAddr, CLASS_SIZE);
  if (!cls) return null;
  const roAddr = cleanPointer(get, u64(cls, CLASS_DATA) & ~7n);
  if (roAddr == null) return null;
  /*
   * 短くても受け取る。baseProperties まで読めるとうれしいが、そこまで
   * 載っていない表もある。「プロパティが読めない」を理由にクラスごと
   * 捨ててしまうと、いちばん大事な ivar の名前まで失う。
   */
  const ro = await get(roAddr, RO_SIZE, true);
  if (!ro || ro.length < RO_IVARS + PTR) return null;

  const name = await cstring(get, cleanPointer(get, u64(ro, RO_NAME)));
  if (!name) return null;

  const before = out.length;
  await readMethods(get, cleanPointer(get, u64(ro, RO_METHODS)), out, name,
    meta ? '+' : '-', MAX_METHODS);
  const methods = out.slice(before);

  const info = {
    name,
    addr: classAddr,
    meta: !!meta,
    superAddr: cleanPointer(get, u64(cls, CLASS_SUPER)),
    instanceSize: u32(ro, RO_INSTANCE_SIZE),
    methods,
    ivars: [],
    properties: [],
  };

  // ivar とプロパティはインスタンス側にしかない（クラスメソッド側には持たせない）
  if (!meta) {
    try {
      info.ivars = await readIvars(get, cleanPointer(get, u64(ro, RO_IVARS)));
    } catch { info.ivars = []; }
    try {
      // 表が短くて baseProperties まで届かないことがある。届かなければ空のまま。
      if (ro.length >= RO_PROPS + PTR) {
        info.properties = await readProperties(get, cleanPointer(get, u64(ro, RO_PROPS)));
      }
    } catch { info.properties = []; }
  }

  // isa はメタクラス。そちらにクラスメソッド（+）が入っている。
  if (!meta) {
    const isa = cleanPointer(get, u64(cls, CLASS_ISA));
    if (isa != null) {
      const metaInfo = await readClass(get, isa, out, seen, true);
      if (metaInfo && metaInfo.methods) info.classMethods = metaInfo.methods;
    }
  }
  return info;
}

/**
 * __objc_classlist をたどって、クラスの一覧をまるごと作る。
 *
 * 返すのは「アプリがどんな部品でできているか」そのもの。
 * 関数を数万個並べる代わりに、この単位で見せるのがこのツールの入口になる。
 *
 * @param {function} read  async (addr:BigInt, len:number) => Uint8Array|null
 * @param {{vmAddr:BigInt, size:BigInt}} classList  __objc_classlist の範囲
 * @param {function} [onProgress]
 * @param {BigInt} [imageBase] イメージの先頭（__TEXT の vmaddr）。
 *   chained fixups のポインタを組み立てるのに要る。渡されなければ
 *   クラス表の位置から推定する（iOS のアプリは 4 GiB 境界に置かれる）。
 */
export async function buildObjcModel(read, classList, onProgress, imageBase, pointerFormat) {
  const names = [];
  const classes = [];
  const seen = new Set();
  if (!classList || !classList.size) return { classes, names, count: 0 };

  const get = pagedReader(read);
  get.base = imageBase != null
    ? BigInt(imageBase)
    : (classList.vmAddr / 0x100000000n) * 0x100000000n;
  get.pointerFormat = pointerFormat ?? classList.pointerFormat ?? classList.pointer_format ?? null;
  const total = Math.min(Number(classList.size) / PTR, MAX_CLASSES);

  for (let i = 0; i < total && names.length < MAX_METHODS; i++) {
    const slot = classList.vmAddr + BigInt(i) * BigInt(PTR);
    let ptr;
    try { ptr = await pointer(get, slot); } catch { break; }
    if (ptr == null) continue;
    try {
      const info = await readClass(get, ptr, names, seen, false);
      if (info) classes.push(info);
    } catch { /* 1 クラス壊れていても、残りは読む */ }
    if (onProgress && (i & 63) === 0) onProgress(i / total);
  }
  if (onProgress) onProgress(1);

  // 親クラスの名前を解決しておく（部品の系統が見えるようにする）
  const byAddr = new Map(classes.map((c) => [c.addr.toString(), c]));
  for (const c of classes) {
    const parent = c.superAddr != null ? byAddr.get(c.superAddr.toString()) : null;
    c.superName = parent ? parent.name : null;
  }
  return { classes, names, count: classes.length };
}

/**
 * 実装アドレス → 名前 の一覧だけが欲しいとき（既存の呼び出し元向け）。
 */
export async function buildObjcNames(read, classList, onProgress, imageBase, pointerFormat) {
  const model = await buildObjcModel(read, classList, onProgress, imageBase, pointerFormat);
  return { names: model.names, classes: model.count };
}
