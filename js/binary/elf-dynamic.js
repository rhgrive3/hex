import { functionSeed } from './model.js';

const PT_DYNAMIC = 2;
const DT_NULL = 0n;
const DT_NEEDED = 1n;
const DT_PLTRELSZ = 2n;
const DT_HASH = 4n;
const DT_STRTAB = 5n;
const DT_SYMTAB = 6n;
const DT_RELA = 7n;
const DT_RELASZ = 8n;
const DT_RELAENT = 9n;
const DT_STRSZ = 10n;
const DT_SYMENT = 11n;
const DT_SONAME = 14n;
const DT_REL = 17n;
const DT_RELSZ = 18n;
const DT_RELENT = 19n;
const DT_PLTREL = 20n;
const DT_JMPREL = 23n;
const DT_GNU_HASH = 0x6ffffef5n;

export function parseProgramDynamic(r, programHeaders, image, bits, opts = {}) {
  const dyn = (programHeaders || []).find((p) => p.type === PT_DYNAMIC);
  if (!dyn || dyn.filesz <= 0n) return { parsed: false };
  const start = toSafeNumber(dyn.offset);
  const size = toSafeNumber(dyn.filesz);
  if (start == null || size == null || start < 0 || start + size > r.length) {
    image.warnings.push('PT_DYNAMIC is outside the file');
    return { parsed: false };
  }

  const entSize = bits === 64 ? 16 : 8;
  const tags = new Map();
  const ordered = [];
  for (let p = start, guard = 0; p + entSize <= start + size && guard < 1_000_000; p += entSize, guard++) {
    const tag = bits === 64 ? r.i64(p) : BigInt(r.i32(p));
    const value = bits === 64 ? r.u64(p + 8) : BigInt(r.u32(p + 4));
    if (tag === DT_NULL) break;
    if (!tags.has(tag)) tags.set(tag, []);
    tags.get(tag).push(value);
    ordered.push({ tag, value });
  }

  const one = (tag) => tags.get(tag)?.[0] ?? null;
  const strtab = one(DT_STRTAB);
  const strsz = one(DT_STRSZ);
  const symtab = one(DT_SYMTAB);
  const defaultSyment = BigInt(bits === 64 ? 24 : 16);
  const syment = one(DT_SYMENT) ?? defaultSyment;
  const symentValid = syment >= defaultSyment;
  if (!symentValid) markDynamicPartial(image, `DT_SYMENT ${syment} is smaller than ${defaultSyment}`);
  const strOff = strtab == null ? null : vaToOffset(image, strtab);
  const strSize = strsz == null ? 0 : toSafeNumber(strsz);

  const stringAt = (offset) => {
    if (strOff == null || strSize == null) return '';
    const n = Number(offset);
    if (!Number.isSafeInteger(n) || n < 0 || n >= strSize || strOff + n >= r.length) return '';
    return r.cstring(strOff + n, Math.min(strSize - n, r.length - strOff - n, 1 << 20));
  };

  for (const needed of tags.get(DT_NEEDED) || []) {
    const name = stringAt(needed);
    if (name) image.libraries.push(name);
  }
  const soname = one(DT_SONAME);
  if (soname != null) {
    const name = stringAt(soname);
    if (name) image.metadata.soname = name;
  }

  const relocs = collectDynamicRelocations(r, tags, image, bits);
  let symbolCount = 0;
  if (symtab != null && symentValid) {
    symbolCount = symbolCountFromHash(r, one(DT_HASH), image) ||
      symbolCountFromGnuHash(r, one(DT_GNU_HASH), image, bits) ||
      symbolCountFromRelocations(relocs) ||
      symbolCountFromLayout(symtab, strtab, syment);
  }

  let symbols = [];
  if (opts.symbols !== false && symtab != null && symbolCount > 0) {
    symbols = parseDynamicSymbols(r, image, bits, symtab, syment, symbolCount, stringAt);
  } else if (symtab != null && symbolCount > 0) {
    symbols = dynamicSymbolsFromImage(image);
  }

  if (opts.relocations !== false) attachDynamicRelocations(image, relocs, symbols);

  image.metadata.programDynamic = {
    entries: ordered.length,
    symbols: symbolCount,
    relocations: relocs.length,
    sectionless: image.sections.length === 0,
    hasSysvHash: one(DT_HASH) != null,
    hasGnuHash: one(DT_GNU_HASH) != null,
  };
  return { parsed: true, tags, symbols: symbolCount, relocations: relocs.length };
}

