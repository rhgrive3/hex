/*
 * Extended Objective-C runtime metadata.
 *
 * objc-legacy.js intentionally focused on __objc_classlist. This layer adds the
 * modern protocol/category tables without changing the old parser contract.
 * Malformed records are skipped rather than named heuristically.
 */

import { pagedReader, sanitizePointer } from '../objc-legacy.js';

const PTR = 8;
const NAME_CHUNK = 256;
const MAX_NAME = 4096;
const MAX_PROTOCOLS = 20000;
const MAX_CATEGORIES = 20000;
const MAX_METHODS = 60000;
const REL_FLAG = 0x80000000;
const ENTSIZE_MASK = 0xfffc;

function u32(b, o = 0) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }
function i32(b, o = 0) { return u32(b, o) | 0; }
function u64(b, o = 0) {
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(b[o + i]);
  return v;
}

async function resolveStoredPointer(get, raw, fieldAddress = null) {
  if (raw === 0n) return null;
  if (typeof get.resolvePointer === 'function') {
    try {
      const value = await get.resolvePointer(raw, { address:fieldAddress, imageBase:get.base });
      if (value !== undefined) return value == null ? null : BigInt(value);
    } catch { return null; }
  }
  return sanitizePointer(raw, get.base);
}

async function ptr(get, addr) {
  const b = await get(addr, PTR);
  return b ? resolveStoredPointer(get, u64(b), addr) : null;
}

async function cstring(get, addr) {
  if (addr == null) return null;
  const bytes = [];
  for (let offset = 0; offset < MAX_NAME; offset += NAME_CHUNK) {
    const want = Math.min(NAME_CHUNK, MAX_NAME - offset);
    const b = await get(addr + BigInt(offset), want, true);
    if (!b || !b.length) return null;
    for (let i = 0; i < b.length; i++) {
      const c = b[i];
      if (c === 0) {
        if (!bytes.length) return null;
        try { return new TextDecoder('utf-8', { fatal:true }).decode(Uint8Array.from(bytes)); }
        catch { return null; }
      }
      // ASCII controls are never valid runtime identifiers. Bytes >= 0x80 are
      // retained and validated by the strict UTF-8 decoder once NUL is found.
      if (c < 0x20 || c === 0x7f) return null;
      bytes.push(c);
      if (bytes.length >= MAX_NAME) return null;
    }
    if (b.length < want) return null;
  }
  return null;
}

async function methodList(get, listAddr, owner, classMethod, source) {
  const out = [];
  if (listAddr == null) return out;
  const h = await get(listAddr, 8);
  if (!h) return out;
  const rawEntsize = u32(h, 0);
  const count = u32(h, 4);
  if (!count || count > MAX_METHODS) return out;
  const relative = !!(rawEntsize & REL_FLAG);
  const stride = rawEntsize & ENTSIZE_MASK;
  if ((relative && stride < 12) || (!relative && stride < 24)) return out;

  for (let i = 0; i < count; i++) {
    const at = listAddr + 8n + BigInt(i * stride);
    const b = await get(at, relative ? 12 : 24);
    if (!b) break;
    let nameAddr = null, typeAddr = null, imp = null;
    if (relative) {
      const nameTarget = at + BigInt(i32(b, 0));
      nameAddr = await ptr(get, nameTarget);
      if (nameAddr == null || await cstring(get, nameAddr) == null) nameAddr = nameTarget;
      typeAddr = at + 4n + BigInt(i32(b, 4));
      imp = at + 8n + BigInt(i32(b, 8));
    } else {
      nameAddr = await resolveStoredPointer(get, u64(b, 0), at);
      typeAddr = await resolveStoredPointer(get, u64(b, 8), at + 8n);
      imp = await resolveStoredPointer(get, u64(b, 16), at + 16n);
    }
    const sel = await cstring(get, nameAddr);
    if (!sel) continue;
    out.push({
      sel, selector: sel,
      types: await cstring(get, typeAddr),
      addr: imp,
      imp,
      className: owner || null,
      classMethod: !!classMethod,
      source,
      kind: classMethod ? '+' : '-',
      name: owner ? `${classMethod ? '+' : '-'}[${owner} ${sel}]` : sel,
    });
  }
  return out;
}

async function protocolName(get, address) {
  if (address == null) return null;
  const b = await get(address, 16);
  if (!b) return null;
  return cstring(get, await resolveStoredPointer(get, u64(b, 8), address + 8n));
}

