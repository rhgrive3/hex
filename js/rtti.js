/*
 * C++ と Swift の名前を、人が読める形に戻す。
 *
 * リンカが残す名前は、そのままでは記号の羅列です:
 *
 *   __ZN9BattleCat6attackEii   →   BattleCat::attack(int, int)
 *   $s5MyApp6PlayerC4heals5Int32VvG → MyApp.Player.hp
 *
 * これを「マングル解除（demangle）」といいます。IDA でも自動でやっている処理で、
 * 名前が読めるようになるだけで解析の速さが何倍も変わります。
 *
 * さらに、C++ のクラスは実行時型情報（RTTI）と仮想関数テーブル（vtable）を
 * バイナリに残します。ここからは
 *   - クラスの名前と継承関係
 *   - そのクラスが持つ仮想関数の一覧（何番目のスロットが何か）
 * が取り出せます。オブジェクト指向のアプリを読むときの地図になります。
 */

/* ── Itanium C++ ABI のマングル解除 ─────────────────────── */

const BUILTIN = {
  v: 'void', b: 'bool', c: 'char', a: 'signed char', h: 'unsigned char',
  s: 'short', t: 'unsigned short', i: 'int', j: 'unsigned int',
  l: 'long', m: 'unsigned long', x: 'long long', y: 'unsigned long long',
  n: '__int128', o: 'unsigned __int128', f: 'float', d: 'double', e: 'long double',
  z: '...', Ds: 'char8_t', Di: 'char32_t', Du: 'char16_t', Dn: 'decltype(nullptr)',
};

const SUBSTITUTIONS = {
  St: 'std', Sa: 'std::allocator', Sb: 'std::basic_string',
  Ss: 'std::string', Si: 'std::istream', So: 'std::ostream', Sd: 'std::iostream',
};

const OPERATORS = {
  nw: 'operator new', na: 'operator new[]', dl: 'operator delete', da: 'operator delete[]',
  ps: 'operator+', ng: 'operator-', ad: 'operator&', de: 'operator*', co: 'operator~',
  pl: 'operator+', mi: 'operator-', ml: 'operator*', dv: 'operator/', rm: 'operator%',
  an: 'operator&', or: 'operator|', eo: 'operator^', aS: 'operator=',
  pL: 'operator+=', mI: 'operator-=', mL: 'operator*=', dV: 'operator/=',
  ls: 'operator<<', rs: 'operator>>', eq: 'operator==', ne: 'operator!=',
  lt: 'operator<', gt: 'operator>', le: 'operator<=', ge: 'operator>=',
  nt: 'operator!', aa: 'operator&&', oo: 'operator||', pp: 'operator++', mm: 'operator--',
  cm: 'operator,', ix: 'operator[]', cl: 'operator()', pt: 'operator->',
};

/**
 * C++ のマングル名を読める形に戻す。
 * 完全な実装ではありません（テンプレートの一部などはそのまま残します）が、
 * 実際のアプリに出てくる形はおおむねカバーしています。
 *
 * @returns {string|null} 戻せなければ null
 */
export function demangleCxx(name) {
  if (!name) return null;
  let s = name.replace(/^_/, '');
  if (!s.startsWith('_Z')) return null;
  const p = { s, i: 2, subs: [] };
  try {
    const special = readSpecial(p);
    const body = readName(p);
    if (!body) return null;
    let out = special ? special.replace('{}', body) : body;
    if (p.i < p.s.length && !special) {
      const args = readArgs(p);
      if (args != null) {
        // const は関数の後ろに付く（Json::Value::asString() const）
        const m = /^(.*?)( const)$/.exec(out);
        out = m ? m[1] + '(' + args + ')' + m[2] : out + '(' + args + ')';
      }
    }
    return out;
  } catch { return null; }
}

