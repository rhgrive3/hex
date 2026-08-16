import { stableStringify } from '../../core/identity/index.js';
import { isPreciseMemoryRegion } from './regions-v2.js';

function widthBytes(region) {
  const bits = Number(region?.widthBits);
  if (!Number.isSafeInteger(bits) || bits <= 0) return null;
  return BigInt(Math.ceil(bits / 8));
}

function toBigInt(value) {
  try { return typeof value === 'bigint' ? value : BigInt(value); }
  catch { return null; }
}

function intervalRelation(startA, sizeA, startB, sizeB) {
  if (startA == null || startB == null || sizeA == null || sizeB == null) return 'unknown';
  if (startA === startB && sizeA === sizeB) return 'must';
  if (startA + sizeA <= startB || startB + sizeB <= startA) return 'no';
  return 'may';
}

function sameScope(a, b) {
  if (a.kind === 'stack-fixed') return a.functionId != null && a.functionId === b.functionId;
  if (a.kind === 'global-absolute') return a.binaryId != null && a.binaryId === b.binaryId;
  return true;
}

export function aliasMemoryRegions(a, b) {
  if (!a || !b) return 'unknown';
  if (a.kind === 'unknown' || b.kind === 'unknown') return 'may';
  if (!isPreciseMemoryRegion(a) || !isPreciseMemoryRegion(b)) return 'unknown';

  if (a.kind === b.kind) {
    if (!sameScope(a, b)) return 'unknown';
    if (a.kind === 'stack-fixed') {
      return intervalRelation(toBigInt(a.offset), widthBytes(a), toBigInt(b.offset), widthBytes(b));
    }
    if (a.kind === 'global-absolute') {
      return intervalRelation(toBigInt(a.address), widthBytes(a), toBigInt(b.address), widthBytes(b));
    }
    if (a.kind === 'rooted-offset') {
      if (!a.rootEntityId || !b.rootEntityId) return 'unknown';
      // A different provenance/root identity is not, by itself, a proof that
      // two runtime pointers cannot alias. Preserve the legacy conservative
      // safety floor unless a later alias analysis supplies a real separation
      // proof (for example, distinct proven non-escaping allocations).
      if (a.rootEntityId !== b.rootEntityId) return 'may';
      return intervalRelation(toBigInt(a.offset), widthBytes(a), toBigInt(b.offset), widthBytes(b));
    }
    if (a.kind === 'tls' || a.kind === 'io' || a.kind === 'physical-space') {
      if (!a.addressSpace || !b.addressSpace) return 'unknown';
      if (a.addressSpace !== b.addressSpace) return 'no';
      if (a.rootIdentity == null || b.rootIdentity == null) return 'unknown';
      if (stableStringify(a.rootIdentity) !== stableStringify(b.rootIdentity)) return 'unknown';
      const wa = widthBytes(a), wb = widthBytes(b);
      return wa != null && wb != null && wa === wb ? 'must' : 'may';
    }
    return 'unknown';
  }

  const pair = new Set([a.kind, b.kind]);
  if (pair.has('stack-fixed') && pair.has('global-absolute')) return 'no';

  const physicalKinds = new Set(['tls', 'io', 'physical-space']);
  if (physicalKinds.has(a.kind) && physicalKinds.has(b.kind) && a.addressSpace && b.addressSpace && a.addressSpace !== b.addressSpace) {
    return 'no';
  }
  return 'may';
}

export function unknownStoreAliasRelation(storeRegion, targetRegion) {
  if (!targetRegion) return 'unknown';
  if (!storeRegion || storeRegion.kind !== 'unknown') return aliasMemoryRegions(storeRegion, targetRegion);
  return 'may';
}

export function unknownStoreClobbersRegion(storeRegion, targetRegion) {
  return unknownStoreAliasRelation(storeRegion, targetRegion) !== 'no';
}

function regionAddressSpace(region) {
  if (!region) return null;
  if (region.kind === 'tls' || region.kind === 'io' || region.kind === 'physical-space') return region.addressSpace ?? null;
  if (region.kind === 'stack-fixed' || region.kind === 'global-absolute' || region.kind === 'rooted-offset') return 'memory';
  return null;
}

export function effectSummaryAliasRelation(memoryWrite, targetRegion, classifyAccess) {
  if (!memoryWrite || !targetRegion) return 'unknown';
  if (memoryWrite.scope === 'none') return 'no';
  if (memoryWrite.scope === 'unknown') return 'may';
  if (memoryWrite.scope === 'all') {
    const targetSpace = regionAddressSpace(targetRegion);
    const spaces = Array.isArray(memoryWrite.addressSpaces) ? memoryWrite.addressSpaces : [];
    if (targetSpace && spaces.length && !spaces.includes(targetSpace)) return 'no';
    return 'may';
  }
  if (memoryWrite.scope !== 'accesses' || !Array.isArray(memoryWrite.accesses) || !memoryWrite.accesses.length) return 'unknown';
  if (typeof classifyAccess !== 'function') return 'unknown';

  let sawUnknown = false;
  for (const access of memoryWrite.accesses) {
    let region;
    try { region = classifyAccess(access); }
    catch { sawUnknown = true; continue; }
    const relation = aliasMemoryRegions(region, targetRegion);
    if (relation === 'must') return 'must';
    if (relation === 'may') return 'may';
    if (relation === 'unknown') sawUnknown = true;
  }
  return sawUnknown ? 'unknown' : 'no';
}

export const ALIAS_RELATIONS = Object.freeze(['must', 'may', 'no', 'unknown']);