async function protocolRefs(get, listAddr) {
  const out = [];
  if (listAddr == null) return out;
  const h = await get(listAddr, PTR);
  if (!h) return out;
  const count64 = u64(h, 0);
  if (count64 > 4096n) return out;
  const count = Number(count64);
  for (let i = 0; i < count; i++) {
    const address = await ptr(get, listAddr + 8n + BigInt(i * PTR));
    if (address == null) continue;
    const name = await protocolName(get, address);
    if (name) out.push({ name, address });
  }
  return out;
}

async function parseProtocol(get, address) {
  const b = await get(address, 64, true);
  if (!b || b.length < 56) return null;
  const name = await cstring(get, await resolveStoredPointer(get, u64(b, 8), address + 8n));
  if (!name) return null;
  const inherited = await protocolRefs(get, await resolveStoredPointer(get, u64(b, 16), address + 16n));
  const methods = await methodList(get, await resolveStoredPointer(get, u64(b, 24), address + 24n), name, false, 'protocol');
  const classMethods = await methodList(get, await resolveStoredPointer(get, u64(b, 32), address + 32n), name, true, 'protocol');
  const optionalInstanceMethods = await methodList(get, await resolveStoredPointer(get, u64(b, 40), address + 40n), name, false, 'protocol-optional');
  const optionalClassMethods = await methodList(get, await resolveStoredPointer(get, u64(b, 48), address + 48n), name, true, 'protocol-optional');
  return {
    runtime: 'objc', kind: 'protocol', address, name,
    protocols: inherited,
    methods, instanceMethods: methods, classMethods,
    optionalInstanceMethods, optionalClassMethods,
    instancePropertiesAddress: b.length >= 64 ? await resolveStoredPointer(get, u64(b, 56), address + 56n) : null,
  };
}

async function parseCategory(get, address, classByAddress) {
  const b = await get(address, 56, true);
  if (!b || b.length < 48) return null;
  const name = await cstring(get, await resolveStoredPointer(get, u64(b, 0), address));
  if (!name) return null;
  const classAddress = await resolveStoredPointer(get, u64(b, 8), address + 8n);
  const target = classAddress != null ? classByAddress.get(classAddress.toString()) : null;
  const className = target?.name || null;
  const methods = await methodList(get, await resolveStoredPointer(get, u64(b, 16), address + 16n), className, false, 'category');
  const classMethods = await methodList(get, await resolveStoredPointer(get, u64(b, 24), address + 24n), className, true, 'category');
  const protocols = await protocolRefs(get, await resolveStoredPointer(get, u64(b, 32), address + 32n));
  return {
    runtime: 'objc', kind: 'category', address, name,
    classAddress, className,
    methods, instanceMethods: methods, classMethods, protocols,
    instancePropertiesAddress: await resolveStoredPointer(get, u64(b, 40), address + 40n),
    classPropertiesAddress: b.length >= 56 ? await resolveStoredPointer(get, u64(b, 48), address + 48n) : null,
  };
}

async function pointerTable(get, range, budget, parse) {
  const out = [];
  if (!range || range.vmAddr == null || !range.size) return out;
  const count = Math.min(Math.floor(Number(range.size) / PTR), budget);
  for (let i = 0; i < count; i++) {
    const address = await ptr(get, BigInt(range.vmAddr) + BigInt(i * PTR));
    if (address == null) continue;
    try {
      const item = await parse(address);
      if (item) out.push(item);
    } catch { /* malformed entry is not evidence */ }
  }
  return out;
}

/**
 * Parse __objc_protolist / __objc_catlist using class metadata already parsed by
 * objc-legacy.js. `sections` accepts {protocolList, categoryList} ranges.
 * `opts.resolvePointer(raw, {address,imageBase})` may be supplied by the Mach-O
 * chained-fixup/PAC layer; it is authoritative when present and the legacy
 * sanitizer is used only as a compatibility fallback.
 */
export async function parseObjcExtendedMetadata(read, sections = {}, opts = {}) {
  const get = pagedReader(read, opts.pageBytes || 65536, opts.maxPages || 96);
  get.base = opts.imageBase != null ? BigInt(opts.imageBase) : null;
  get.resolvePointer = typeof opts.resolvePointer === 'function' ? opts.resolvePointer : null;
  const classByAddress = new Map((opts.classes || []).filter((c) => c?.addr != null).map((c) => [c.addr.toString(), c]));
  const protocols = await pointerTable(get, sections.protocolList, MAX_PROTOCOLS, (address) => parseProtocol(get, address));
  const categories = await pointerTable(get, sections.categoryList, MAX_CATEGORIES, (address) => parseCategory(get, address, classByAddress));
  return { runtime: 'objc', protocols, categories };
}
