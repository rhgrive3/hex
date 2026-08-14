import { asAddress, boundedInteger, DebugAdapterError } from '../debug/adapter.js';

export const MEMORY_KINDS = Object.freeze(['object','stack','heap','global','mapped','mmio','unknown']);
const MAX_REGION_SIZE = 64 * 1024 * 1024;
const MAX_TRANSFER = 4 * 1024 * 1024;

function normalizePermissions(value) {
  const s = String(value || 'rw').toLowerCase();
  return Object.freeze({ read: s.includes('r'), write: s.includes('w'), execute: s.includes('x') });
}

export class MemoryAccessError extends DebugAdapterError {
  constructor(code, message, details) { super(code, message, details); this.name = 'MemoryAccessError'; }
}

export class MemoryRegion {
  constructor(spec = {}) {
    this.start = asAddress(spec.start);
    this.size = boundedInteger(spec.size, 0, 1, MAX_REGION_SIZE, 'region size');
    this.end = this.start + BigInt(this.size);
    this.kind = MEMORY_KINDS.includes(spec.kind) ? spec.kind : 'mapped';
    this.name = spec.name == null ? null : String(spec.name).slice(0, 256);
    this.permissions = normalizePermissions(spec.permissions);
    this.objectId = spec.objectId == null ? null : String(spec.objectId).slice(0, 256);
  }
  contains(address, size = 1) {
    const a = asAddress(address); const n = BigInt(size);
    return a >= this.start && a + n <= this.end;
  }
  toJSON() { return { start:this.start, size:this.size, kind:this.kind, name:this.name, permissions:this.permissions, objectId:this.objectId }; }
}

export class RuntimeMemoryMap {
  constructor(regions = [], options = {}) {
    this.maxTransfer = boundedInteger(options.maxTransfer, 1024 * 1024, 1, MAX_TRANSFER, 'maxTransfer');
    this.regions = [];
    for (const region of regions) this.map(region);
  }
  map(spec) {
    const region = spec instanceof MemoryRegion ? spec : new MemoryRegion(spec);
    for (const existing of this.regions) {
      if (region.start < existing.end && region.end > existing.start) throw new MemoryAccessError('overlap', 'memory regions may not overlap', { region:region.toJSON(), existing:existing.toJSON() });
    }
    this.regions.push(region);
    this.regions.sort((a,b) => a.start < b.start ? -1 : a.start > b.start ? 1 : 0);
    return region;
  }
  unmap(start) {
    const key = asAddress(start); const before = this.regions.length;
    this.regions = this.regions.filter((r) => r.start !== key);
    return before !== this.regions.length;
  }
  find(address, size = 1) {
    const a = asAddress(address); const n = boundedInteger(size, 1, 1, this.maxTransfer, 'memory size');
    return this.regions.find((r) => r.contains(a, n)) || null;
  }
  assert(address, size, access = 'read') {
    const a = asAddress(address); const n = boundedInteger(size, 1, 1, this.maxTransfer, 'memory size');
    const region = this.find(a, n);
    if (!region) throw new MemoryAccessError('oob', `unmapped ${access} at 0x${a.toString(16)}`, { address:a, size:n, access });
    if (access === 'read' && !region.permissions.read) throw new MemoryAccessError('permission', 'memory region is not readable', { region:region.toJSON() });
    if (access === 'write' && !region.permissions.write) throw new MemoryAccessError('permission', 'memory region is not writable', { region:region.toJSON() });
    if (access === 'execute' && !region.permissions.execute) throw new MemoryAccessError('permission', 'memory region is not executable', { region:region.toJSON() });
    if (region.kind === 'mmio' && access === 'write') throw new MemoryAccessError('mmio-unknown', 'MMIO-like writes require an explicit backend handler', { region:region.toJSON() });
    return region;
  }
  snapshot() { return this.regions.map((r) => r.toJSON()); }
}

export function createSandboxMemoryMap({ objectBase = 0x600000001000n, objectSize = 0x10000, stackTop = 0x700000000000n, stackSize = 1 << 20, heapBase = 0x600000000000n, heapSize = 1 << 20, globals = [], mappings = [] } = {}) {
  const map = new RuntimeMemoryMap();
  const objStart = BigInt(objectBase), objEnd = objStart + BigInt(objectSize);
  const heapStart = BigInt(heapBase), heapEnd = heapStart + BigInt(heapSize);
  map.map({ start: objStart, size: objectSize, kind:'object', permissions:'rw', name:'fake-object' });
  // The emulator's synthetic heap and fake-object address space intentionally live
  // near one another. Preserve both without overlap: heap accesses that cross the
  // object boundary are rejected rather than silently changing region identity.
  if (heapStart < objStart) {
    const size = Number((heapEnd < objStart ? heapEnd : objStart) - heapStart);
    if (size > 0) map.map({ start:heapStart, size, kind:'heap', permissions:'rw', name:'fake-heap:low' });
  }
  if (heapEnd > objEnd) {
    const start = heapStart > objEnd ? heapStart : objEnd;
    const size = Number(heapEnd - start);
    if (size > 0) map.map({ start, size, kind:'heap', permissions:'rw', name:'fake-heap:high' });
  }
  map.map({ start: BigInt(stackTop) - BigInt(stackSize), size:stackSize, kind:'stack', permissions:'rw', name:'stack' });
  for (const g of globals) map.map({ ...g, kind:g.kind || 'global' });
  for (const m of mappings) map.map(m);
  return map;
}
