/* Extended Objective-C runtime metadata. */
import { pagedReader, sanitizePointer } from '../objc-legacy.js';

const PTR = 8;
const NAME_READ_INITIAL = 256;
const NAME_READ_MAX = 8192;
const MAX_PROTOCOLS = 20000;
const MAX_CATEGORIES = 20000;
const MAX_METHODS = 60000;
const REL_FLAG = 0x80000000;
const ENTSIZE_MASK = 0xfffc;

function u32(b, o = 0) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }
function i32(b, o = 0) { return u32(b, o) | 0; }
function u64(b, o = 0) { let v = 0n; for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(b[o + i]); return v; }

async function decodedPointer(get, raw, storageAddress = null) {
  if (!raw) return null;
  if (typeof get.resolvePointer === 'function') {
    try {
      const resolved = await get.resolvePointer(raw, { address: storageAddress, imageBase: get.base });
      if (resolved == null) return null;
      return BigInt(resolved);
    } catch { return null; }
  }
  return sanitizePointer(raw, get.base);
}

async function ptr(get, addr) { const b = await get(addr, PTR); return b ? decodedPointer(get, u64(b), addr) : null; }

async function cstring(get, addr) {
  if (addr == null) return null;
  for (let want = NAME_READ_INITIAL; want <= NAME_READ_MAX; want *= 2) {
    const b = await get(addr, Math.min(want, NAME_READ_MAX), true);
    if (!b || !b.length) return null;
    const end = b.indexOf(0);
    if (end >= 0) {
      if (!end) return null;
      const bytes = b.subarray(0, end);
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        return /[\u0000-\u001f\u007f]/u.test(text) ? null : text;
      } catch { return null; }
    }
    if (b.length < Math.min(want, NAME_READ_MAX) || want >= NAME_READ_MAX) return null;
  }
  return null;
}

async function methodList(get, listAddr, owner, classMethod, source) {
  const out = [];
  if (listAddr == null) return out;
  const h = await get(listAddr, 8); if (!h) return out;
  const rawEntsize = u32(h, 0), count = u32(h, 4);
  if (!count || count > MAX_METHODS) return out;
  const relative = !!(rawEntsize & REL_FLAG), stride = rawEntsize & ENTSIZE_MASK;
  if ((relative && stride < 12) || (!relative && stride < 24)) return out;
  for (let i = 0; i < count; i++) {
    const at = listAddr + 8n + BigInt(i * stride);
    const b = await get(at, relative ? 12 : 24); if (!b) break;
    let nameAddr = null, typeAddr = null, imp = null;
    if (relative) {
      const nameTarget = at + BigInt(i32(b, 0));
      nameAddr = await ptr(get, nameTarget);
      if (nameAddr == null || await cstring(get, nameAddr) == null) nameAddr = nameTarget;
      typeAddr = at + 4n + BigInt(i32(b, 4)); imp = at + 8n + BigInt(i32(b, 8));
    } else {
      nameAddr = await decodedPointer(get, u64(b, 0), at);
      typeAddr = await decodedPointer(get, u64(b, 8), at + 8n);
      imp = await decodedPointer(get, u64(b, 16), at + 16n);
    }
    const sel = await cstring(get, nameAddr); if (!sel) continue;
    out.push({ sel, selector: sel, types: await cstring(get, typeAddr), addr: imp, imp, className: owner || null, classMethod: !!classMethod, source, kind: classMethod ? '+' : '-', name: owner ? `${classMethod ? '+' : '-'}[${owner} ${sel}]` : sel });
  }
  return out;
}

async function protocolName(get, address) { if (address == null) return null; const b = await get(address, 16); if (!b) return null; return cstring(get, await decodedPointer(get, u64(b, 8), address + 8n)); }
async function protocolRefs(get, listAddr) {
  const out = []; if (listAddr == null) return out;
  const h = await get(listAddr, PTR); if (!h) return out;
  const count64 = u64(h, 0); if (count64 > 4096n) return out;
  for (let i = 0; i < Number(count64); i++) { const address = await ptr(get, listAddr + 8n + BigInt(i * PTR)); if (address == null) continue; const name = await protocolName(get, address); if (name) out.push({ name, address }); }
  return out;
}