function readSpecial(p) {
  const two = p.s.slice(p.i, p.i + 2);
  const map = {
    TV: 'vtable for {}', TT: 'VTT for {}', TI: 'typeinfo for {}', TS: 'typeinfo name for {}',
    GV: 'guard variable for {}', Th: 'thunk to {}',
  };
  if (map[two]) { p.i += 2; return map[two]; }
  return null;
}

function readName(p) {
  const c = p.s[p.i];
  const two = p.s.slice(p.i, p.i + 2);
  // 演算子だけの名前（operator new / operator delete）
  if (OPERATORS[two] && !/\d/.test(p.s[p.i])) { p.i += 2; return OPERATORS[two]; }
  if (c === 'N') { p.i++; return readNested(p); }
  if (c === 'S') return readSubstitution(p);
  if (/\d/.test(c)) return readSourceName(p);
  if (c === 'L') { p.i++; return readName(p); }          // 内部リンケージ
  return null;
}

function readNested(p) {
  const parts = [];
  let cvr = '';
  while (p.i < p.s.length && /[rVK]/.test(p.s[p.i])) {
    if (p.s[p.i] === 'K') cvr = ' const';
    p.i++;
  }
  while (p.i < p.s.length && p.s[p.i] !== 'E') {
    const c = p.s[p.i];
    if (/\d/.test(c)) { parts.push(readSourceName(p)); continue; }
    if (c === 'S') { parts.push(readSubstitution(p)); continue; }
    if (c === 'C') { p.i += 2; parts.push(parts[parts.length - 1] || 'ctor'); continue; }
    if (c === 'D') { p.i += 2; parts.push('~' + (parts[parts.length - 1] || 'dtor')); continue; }
    if (OPERATORS[p.s.slice(p.i, p.i + 2)]) { parts.push(OPERATORS[p.s.slice(p.i, p.i + 2)]); p.i += 2; continue; }
    if (c === 'I') { parts.push(readTemplateArgs(p)); continue; }
    break;
  }
  if (p.s[p.i] === 'E') p.i++;
  const joined = parts.filter(Boolean).reduce((acc, cur) =>
    (cur.startsWith('<') ? acc + cur : (acc ? acc + '::' + cur : cur)), '');
  return joined + cvr;
}

function readSourceName(p) {
  let n = '';
  while (p.i < p.s.length && /\d/.test(p.s[p.i])) n += p.s[p.i++];
  const len = Number(n);
  if (!len || p.i + len > p.s.length) return null;
  const out = p.s.slice(p.i, p.i + len);
  p.i += len;
  p.subs.push(out);
  return out;
}

function readSubstitution(p) {
  const two = p.s.slice(p.i, p.i + 2);
  if (SUBSTITUTIONS[two]) { p.i += 2; return SUBSTITUTIONS[two]; }
  // S_ / S0_ / S1_ … 直前に出た名前の使い回し
  p.i++;
  let idx = '';
  while (p.i < p.s.length && p.s[p.i] !== '_') idx += p.s[p.i++];
  p.i++;
  const n = idx === '' ? 0 : parseInt(idx, 36) + 1;
  return p.subs[n] || 'auto';
}

function readTemplateArgs(p) {
  p.i++;                                    // 'I'
  const args = [];
  let guard = 0;
  while (p.i < p.s.length && p.s[p.i] !== 'E' && guard++ < 64) {
    const t = readType(p);
    if (!t) break;
    args.push(t);
  }
  if (p.s[p.i] === 'E') p.i++;
  return '<' + args.join(', ') + '>';
}

function readArgs(p) {
  const args = [];
  let guard = 0;
  while (p.i < p.s.length && guard++ < 64) {
    const t = readType(p);
    if (!t) break;
    args.push(t);
  }
  if (!args.length) return null;
  if (args.length === 1 && args[0] === 'void') return '';
  return args.join(', ');
}

