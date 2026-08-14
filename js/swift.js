/*
 * Swift ABI metadata intelligence.
 *
 * No external demangler or CLI is required. The parser focuses on stable ABI
 * structures (relative context descriptors, field descriptors and protocol
 * conformances) and keeps unresolved/unsupported trailing records explicit.
 */

const MAX_NAME = 512;
const DEFAULT_BUDGET = 20000;
const RAW_POINTER_LIMIT = 0x0001000000000000n;

function u16(b, o = 0) { return b[o] | (b[o + 1] << 8); }
function u32(b, o = 0) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }
function i32(b, o = 0) { return u32(b, o) | 0; }
function u64(b, o = 0) { let v=0n; for (let i=7;i>=0;i--) v=(v<<8n)|BigInt(b[o+i]); return v; }
function rel(fieldAddress, raw) { return raw ? BigInt(fieldAddress) + BigInt(raw) : null; }

function normalizeBudget(value, fallback = DEFAULT_BUDGET, max = 100000) {
  if (value == null) return Math.min(fallback, max);
  const n=Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n<=0) throw new TypeError('Swift metadata budget must be a finite positive integer');
  return Math.min(n,max);
}

async function exact(read, addr, len) {
  if (addr == null || len <= 0) return null;
  const b = await read(BigInt(addr), len);
  return b && b.length >= len ? b.subarray(0, len) : null;
}

async function cstring(read, addr, max = MAX_NAME) {
  if (addr == null) return null;
  const b = await read(BigInt(addr), max);
  if (!b || !b.length) return null;
  let end = 0;
  for (; end < b.length && b[end]; end++) {
    const byte=b[end];
    if (byte < 0x20 || byte === 0x7f) return null;
  }
  if (!end || end === b.length) return null;
  try { return new TextDecoder('utf-8', { fatal:true }).decode(b.subarray(0, end)); }
  catch { return null; }
}

async function resolvePointerWord(read, address) {
  const b=await exact(read,address,8);
  if (!b) return { raw:null, target:null, unresolved:true };
  const raw=u64(b);
  if (!raw) return { raw, target:null, unresolved:false };
  if (typeof read.resolvePointer === 'function') {
    try {
      const value=await read.resolvePointer(raw,{address:BigInt(address)});
      if (value !== undefined) return { raw, target:value==null?null:BigInt(value), unresolved:false };
    } catch { return { raw, target:null, unresolved:true }; }
  }
  if (read.pointerEncoding === 'raw' || raw < RAW_POINTER_LIMIT) return { raw, target:raw, unresolved:false };
  return { raw, target:null, unresolved:true };
}

function contextKind(flags) {
  switch (flags & 0x1f) {
    case 0: return 'module';
    case 1: return 'extension';
    case 2: return 'anonymous';
    case 3: return 'protocol';
    case 16: return 'class';
    case 17: return 'struct';
    case 18: return 'enum';
    default: return 'unknown';
  }
}

function sectionRange(sections, wanted) {
  const list = Array.isArray(sections) ? sections : Object.values(sections || {});
  for (const s of list) {
    const name = s.section || s.name || s.sectname;
    if (wanted.includes(name)) {
      const addr = s.vmAddr ?? s.addr ?? s.address;
      const size = s.size ?? s.declaredSize ?? 0;
      if (addr != null && size != null) return { addr: BigInt(addr), size: BigInt(size), raw: s };
    }
  }
  return null;
}

/** A deliberately small built-in demangler for human labels. */
export function demangleSwiftSymbol(symbol) {
  const original = String(symbol || '');
  const s = original.replace(/^_/, '');
  if (!s.startsWith('$s') && !s.startsWith('$S')) return { original, demangled: original, parsed: false, components: [] };
  let i = 2;
  const components = [];
  while (i < s.length && components.length < 12) {
    const m = s.slice(i).match(/^(\d+)/);
    if (!m) break;
    const n = Number(m[1]);
    i += m[1].length;
    if (!(n > 0) || n > 512 || i + n > s.length) break;
    components.push(s.slice(i, i + n));
    i += n;
  }
  const suffix = s.slice(i);
  // Effect markers are only interpreted in the terminal function production.
  // A K elsewhere in a type/name production is not evidence of `throws`.
  const throws = /KF$/.test(suffix);
  const async = /YaK?F$/.test(suffix);
  const accessor = /(?:Ma|Mf|ML|Mn)$/.test(suffix) ? 'metadata' : null;
  const demangled = components.length ? components.join('.') + (async ? ' async' : '') + (throws ? ' throws' : '') : original;
  return { original, demangled, parsed: components.length > 0, components, suffix, async, throws, accessor };
}

