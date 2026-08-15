/*
 * C++ / Swift symbol readability and C++ RTTI helpers.
 */

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

export function demangleCxx(name) {
  if (!name) return null;
  const s = String(name).replace(/^_/, '');
  if (!s.startsWith('_Z')) return null;
  const p = { s, i: 2, subs: [] };
  try {
    const special = readSpecial(p);
    const body = readName(p);
    if (!body) return null;
    let out = special ? special.replace('{}', body) : body;
    if (special) return p.i === p.s.length ? out : null;
    if (p.i < p.s.length) {
      const args = readArgs(p);
      if (args == null || p.i !== p.s.length) return null;
      const m = /^(.*?)( const)$/.exec(out);
      out = m ? m[1] + '(' + args + ')' + m[2] : out + '(' + args + ')';
    }
    return p.i === p.s.length ? out : null;
  } catch { return null; }
}

function readSpecial(p) {
  const two = p.s.slice(p.i, p.i + 2);
  const map = { TV: 'vtable for {}', TT: 'VTT for {}', TI: 'typeinfo for {}', TS: 'typeinfo name for {}', GV: 'guard variable for {}', Th: 'thunk to {}' };
  if (map[two]) { p.i += 2; return map[two]; }
  return null;
}

function readName(p) {
  const c = p.s[p.i], two = p.s.slice(p.i, p.i + 2);
  if (OPERATORS[two] && !/\d/.test(c || '')) { p.i += 2; return OPERATORS[two]; }
  if (c === 'N') { p.i++; return readNested(p); }
  if (c === 'S') return readSubstitution(p);
  if (/\d/.test(c || '')) return readSourceName(p);
  if (c === 'L') { p.i++; return readName(p); }
  return null;
}

function readNested(p) {
  const parts = [];
  let cvr = '';
  while (p.i < p.s.length && /[rVK]/.test(p.s[p.i])) { if (p.s[p.i] === 'K') cvr = ' const'; p.i++; }
  while (p.i < p.s.length && p.s[p.i] !== 'E') {
    const c = p.s[p.i];
    let part = null;
    if (/\d/.test(c)) part = readSourceName(p);
    else if (c === 'S') part = readSubstitution(p);
    else if (c === 'C') { if (p.i + 2 > p.s.length) return null; p.i += 2; part = parts[parts.length - 1] || 'ctor'; }
    else if (c === 'D') { if (p.i + 2 > p.s.length) return null; p.i += 2; part = '~' + (parts[parts.length - 1] || 'dtor'); }
    else if (OPERATORS[p.s.slice(p.i, p.i + 2)]) { part = OPERATORS[p.s.slice(p.i, p.i + 2)]; p.i += 2; }
    else if (c === 'I') part = readTemplateArgs(p);
    else return null;
    if (!part) return null;
    parts.push(part);
  }
  if (p.s[p.i] !== 'E' || !parts.length) return null;
  p.i++;
  const joined = parts.reduce((acc, cur) => cur.startsWith('<') ? acc + cur : (acc ? acc + '::' + cur : cur), '');
  return joined + cvr;
}

function readSourceName(p) {
  let n = '';
  while (p.i < p.s.length && /\d/.test(p.s[p.i])) n += p.s[p.i++];
  const len = Number(n);
  if (!Number.isSafeInteger(len) || len <= 0 || p.i + len > p.s.length) return null;
  const out = p.s.slice(p.i, p.i + len);
  p.i += len;
  p.subs.push(out);
  return out;
}

function readSubstitution(p) {
  const two = p.s.slice(p.i, p.i + 2);
  if (SUBSTITUTIONS[two]) { p.i += 2; return SUBSTITUTIONS[two]; }
  p.i++;
  let idx = '';
  while (p.i < p.s.length && p.s[p.i] !== '_') idx += p.s[p.i++];
  if (p.i >= p.s.length || p.s[p.i] !== '_') return null;
  p.i++;
  if (idx && !/^[0-9A-Z]+$/i.test(idx)) return null;
  const n = idx === '' ? 0 : parseInt(idx, 36) + 1;
  return Number.isSafeInteger(n) ? (p.subs[n] || null) : null;
}

function readTemplateArgs(p) {
  p.i++;
  const args = [];
  let guard = 0;
  while (p.i < p.s.length && p.s[p.i] !== 'E' && guard++ < 64) {
    const before = p.i, t = readType(p);
    if (!t || p.i <= before) return null;
    args.push(t);
  }
  if (p.s[p.i] !== 'E' || !args.length) return null;
  p.i++;
  return '<' + args.join(', ') + '>';
}