async function parseProtocol(get, address) {
  const b = await get(address, 64, true); if (!b || b.length < 56) return null;
  const name = await cstring(get, await decodedPointer(get, u64(b, 8), address + 8n)); if (!name) return null;
  const inherited = await protocolRefs(get, await decodedPointer(get, u64(b, 16), address + 16n));
  const methods = await methodList(get, await decodedPointer(get, u64(b, 24), address + 24n), name, false, 'protocol');
  const classMethods = await methodList(get, await decodedPointer(get, u64(b, 32), address + 32n), name, true, 'protocol');
  const optionalInstanceMethods = await methodList(get, await decodedPointer(get, u64(b, 40), address + 40n), name, false, 'protocol-optional');
  const optionalClassMethods = await methodList(get, await decodedPointer(get, u64(b, 48), address + 48n), name, true, 'protocol-optional');
  return { runtime: 'objc', kind: 'protocol', address, name, protocols: inherited, methods, instanceMethods: methods, classMethods, optionalInstanceMethods, optionalClassMethods, instancePropertiesAddress: b.length >= 64 ? await decodedPointer(get, u64(b, 56), address + 56n) : null };
}

async function parseCategory(get, address, classByAddress) {
  const b = await get(address, 56, true); if (!b || b.length < 48) return null;
  const name = await cstring(get, await decodedPointer(get, u64(b, 0), address)); if (!name) return null;
  const classAddress = await decodedPointer(get, u64(b, 8), address + 8n);
  const target = classAddress != null ? classByAddress.get(classAddress.toString()) : null, className = target?.name || null;
  const methods = await methodList(get, await decodedPointer(get, u64(b, 16), address + 16n), className, false, 'category');
  const classMethods = await methodList(get, await decodedPointer(get, u64(b, 24), address + 24n), className, true, 'category');
  const protocols = await protocolRefs(get, await decodedPointer(get, u64(b, 32), address + 32n));
  return { runtime: 'objc', kind: 'category', address, name, classAddress, className, methods, instanceMethods: methods, classMethods, protocols, instancePropertiesAddress: await decodedPointer(get, u64(b, 40), address + 40n), classPropertiesAddress: b.length >= 56 ? await decodedPointer(get, u64(b, 48), address + 48n) : null };
}

async function pointerTable(get, range, budget, parse) {
  const out = []; if (!range || range.vmAddr == null || !range.size) return out;
  const count = Math.min(Math.floor(Number(range.size) / PTR), budget);
  for (let i = 0; i < count; i++) { const address = await ptr(get, BigInt(range.vmAddr) + BigInt(i * PTR)); if (address == null) continue; try { const item = await parse(address); if (item) out.push(item); } catch { /* malformed entry is not evidence */ } }
  return out;
}

export async function parseObjcExtendedMetadata(read, sections = {}, opts = {}) {
  const get = pagedReader(read, opts.pageBytes || 65536, opts.maxPages || 96);
  get.base = opts.imageBase != null ? BigInt(opts.imageBase) : null;
  get.resolvePointer = opts.resolvePointer || opts.binaryImage?.resolvePointer || opts.binaryImage?.decodePointer || null;
  const classByAddress = new Map((opts.classes || []).filter((c) => c?.addr != null).map((c) => [c.addr.toString(), c]));
  const protocols = await pointerTable(get, sections.protocolList, MAX_PROTOCOLS, (address) => parseProtocol(get, address));
  const categories = await pointerTable(get, sections.categoryList, MAX_CATEGORIES, (address) => parseCategory(get, address, classByAddress));
  return { runtime: 'objc', protocols, categories };
}