function parseDynamicSymbols(r, image, bits, symtabVa, syment, count, stringAt) {
  const off = vaToOffset(image, symtabVa);
  const ent = toSafeNumber(syment);
  if (off == null || ent == null || ent <= 0) return [];
  const max = Math.min(count, 10_000_000, Math.floor((r.length - off) / ent));
  const out = [];
  for (let i = 0; i < max; i++) {
    const p = off + i * ent;
    let nameOff, info, other, shndx, value, size;
    if (bits === 64) {
      if (p + 24 > r.length) break;
      nameOff = r.u32(p); info = r.u8(p + 4); other = r.u8(p + 5); shndx = r.u16(p + 6);
      value = r.u64(p + 8); size = r.u64(p + 16);
    } else {
      if (p + 16 > r.length) break;
      nameOff = r.u32(p); value = BigInt(r.u32(p + 4)); size = BigInt(r.u32(p + 8));
      info = r.u8(p + 12); other = r.u8(p + 13); shndx = r.u16(p + 14);
    }
    const name = stringAt(BigInt(nameOff));
    const bind = info >>> 4;
    const type = info & 0xf;
    const defined = shndx !== 0;
    const binding = bind === 0 ? 'local' : bind === 1 ? 'global' : bind === 2 ? 'weak' : `bind-${bind}`;
    const kind = type === 2 ? 'function' : type === 1 ? 'object' : type === 3 ? 'section' : type === 6 ? 'tls' : `type-${type}`;
    const sym = { name, address: value, size, kind, binding, defined, sectionIndex: shndx, visibility: other & 3, source: 'PT_DYNAMIC', index: i, tableIndex: -1 };
    out.push(sym);
    if (!name) continue;
    image.symbols.push(sym);
    if (!defined && (bind === 1 || bind === 2)) image.imports.push({ name, library: null, ordinal: null, weak: bind === 2, source: 'PT_DYNAMIC', sites: [] });
    if (defined && (bind === 1 || bind === 2) && sym.visibility !== 2) image.exports.push({ name, address: value, kind, source: 'PT_DYNAMIC' });
    if (defined && type === 2 && value !== 0n) image.functions.push(functionSeed(value, { size: size || null, name, source: 'symbol', confidence: 0.995 }));
  }
  return out;
}