async function relativeString(read, fieldAddr, raw) {
  const target = rel(fieldAddr, raw);
  return target == null ? null : cstring(read, target);
}

/** Parse the common nominal type descriptor prefix. */
export async function parseSwiftNominalDescriptor(read, address) {
  const addr = BigInt(address);
  const prefix = await exact(read, addr, 20);
  if (!prefix) return null;
  const flags = u32(prefix, 0);
  const kind = contextKind(flags);
  if (!['class', 'struct', 'enum'].includes(kind)) return null;
  const required = kind === 'class' ? 44 : 28;
  const b = required === 20 ? prefix : await exact(read, addr, required);
  if (!b) return null;
  const nameRel = i32(b, 8);
  const accessRel = i32(b, 12);
  const fieldsRel = i32(b, 16);
  const name = await relativeString(read, addr + 8n, nameRel);
  if (!name) return null;
  const out = {
    runtime: 'swift', kind, address: addr, flags, name,
    parent: rel(addr + 4n, i32(b, 4)),
    metadataAccessor: rel(addr + 12n, accessRel),
    fieldDescriptor: rel(addr + 16n, fieldsRel),
    generic: !!(flags & 0x80),
    unique: !!(flags & 0x40),
    fields: [], methods: [], vtable: [], warnings: [],
  };
  if (kind === 'class') {
    out.superclassType = rel(addr + 20n, i32(b, 20));
    out.metadataNegativeSizeInWords = u32(b, 24);
    out.metadataPositiveSizeInWords = u32(b, 28);
    out.numImmediateMembers = u32(b, 32);
    out.numFields = u32(b, 36);
    out.fieldOffsetVectorOffset = u32(b, 40);
  } else {
    out.numFields = u32(b, 20);
    out.fieldOffsetVectorOffset = u32(b, 24);
  }
  return out;
}

export async function parseSwiftFieldDescriptor(read, address, budget = 4096) {
  if (address == null) return [];
  const limit=normalizeBudget(budget,4096,100000);
  const addr = BigInt(address);
  const h = await exact(read, addr, 16);
  if (!h) return [];
  const recordSize = u16(h, 10);
  const count = u32(h, 12);
  if (recordSize < 12 || count > limit) return [];
  const out = [];
  for (let i = 0; i < count; i++) {
    const at = addr + 16n + BigInt(i * recordSize);
    const r = await exact(read, at, 12);
    if (!r) break;
    const flags = u32(r, 0);
    const type = await relativeString(read, at + 4n, i32(r, 4));
    const name = await relativeString(read, at + 8n, i32(r, 8));
    out.push({ index: i, flags, name: name || `field_${i}`, mangledType: type, indirect: !!(flags & 1), var: !!(flags & 2) });
  }
  return out;
}

export async function parseSwiftProtocolDescriptor(read, address) {
  const addr = BigInt(address);
  const b = await exact(read, addr, 24);
  if (!b) return null;
  const flags = u32(b, 0);
  if (contextKind(flags) !== 'protocol') return null;
  const name = await relativeString(read, addr + 8n, i32(b, 8));
  if (!name) return null;
  const numRequirementsInSignature = u32(b, 12);
  const numRequirements = u32(b, 16);
  const associatedTypeNames = rel(addr + 20n, i32(b, 20));
  return {
    runtime: 'swift', kind: 'protocol', address: addr, flags, name,
    parent: rel(addr + 4n, i32(b, 4)), numRequirementsInSignature, numRequirements,
    associatedTypeNames, requirements: [],
  };
}