function readType(p) {
  const c = p.s[p.i];
  if (!c) return null;
  if (c === 'P') { p.i++; const t = readType(p); return t ? t + ' *' : null; }
  if (c === 'R') { p.i++; const t = readType(p); return t ? t + ' &' : null; }
  if (c === 'O') { p.i++; const t = readType(p); return t ? t + ' &&' : null; }
  if (c === 'K') { p.i++; const t = readType(p); return t ? 'const ' + t : null; }
  if (c === 'V') { p.i++; const t = readType(p); return t ? 'volatile ' + t : null; }
  if (c === 'N') { p.i++; return readNested(p); }
  if (c === 'S') return readSubstitution(p);
  if (c === 'I') return readTemplateArgs(p);
  if (/\d/.test(c)) return readSourceName(p);
  const two = p.s.slice(p.i, p.i + 2);
  if (BUILTIN[two]) { p.i += 2; return BUILTIN[two]; }
  if (BUILTIN[c]) { p.i++; return BUILTIN[c]; }
  if (c === 'E') return null;
  p.i++;
  return null;
}

/* ── Swift のマングル解除（よく出る形だけ） ───────────────── */

const SWIFT_KIND = {
  C: 'class', V: 'struct', O: 'enum', P: 'protocol',
  F: 'func', vg: 'getter', vs: 'setter', fC: 'init', fD: 'deinit',
};

/**
 * Swift の名前をざっくり読む。
 * 完全な復元はしません（Swift のマングルは非常に複雑なため）が、
 * 「どのモジュールの、どの型の、何というメソッドか」までは取り出します。
 */
export function demangleSwift(name) {
  if (!name) return null;
  const s = name.replace(/^_/, '');
  if (!/^\$s|^\$S|^_T/.test(s)) return null;
  const body = s.replace(/^\$s|^\$S|^_T0?/, '');
  const parts = [];
  let i = 0;
  let guard = 0;
  while (i < body.length && guard++ < 200) {
    const m = /^(\d+)/.exec(body.slice(i));
    if (m) {
      const len = Number(m[1]);
      i += m[1].length;
      const word = body.slice(i, i + len);
      if (!word) break;
      parts.push(word);
      i += len;
      continue;
    }
    const c = body[i];
    if (SWIFT_KIND[c]) { parts.push('(' + SWIFT_KIND[c] + ')'); i++; continue; }
    i++;
  }
  if (!parts.length) return null;
  const words = parts.filter((w) => !w.startsWith('('));
  const kinds = parts.filter((w) => w.startsWith('('));
  const kind = kinds.length ? kinds[0].replace(/[()]/g, '') : null;
  return words.join('.') + (kind ? '   [' + kind + ']' : '');
}

/* ── 読みやすい形に整える ────────────────────────────────────
 *
 * マングルを解いただけでは、まだ人の読む文にはならない:
 *
 *   std::__1::basic_string<char, __1::char_traits<char>,
 *     __1::allocator<char>>::append(const char *)
 *
 * libc++ は名前空間に __1 を挟むので、それがそのまま出る。
 * 標準の型はほとんどが別名（typedef）で知られているので、そちらに直す。
 */

/** libc++ の内部名前空間を落とす。 */
function stripInline(s) {
  return s
    .replace(/std::__[0-9]+::/g, 'std::')
    .replace(/(^|[^\w:])__[0-9]+::/g, '$1std::');
}

/** <> の中身を、入れ子を数えながら切り出す。 */
function splitArgs(s) {
  const out = [];
  let depth = 0, cur = '';
  for (const ch of s) {
    if (ch === '<' || ch === '(') depth++;
    if (ch === '>' || ch === ')') depth--;
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** テンプレート引数のかたまりを 1 つ見つけて [開始, 終了) を返す。 */
function findTemplate(s, from) {
  const open = s.indexOf('<', from);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === '<') depth++;
    else if (s[i] === '>') { depth--; if (!depth) return { open, close: i }; }
  }
  return null;
}