function collectDynamicRelocations(r, tags, image, bits) {
  const out = [];
  const seen = new Set();
  const one = (tag) => tags.get(tag)?.[0] ?? null;
  const addTable = (va, size, ent, rela, source) => {
    if (va == null || size == null || size <= 0n) return;
    const off = vaToOffset(image, va);
    const n = toSafeNumber(size);
    const minimum = BigInt(bits === 64 ? (rela ? 24 : 16) : (rela ? 12 : 8));
    const requested = ent ?? minimum;
    if (requested < minimum) { markDynamicPartial(image, `${source} entry size ${requested} is smaller than ${minimum}`); return; }
    const e = toSafeNumber(requested);
    if (off == null || n == null || e == null || e <= 0 || off + n > r.length) return;
    const count = Math.min(Math.floor(n / e), 10_000_000);
    for (let i = 0; i < count; i++) {
      const p = off + i * e;
      let address, addend = null, symIndex, type;
      if (bits === 64) {
        address = r.u64(p); const info = r.u64(p + 8); symIndex = Number(info >> 32n); type = Number(info & 0xffffffffn);
        if (rela) addend = r.i64(p + 16);
      } else {
        address = BigInt(r.u32(p)); const raw = r.u32(p + 4); symIndex = raw >>> 8; type = raw & 0xff;
        if (rela) addend = BigInt(r.i32(p + 8));
      }
      const key = `${address}:${symIndex}:${type}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ address, symIndex, type, addend, source });
    }
  };

  addTable(one(DT_RELA), one(DT_RELASZ), one(DT_RELAENT), true, 'PT_DYNAMIC-RELA');
  addTable(one(DT_REL), one(DT_RELSZ), one(DT_RELENT), false, 'PT_DYNAMIC-REL');
  const jmprel = one(DT_JMPREL), pltsz = one(DT_PLTRELSZ), pltrel = one(DT_PLTREL);
  if (jmprel != null && pltsz != null) {
    if (pltrel === DT_RELA) addTable(jmprel, pltsz, one(DT_RELAENT), true, 'PT_DYNAMIC-JMPREL-RELA');
    else if (pltrel === DT_REL) addTable(jmprel, pltsz, one(DT_RELENT), false, 'PT_DYNAMIC-JMPREL-REL');
    else markDynamicPartial(image, `DT_PLTREL has unsupported value ${pltrel == null ? '<missing>' : pltrel}; JMPREL was not decoded`);
  }
  return out;
}

function attachDynamicRelocations(image, relocs, symbols) {
  const byIndex = new Map((symbols || []).map((s) => [s.index, s]));
  const importByName = new Map(image.imports.filter((x) => x.name).map((x) => [x.name, x]));
  for (const rel of relocs) {
    const sym = byIndex.get(rel.symIndex) || null;
    const item = {
      address: rel.address,
      fileOffset: image.addressToOffset(rel.address),
      type: rel.type,
      symbol: sym?.name || null,
      symbolIndex: rel.symIndex,
      addend: rel.addend,
      section: null,
      source: rel.source,
    };
    image.relocations.push(item);
    if (sym && !sym.defined && sym.name) {
      let imp = importByName.get(sym.name);
      if (!imp) {
        imp = { name: sym.name, library: null, ordinal: null, weak: sym.binding === 'weak', source: 'PT_DYNAMIC', sites: [] };
        image.imports.push(imp); importByName.set(sym.name, imp);
      }
      imp.sites.push({ address: rel.address, offset: item.fileOffset, kind: 'relocation', type: rel.type });
    }
  }
}

function dynamicSymbolsFromImage(image) {
  const dyn = image.symbols.filter((s) => s.source === 'dynsym' || s.source === 'PT_DYNAMIC');
  return dyn.map((s, i) => ({ ...s, index: s.index ?? i }));
}

function symbolCountFromHash(r, hashVa, image) {
  if (hashVa == null) return 0;
  const off = vaToOffset(image, hashVa);
  if (off == null || off + 8 > r.length) return 0;
  const nchain = r.u32(off + 4);
  return nchain > 0 && nchain <= 10_000_000 ? nchain : 0;
}

function symbolCountFromGnuHash(r, hashVa, image, bits) {
  if (hashVa == null) return 0;
  const off = vaToOffset(image, hashVa);
  if (off == null || off + 16 > r.length) return 0;
  const nbuckets = r.u32(off), symOffset = r.u32(off + 4), bloomSize = r.u32(off + 8);
  if (!nbuckets || nbuckets > 10_000_000 || bloomSize > 10_000_000) return 0;
  const word = bits === 64 ? 8 : 4;
  const bucketsOff = off + 16 + bloomSize * word;
  const chainsOff = bucketsOff + nbuckets * 4;
  if (chainsOff > r.length) return 0;
  let max = symOffset;
  for (let i = 0; i < nbuckets; i++) {
    const bucket = r.u32(bucketsOff + i * 4);
    if (!bucket || bucket < symOffset) continue;
    let idx = bucket;
    let p = chainsOff + (idx - symOffset) * 4;
    for (let guard = 0; guard < 10_000_000 && p + 4 <= r.length; guard++, idx++, p += 4) {
      const chain = r.u32(p);
      if (idx > max) max = idx;
      if (chain & 1) break;
    }
  }
  return max >= symOffset ? max + 1 : 0;
}

function symbolCountFromRelocations(relocs) {
  let max = -1;
  for (const r of relocs) if (r.symIndex > max) max = r.symIndex;
  return max >= 0 ? max + 1 : 0;
}

function symbolCountFromLayout(symtab, strtab, syment) {
  if (strtab == null || strtab <= symtab || syment <= 0n) return 0;
  const n = (strtab - symtab) / syment;
  return n > 0n && n <= 10_000_000n ? Number(n) : 0;
}

function markDynamicPartial(image, message) {
  image.metadata.programDynamicPartial = true;
  const diagnostics = image.metadata.programDynamicDiagnostics ||= [];
  if (!diagnostics.includes(message)) diagnostics.push(message);
  image.warnings.push(`PT_DYNAMIC: ${message}`);
}

function vaToOffset(image, va) {
  const off = image.addressToOffset(va);
  return off == null ? null : toSafeNumber(off);
}
function toSafeNumber(v) {
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : null;
}