/** Swift protocol conformance descriptor (stable ABI prefix). */
export async function parseSwiftConformanceDescriptor(read, address) {
  const addr = BigInt(address);
  const b = await exact(read, addr, 16);
  if (!b) return null;
  const protocol = rel(addr, i32(b, 0));
  const rawTypeReference = rel(addr + 4n, i32(b, 4));
  const witnessTable = rel(addr + 8n, i32(b, 8));
  const flags = u32(b, 12);
  const typeReferenceKind = (flags >>> 3) & 7;
  if (protocol == null || rawTypeReference == null || typeReferenceKind > 3) return null;
  let typeRef=null, objcClassName=null, objcClassPointer=null, unresolvedTypeReference=false;
  if (typeReferenceKind === 0) typeRef=rawTypeReference;
  else if (typeReferenceKind === 1) {
    const resolved=await resolvePointerWord(read,rawTypeReference);
    typeRef=resolved.target; unresolvedTypeReference=resolved.unresolved || typeRef==null;
  } else if (typeReferenceKind === 2) {
    objcClassName=await cstring(read,rawTypeReference);
    unresolvedTypeReference=!objcClassName;
  } else {
    const resolved=await resolvePointerWord(read,rawTypeReference);
    objcClassPointer=resolved.target; unresolvedTypeReference=resolved.unresolved || objcClassPointer==null;
  }
  return {
    runtime: 'swift', kind: 'conformance', address: addr, protocol, typeRef,
    rawTypeReference, objcClassName, objcClassPointer, unresolvedTypeReference,
    witnessTable, flags, typeReferenceKind,
    conditionalRequirements: (flags >>> 8) & 0xff,
    resilientWitnesses: !!(flags & (1 << 16)),
  };
}

/** Parse vtable records when the enclosing descriptor has identified their range. */
export async function parseSwiftVTable(read, address, count, budget = 4096) {
  const limit=normalizeBudget(budget,4096,100000);
  const requested=Number(count);
  if (!Number.isFinite(requested) || requested < 0 || !Number.isInteger(requested)) throw new TypeError('Swift vtable count must be a finite non-negative integer');
  const n = Math.min(requested, limit);
  const out = [];
  let at = BigInt(address);
  for (let i = 0; i < n; i++, at += 8n) {
    const b = await exact(read, at, 8);
    if (!b) break;
    const flags = u32(b, 0);
    const impl = rel(at + 4n, i32(b, 4));
    out.push({ index: i, flags, impl, kind: flags & 0x0f, instance: !(flags & 0x10), dynamic: !!(flags & 0x20) });
  }
  return out;
}

export async function parseSwiftWitnessTable(read, address, count, budget = 4096) {
  const limit=normalizeBudget(budget,4096,100000);
  const requested=Number(count);
  if (!Number.isFinite(requested) || requested < 0 || !Number.isInteger(requested)) throw new TypeError('Swift witness count must be a finite non-negative integer');
  const n = Math.min(requested, limit);
  const out = [];
  let at = BigInt(address);
  for (let i = 0; i < n; i++, at += 8n) {
    const resolved=await resolvePointerWord(read,at);
    if (resolved.raw == null) break;
    out.push({ index: i, target: resolved.target, rawTarget:resolved.raw, unresolved:resolved.unresolved });
  }
  return out;
}

async function relativePointerSection(read, range, budget, parser) {
  const out = [];
  if (!range) return out;
  const count = Math.min(Number(range.size / 4n), normalizeBudget(budget));
  for (let i = 0; i < count; i++) {
    const field = range.addr + BigInt(i * 4);
    const b = await exact(read, field, 4);
    if (!b) break;
    const target = rel(field, i32(b, 0));
    if (target == null) continue;
    try {
      const value = await parser(read, target);
      if (value) out.push(value);
    } catch { /* malformed metadata is skipped, never invented */ }
  }
  return out;
}

/**
 * Parse the Swift metadata sections needed for decompilation. Optional explicit
 * vtable/witness descriptors let a Mach-O layer pass layout facts it already
 * knows without duplicating ABI guessing here.
 */
export async function buildSwiftMetadataModel(read, sections, opts = {}) {
  const budget = normalizeBudget(opts.budget, DEFAULT_BUDGET, 100000);
  if (typeof opts.resolvePointer === 'function' && typeof read.resolvePointer !== 'function') read.resolvePointer=opts.resolvePointer;
  if (opts.pointerEncoding && !read.pointerEncoding) read.pointerEncoding=opts.pointerEncoding;
  const typeSec = sectionRange(sections, ['__swift5_types']);
  const protoSec = sectionRange(sections, ['__swift5_protos']);
  const confSec = sectionRange(sections, ['__swift5_proto']);
  const types = await relativePointerSection(read, typeSec, budget, parseSwiftNominalDescriptor);
  const protocols = await relativePointerSection(read, protoSec, budget, parseSwiftProtocolDescriptor);
  const conformances = await relativePointerSection(read, confSec, budget, parseSwiftConformanceDescriptor);

  for (const t of types) {
    if (t.fieldDescriptor != null) {
      try { t.fields = await parseSwiftFieldDescriptor(read, t.fieldDescriptor, Math.min(budget, 4096)); }
      catch { t.fields = []; }
    }
  }

  const vtables = [];
  for (const v of opts.vtables || []) {
    const methods = await parseSwiftVTable(read, v.address, v.count, budget);
    const x = { ...v, methods }; vtables.push(x);
    const owner = types.find((t) => t.address.toString() === String(v.typeAddress));
    if (owner) { owner.vtable = methods; owner.methods = methods; }
  }
  const witnessTables = [];
  for (const w of opts.witnessTables || []) witnessTables.push({ ...w, entries: await parseSwiftWitnessTable(read, w.address, w.count, budget) });

  return { runtime: 'swift', types, protocols, conformances, vtables, witnessTables, objcClasses:opts.objcClasses || [], warnings: [] };
}