/* 標準ライブラリの、よく知られた別名。中身が既定どおりのときだけ短くする。 */
const ALIASES = [
  { name: 'std::basic_string', args: ['char'], to: 'std::string' },
  { name: 'std::basic_string', args: ['wchar_t'], to: 'std::wstring' },
  { name: 'std::basic_ostream', args: ['char'], to: 'std::ostream' },
  { name: 'std::basic_istream', args: ['char'], to: 'std::istream' },
  { name: 'std::basic_stringstream', args: ['char'], to: 'std::stringstream' },
];
/* 2 つめ以降が置き場（allocator など）なだけの型は、1 つめだけ残す。 */
const DROP_TAIL = /^std::(vector|list|deque|set|multiset|forward_list|stack|queue)$/;
const DROP_TAIL2 = /^std::(map|multimap|unordered_map|unordered_set)$/;

/**
 * 標準の型を、ふだん書く名前に戻す。
 *   basic_string<char, char_traits<char>, allocator<char>>  →  std::string
 *   vector<int, allocator<int>>                             →  std::vector<int>
 */
function simplifyStd(s) {
  let out = s;
  for (let guard = 0; guard < 40; guard++) {
    const t = findTemplate(out, 0);
    if (!t) break;
    const head = /[\w:~]+$/.exec(out.slice(0, t.open));
    if (!head) break;
    const base = head[0];
    const inner = out.slice(t.open + 1, t.close);
    const args = splitArgs(inner).map((a) => simplifyStd(a));
    let replaced = null;
    for (const al of ALIASES) {
      if (base === al.name && args.length && args[0] === al.args[0]) { replaced = al.to; break; }
    }
    if (replaced == null) {
      if (DROP_TAIL.test(base) && args.length > 1) replaced = base + '<' + args[0] + '>';
      else if (DROP_TAIL2.test(base) && args.length > 2) replaced = base + '<' + args.slice(0, 2).join(', ') + '>';
      else replaced = base + '<' + args.join(', ') + '>';
    }
    const start = t.open - base.length;
    out = out.slice(0, start) + replaced + out.slice(t.close + 1);
    // 置き換えた部分より後ろに、まだテンプレートが残っているかもしれない
    const next = out.indexOf('<', start + replaced.length);
    if (next < 0) break;
  }
  return out;
}

/**
 * 名前を 1 つ渡すと、いちばん読みやすい形を返す。
 * どれでもなければ元の名前をそのまま返す（勝手に変えない）。
 */
export function readableName(name) {
  if (!name) return name;
  const cxx = demangleCxx(name);
  if (cxx) return simplifyStd(stripInline(cxx));
  return demangleSwift(name) || name;
}

/**
 * コードの行に置くための、短い名前。
 *
 * 擬似コードの 1 行に
 *   __ZNSt3__1plIcNS_11char_traitsIcEENS_9allocatorIcEEEE…
 * や、その完全な復元形（150 字）を置いても読めない。行の中では
 *   std::operator+
 *   std::string::append
 *   BattleCat::attack
 * まで削る。完全な形は、その行を押したときに出す。
 *
 * @param {string} name  シンボル名（マングルされていてもいなくてもよい）
 * @param {{keepNamespace?:boolean}} [opts]
 */
export function shortName(name, opts) {
  if (!name) return name;
  const o = opts || {};
  let s = readableName(name);
  if (s === name) {
    // マングルでもなんでもない、ふつうの名前。頭の _ だけ落とす。
    return name.replace(/^_+/, '') || name;
  }
  // 引数の並びを落とす（かっこの中はぜんぶ）
  const paren = s.indexOf('(');
  if (paren > 0) s = s.slice(0, paren);
  // テンプレート引数を落とす
  for (let guard = 0; guard < 40; guard++) {
    const t = findTemplate(s, 0);
    if (!t) break;
    s = s.slice(0, t.open) + s.slice(t.close + 1);
  }
  s = s.replace(/\s+/g, ' ').replace(/ const$/, '').trim();
  if (!o.keepNamespace) {
    /* std:: だけは残す（どこの関数かが分かる手がかりなので）。
       それ以外の長い名前空間は、末尾 2 つに切り詰める。 */
    const parts = s.split('::');
    if (parts.length > 2 && parts[0] !== 'std') s = parts.slice(-2).join('::');
  }
  return s || name;
}