function readArgs(p) {
  const args = [];
  let guard = 0;
  while (p.i < p.s.length) {
    if (guard++ >= 64) return null;
    const before = p.i, t = readType(p);
    if (!t || p.i <= before) return null;
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
  return null;
}

const SWIFT_KIND = { C: 'class', V: 'struct', O: 'enum', P: 'protocol', F: 'func', vg: 'getter', vs: 'setter', fC: 'init', fD: 'deinit' };

export function demangleSwift(name) {
  if (!name) return null;
  const s = name.replace(/^_/, '');
  if (!/^\$s|^\$S|^_T/.test(s)) return null;
  const body = s.replace(/^\$s|^\$S|^_T0?/, '');
  const parts = [];
  let i = 0, guard = 0;
  while (i < body.length && guard++ < 200) {
    const m = /^(\d+)/.exec(body.slice(i));
    if (m) {
      const len = Number(m[1]); i += m[1].length;
      const word = body.slice(i, i + len); if (!word) break;
      parts.push(word); i += len; continue;
    }
    const c = body[i]; if (SWIFT_KIND[c]) { parts.push('(' + SWIFT_KIND[c] + ')'); i++; continue; }
    i++;
  }
  if (!parts.length) return null;
  const words = parts.filter((w) => !w.startsWith('(')), kinds = parts.filter((w) => w.startsWith('('));
  const kind = kinds.length ? kinds[0].replace(/[()]/g, '') : null;
  return words.join('.') + (kind ? '   [' + kind + ']' : '');
}

function stripInline(s) { return s.replace(/std::__[0-9]+::/g, 'std::').replace(/(^|[^\w:])__[0-9]+::/g, '$1std::'); }
function splitArgs(s) {
  const out = []; let depth = 0, cur = '';
  for (const ch of s) { if (ch === '<' || ch === '(') depth++; if (ch === '>' || ch === ')') depth--; if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; } cur += ch; }
  if (cur.trim()) out.push(cur.trim()); return out;
}
function findTemplate(s, from) {
  const open = s.indexOf('<', from); if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < s.length; i++) { if (s[i] === '<') depth++; else if (s[i] === '>') { depth--; if (!depth) return { open, close: i }; } }
  return null;
}
const ALIASES = [
  { name: 'std::basic_string', args: ['char'], to: 'std::string' },
  { name: 'std::basic_string', args: ['wchar_t'], to: 'std::wstring' },
  { name: 'std::basic_ostream', args: ['char'], to: 'std::ostream' },
  { name: 'std::basic_istream', args: ['char'], to: 'std::istream' },
  { name: 'std::basic_stringstream', args: ['char'], to: 'std::stringstream' },
];
const DROP_TAIL = /^std::(vector|list|deque|set|multiset|forward_list|stack|queue)$/;
const DROP_TAIL2 = /^std::(map|multimap|unordered_map|unordered_set)$/;

function simplifyStd(s) {
  let out = s;
  for (let guard = 0; guard < 40; guard++) {
    const t = findTemplate(out, 0); if (!t) break;
    const head = /[\w:~]+$/.exec(out.slice(0, t.open)); if (!head) break;
    const base = head[0], inner = out.slice(t.open + 1, t.close), args = splitArgs(inner).map((a) => simplifyStd(a));
    let replaced = null;
    for (const al of ALIASES) if (base === al.name && args.length && args[0] === al.args[0]) { replaced = al.to; break; }
    if (replaced == null) {
      if (DROP_TAIL.test(base) && args.length > 1) replaced = base + '<' + args[0] + '>';
      else if (DROP_TAIL2.test(base) && args.length > 2) replaced = base + '<' + args.slice(0, 2).join(', ') + '>';
      else replaced = base + '<' + args.join(', ') + '>';
    }
    const start = t.open - base.length; out = out.slice(0, start) + replaced + out.slice(t.close + 1);
    if (out.indexOf('<', start + replaced.length) < 0) break;
  }
  return out;
}

export function readableName(name) { if (!name) return name; const cxx = demangleCxx(name); if (cxx) return simplifyStd(stripInline(cxx)); return demangleSwift(name) || name; }

export function shortName(name, opts) {
  if (!name) return name;
  const o = opts || {}; let s = readableName(name);
  if (s === name) return name.replace(/^_+/, '') || name;
  const paren = s.indexOf('('); if (paren > 0) s = s.slice(0, paren);
  for (let guard = 0; guard < 40; guard++) { const t = findTemplate(s, 0); if (!t) break; s = s.slice(0, t.open) + s.slice(t.close + 1); }
  s = s.replace(/\s+/g, ' ').replace(/ const$/, '').trim();
  if (!o.keepNamespace) { const parts = s.split('::'); if (parts.length > 2 && parts[0] !== 'std') s = parts.slice(-2).join('::'); }
  return s || name;
}

export function isMangled(name) { if (!name) return false; return /^_?_Z/.test(name) || /^_?\$s/.test(name) || /^_?\$S/.test(name); }

export function findCxxClasses(symbols, limit = 5000) {
  const out = new Map(); if (!symbols || !symbols.names) return [];
  for (let i = 0; i < symbols.names.length && out.size < limit; i++) {
    const raw = symbols.names[i]; if (!raw) continue;
    const m = /^_?_Z(TV|TI|TS)(.+)$/.exec(raw); if (!m) continue;
    const cls = demangleCxx('_Z' + m[2].replace(/^N?/, (s) => s)) || demangleCxx('_ZN' + m[2]) || m[2];
    if (!out.has(cls)) out.set(cls, { name: cls, vtable: null, typeinfo: null, typeName: null, raw });
    const e = out.get(cls); if (m[1] === 'TV') e.vtable = symbols.addrs[i]; if (m[1] === 'TI') e.typeinfo = symbols.addrs[i]; if (m[1] === 'TS') e.typeName = symbols.addrs[i];
  }
  return Array.from(out.values()).sort((a, b) => a.name.localeCompare(b.name));
}

export async function readVtable(read, vtableAddr, symbols, maxSlots = 64) {
  const bytes = await read(vtableAddr, (maxSlots + 2) * 8); if (!bytes || bytes.length < 24) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), slots = [];
  const offsetToTop = BigInt.asIntN(64, dv.getBigUint64(0, true)), typeinfo = sanitize(dv.getBigUint64(8, true));
  for (let i = 2; i * 8 + 8 <= bytes.length; i++) {
    const addr = sanitize(dv.getBigUint64(i * 8, true)); if (addr === 0n) break;
    const name = symbols ? (symbols.nameAt(addr) || symbols.label(addr)) : null;
    slots.push({ index: i - 2, addr, name: name || null, readable: name ? readableName(name) : null });
  }
  return { addr: vtableAddr, offsetToTop, typeinfo, slots };
}

function sanitize(v) { if (v === 0n) return 0n; if (v < 0x0001000000000000n) return v; return v & 0x0000000fffffffffn; }