function indexedIdentity(item, duplicateNames) {
  if (!item?.name) return null;
  if (item.qualifiedName) return String(item.qualifiedName);
  if (item.fullName) return String(item.fullName);
  if (item.module) return `${item.module}.${item.name}`;
  if (item.parentName) return `${item.parentName}.${item.name}`;
  if (!duplicateNames.has(item.name)) return item.name;
  const parent=item.parent!=null?`parent@${item.parent}`:'root';
  const address=item.address!=null?`@${item.address}`:'';
  return `${parent}.${item.name}${address}`;
}

function buildNameIndex(items) {
  const counts=new Map();
  for (const item of items) if (item?.name) counts.set(item.name,(counts.get(item.name)||0)+1);
  const duplicates=new Set([...counts].filter(([,count])=>count>1).map(([name])=>name));
  const byName=new Map(), bySimpleName=new Map();
  for (const item of items) {
    if (!item?.name) continue;
    const identity=indexedIdentity(item,duplicates);
    item.qualifiedName ||= identity;
    byName.set(identity,item);
    let group=bySimpleName.get(item.name); if (!group) bySimpleName.set(item.name,group=[]); group.push(item);
  }
  for (const [name,group] of bySimpleName) if (group.length===1) byName.set(name,group[0]);
  return { byName, bySimpleName };
}

export function buildSwiftRuntimeIndex(model = {}) {
  const types=model.types || [], protocols=model.protocols || [];
  const typesByAddress = new Map(), protocolsByAddress = new Map();
  for (const t of types) if (t.address != null) typesByAddress.set(t.address.toString(), t);
  for (const p of protocols) if (p.address != null) protocolsByAddress.set(p.address.toString(), p);
  const typeNames=buildNameIndex(types), protocolNames=buildNameIndex(protocols);
  const typesByName=typeNames.byName, protocolsByName=protocolNames.byName;
  const conformancesByType = new Map(), vtablesByType = new Map(), witnessesByPair = new Map();
  const objcByName=new Map((model.objcClasses||[]).filter((x)=>x?.name).map((x)=>[x.name,x]));
  const objcByAddress=new Map((model.objcClasses||[]).filter((x)=>x?.address!=null||x?.addr!=null).map((x)=>[String(x.address??x.addr),x]));
  for (const c of model.conformances || []) {
    let type=null, typeName=null;
    if (c.typeReferenceKind===0 || c.typeReferenceKind===1 || c.typeReferenceKind==null) {
      type=typesByAddress.get(c.typeRef?.toString()) || null;
      typeName=type?.qualifiedName || type?.name || null;
    } else if (c.typeReferenceKind===2 && c.objcClassName) {
      type=objcByName.get(c.objcClassName) || null; typeName=c.objcClassName;
    } else if (c.typeReferenceKind===3 && c.objcClassPointer!=null) {
      type=objcByAddress.get(String(c.objcClassPointer)) || null; typeName=type?.name || `objc@${c.objcClassPointer}`;
    }
    const proto = protocolsByAddress.get(c.protocol?.toString()) || null;
    const protocolName=proto?.qualifiedName || proto?.name || null;
    if (typeName) {
      let a = conformancesByType.get(typeName); if (!a) { a = []; conformancesByType.set(typeName, a); }
      a.push({ ...c, typeName, protocolName, resolvedType:type });
    }
    if (typeName && protocolName) witnessesByPair.set(`${typeName}:${protocolName}`, c);
  }
  for (const v of model.vtables || []) {
    const owner=typesByAddress.get(String(v.typeAddress));
    const key = v.typeName || owner?.qualifiedName || owner?.name;
    if (key) vtablesByType.set(key, v.methods || []);
  }
  for (const t of types) if (t.name && t.vtable?.length) vtablesByType.set(t.qualifiedName || t.name, t.vtable);
  return { runtime: 'swift', model, typesByAddress, typesByName, typesBySimpleName:typeNames.bySimpleName, protocolsByAddress, protocolsByName, protocolsBySimpleName:protocolNames.bySimpleName, conformancesByType, vtablesByType, witnessesByPair };
}