/** 名前が読み直されたかどうか（画面で「元の名前」を併記するため）。 */
export function isMangled(name) {
  if (!name) return false;
  return /^_?_Z/.test(name) || /^_?\$s/.test(name) || /^_?\$S/.test(name);
}

/* ── RTTI と vtable ─────────────────────────────────────── */

/**
 * シンボル表から C++ のクラス情報を組み立てる。
 *
 * 手がかりはこの 3 つ:
 *   __ZTVN…E  vtable        … 仮想関数の並び
 *   __ZTIN…E  typeinfo      … 継承関係
 *   __ZTSN…E  typeinfo name … クラス名の文字列
 *
 * @param {object} symbols SymbolIndex
 * @returns {Array<{name, vtable, typeinfo, raw}>}
 */
export function findCxxClasses(symbols, limit = 5000) {
  const out = new Map();
  if (!symbols || !symbols.names) return [];
  for (let i = 0; i < symbols.names.length && out.size < limit; i++) {
    const raw = symbols.names[i];
    if (!raw) continue;
    const m = /^_?_Z(TV|TI|TS)(.+)$/.exec(raw);
    if (!m) continue;
    const cls = demangleCxx('_Z' + m[2].replace(/^N?/, (s) => s)) || demangleCxx('_ZN' + m[2]) || m[2];
    const key = cls;
    if (!out.has(key)) out.set(key, { name: cls, vtable: null, typeinfo: null, typeName: null, raw });
    const e = out.get(key);
    if (m[1] === 'TV') e.vtable = symbols.addrs[i];
    if (m[1] === 'TI') e.typeinfo = symbols.addrs[i];
    if (m[1] === 'TS') e.typeName = symbols.addrs[i];
  }
  return Array.from(out.values()).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * vtable の中身を読む。
 *
 * 並びは決まっていて、先頭 2 つは「オフセット」と「typeinfo へのポインタ」、
 * その次から仮想関数のアドレスが続きます。
 *
 * @param {function} read (addr, len) → Promise<Uint8Array|null>
 * @param {BigInt} vtableAddr
 * @param {object} symbols
 * @param {number} maxSlots
 */
export async function readVtable(read, vtableAddr, symbols, maxSlots = 64) {
  const bytes = await read(vtableAddr, (maxSlots + 2) * 8);
  if (!bytes || bytes.length < 24) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const slots = [];
  const offsetToTop = BigInt.asIntN(64, dv.getBigUint64(0, true));
  const typeinfo = sanitize(dv.getBigUint64(8, true));
  for (let i = 2; i * 8 + 8 <= bytes.length; i++) {
    const raw = dv.getBigUint64(i * 8, true);
    const addr = sanitize(raw);
    if (addr === 0n) break;
    const name = symbols ? (symbols.nameAt(addr) || symbols.label(addr)) : null;
    slots.push({
      index: i - 2, addr,
      name: name || null,
      readable: name ? readableName(name) : null,
    });
  }
  return { addr: vtableAddr, offsetToTop, typeinfo, slots };
}

/**
 * ポインタらしく見えない値を整える。
 * 最近の Mach-O はポインタをそのまま持たず、起動時に埋める形（chained fixups）で
 * 書いてあるため、上位ビットに印が入る。
 */
function sanitize(v) {
  if (v === 0n) return 0n;
  if (v < 0x0001000000000000n) return v;
  return v & 0x0000000fffffffffn;
}
