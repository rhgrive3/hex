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
const CLASS_DATA = 32;          // class_t.data — 下位ビットはフラグ
const RO_NAME = 24;             // class_ro_t.name
const RO_METHODS = 32;          // class_ro_t.baseMethods
const RO_SIZE = 40;
const CLASS_SIZE = 40;

const REL_FLAG = 0x80000000;    // method_list_t.entsize の「相対形式」の印
const ENTSIZE_MASK = 0xfffc;

const MAX_CLASSES = 20000;
const MAX_METHODS = 60000;
const MAX_NAME = 200;

/**
 * ポインタとして読む。
 *
 * 最近の Mach-O はポインタをそのまま持たず、起動時に埋める形（chained fixups）で
 * 書いてある。上位ビットに印が入るので、素直に読めなければ下位だけを見る。
 * 0 や、どう見てもアドレスでないものは null（読めないものを読めたことにしない）。
 */
export function sanitizePointer(v) {
  if (v === 0n) return null;
  if (v < 0x0001000000000000n) return v;
  const low = v & 0x0000000fffffffffn;
  return low === 0n ? null : low;
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
  return async function get(addr, len) {
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
      if (!buf || off + len > buf.length) return null;
      return buf.subarray(off, off + len);
    }
    const direct = await read(addr, len);
    return direct && direct.length >= len ? direct.subarray(0, len) : null;
  };
}

/** 0 で終わる文字列を読む。読めなければ null。 */
async function cstring(get, addr) {
  if (addr == null) return null;
  const buf = await get(addr, MAX_NAME);
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

async function pointer(get, addr) {
  const b = await get(addr, PTR);
  return b ? sanitizePointer(u64(b, 0)) : null;
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
  const relative = (entsize & REL_FLAG) !== 0;
  const stride = entsize & ENTSIZE_MASK;
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
      // まずは「名前を指すポインタ」として読み、だめなら名前そのものとして読む
      nameAddr = await pointer(get, nameTarget);
      if (nameAddr == null) nameAddr = nameTarget;
      const viaPtr = await cstring(get, nameAddr);
      if (viaPtr == null) nameAddr = nameTarget;
    } else {
      nameAddr = sanitizePointer(u64(b, 0));
      imp = sanitizePointer(u64(b, 16));
    }
    if (imp == null) continue;
    const sel = await cstring(get, nameAddr);
    if (!sel) continue;                          // 名前が読めないなら付けない
    out.push({ addr: imp, name: prefix + '[' + className + ' ' + sel + ']' });
  }
}

/** クラス 1 つぶん（インスタンスメソッドとクラスメソッドの両方）。 */
async function readClass(get, classAddr, out, seen, meta) {
  if (classAddr == null || seen.has(classAddr.toString())) return null;
  seen.add(classAddr.toString());

  const cls = await get(classAddr, CLASS_SIZE);
  if (!cls) return null;
  const roAddr = sanitizePointer(u64(cls, CLASS_DATA) & ~7n);
  if (roAddr == null) return null;
  const ro = await get(roAddr, RO_SIZE);
  if (!ro) return null;

  const name = await cstring(get, sanitizePointer(u64(ro, RO_NAME)));
  if (!name) return null;

  await readMethods(get, sanitizePointer(u64(ro, RO_METHODS)), out, name,
    meta ? '+' : '-', MAX_METHODS);

  // isa はメタクラス。そちらにクラスメソッド（+）が入っている。
  if (!meta) {
    const isa = sanitizePointer(u64(cls, CLASS_ISA));
    if (isa != null) await readClass(get, isa, out, seen, true);
  }
  return name;
}

/**
 * __objc_classlist をたどって、実装アドレス → 名前 の一覧を作る。
 *
 * @param {function} read  async (addr:BigInt, len:number) => Uint8Array|null
 * @param {{vmAddr:BigInt, size:BigInt}} classList  __objc_classlist の範囲
 * @param {function} [onProgress]
 * @returns {Promise<{names:Array<{addr:BigInt,name:string}>, classes:number}>}
 */
export async function buildObjcNames(read, classList, onProgress) {
  const out = [];
  const seen = new Set();
  let classes = 0;
  if (!classList || !classList.size) return { names: out, classes: 0 };

  const get = pagedReader(read);
  const total = Math.min(Number(classList.size) / PTR, MAX_CLASSES);

  for (let i = 0; i < total && out.length < MAX_METHODS; i++) {
    const slot = classList.vmAddr + BigInt(i) * BigInt(PTR);
    let ptr;
    try { ptr = await pointer(get, slot); } catch { break; }
    if (ptr == null) continue;
    try {
      if (await readClass(get, ptr, out, seen, false)) classes++;
    } catch { /* 1 クラス壊れていても、残りは読む */ }
    if (onProgress && (i & 63) === 0) onProgress(i / total);
  }
  if (onProgress) onProgress(1);
  return { names: out, classes };
}