/** Resolve direct/vtable/witness dispatch without pretending ambiguous slots are named. */
export function resolveSwiftDispatch(index, call = {}) {
  if (!call) return { resolved: null, candidates: [], confidence: 0 };
  if (call.target != null) return { kind: 'direct', resolved: { target: call.target, name: call.name || null }, candidates: [], confidence: call.name ? 0.99 : 0.9 };
  if (!index) return { kind: call.kind || 'indirect', resolved: null, candidates: [], confidence: 0 };

  if (call.kind === 'vtable' && call.typeName != null && call.slot != null) {
    const methods = index.vtablesByType.get(call.typeName) || [];
    const m = methods.find((x) => x.index === Number(call.slot));
    return m ? { kind: 'vtable', resolved: m, candidates: [m], confidence: 0.9 } : { kind: 'vtable', resolved: null, candidates: [], confidence: 0.2 };
  }

  if ((call.kind === 'witness' || call.kind === 'existential') && call.typeName && call.protocolName && call.slot != null) {
    const conf = index.witnessesByPair.get(`${call.typeName}:${call.protocolName}`);
    const table = (index.model.witnessTables || []).find((w) =>
      (conf?.witnessTable != null && String(w.address) === conf.witnessTable.toString()) ||
      (w.typeName === call.typeName && w.protocolName === call.protocolName));
    const entry = table?.entries?.find((x) => x.index === Number(call.slot));
    if (entry?.target != null) return { kind: call.kind, resolved: entry, candidates: [entry], confidence: 0.86, conformance: conf || null };
    return { kind: call.kind, resolved: null, candidates: [], confidence: conf ? 0.55 : 0.2, conformance: conf || null };
  }
  return { kind: call.kind || 'indirect', resolved: null, candidates: [], confidence: 0.15 };
}

/** Calling-convention annotations used by the C-like renderer. */
export function swiftCallingConvention({ name = '', mangled = '', metadata = null, attributes = null } = {}) {
  const sym = demangleSwiftSymbol(mangled || name);
  const a = attributes || {};
  const async = a.async != null ? !!a.async : !!sym.async;
  const throws = a.throws != null ? !!a.throws : !!sym.throws;
  return {
    runtime: 'swift',
    swiftself: a.swiftself !== false,
    swiftasync: async,
    swiftthrows: throws,
    indirectResult: !!a.indirectResult,
    context: a.context !== false,
    errorResult: throws || !!a.errorResult,
    metadataArguments: Number(a.metadataArguments || (metadata?.generic ? 1 : 0)),
    representation: async && throws ? 'await-throwing' : async ? 'await' : throws ? 'throwing' : 'normal',
  };
}

const SWIFT_NOISE = [
  /^_?swift_(retain|release|bridgeObjectRetain|bridgeObjectRelease|unknownObjectRetain|unknownObjectRelease|beginAccess|endAccess|copyPOD|destroyPOD)\b/,
  /^_?swift_get(TypeByMangledName|SingletonMetadata|GenericMetadata|WitnessTable|AssociatedTypeWitness)\b/,
  /metadata accessor/i,
  /(copy|destroy) value witness/i,
];

export function classifySwiftRuntimeCall(name) {
  const n = String(name || '');
  if (SWIFT_NOISE.some((r) => r.test(n))) return { runtime: 'swift', noise: true, category: /metadata|TypeBy|Metadata/.test(n) ? 'metadata' : 'ownership', name: n };
  if (/^_?swift_/.test(n) || /^_?\$s/.test(n)) return { runtime: 'swift', noise: false, category: 'runtime', name: n };
  return null;
}

export function formatSwiftCall(name, args = [], convention = {}) {
  const cc = convention.representation ? convention : swiftCallingConvention({ name, attributes: convention });
  const readable = demangleSwiftSymbol(name).demangled || name || 'unknown_call';
  const prefix = cc.swiftasync ? 'await ' : '';
  const throwing = cc.swiftthrows ? 'try ' : '';
  return `${throwing}${prefix}${readable}(${args.join(', ')})`;
}
