import { asArray, nonEmptyString, stableStringify } from './core.mjs';

function originAnchors(origin) {
  if (!origin || typeof origin !== 'object') return [];
  return [
    ...asArray(origin.byteRanges).map((value) => `byte:${stableStringify(value)}`),
    ...asArray(origin.virtualRanges).map((value) => `virtual:${stableStringify(value)}`),
    ...asArray(origin.instructionIds).filter(nonEmptyString).map((value) => `instruction:${value}`),
    ...asArray(origin.operationIds).filter(nonEmptyString).map((value) => `operation:${value}`),
    ...asArray(origin.bytecodeOperationIds).filter(nonEmptyString).map((value) => `operation:${value}`),
    ...asArray(origin.sourceLocations).map((value) => `source:${stableStringify(value)}`),
  ];
}

function originGroundedDirectly(origin) {
  return originAnchors(origin).length > 0;
}

function originParents(origin) {
  return asArray(origin?.parentEntityIds).filter(nonEmptyString).map(String);
}

export function verifyProvenance({ entities = [], roots = [] } = {}) {
  const byId = new Map();
  for (const entity of [...roots, ...entities]) {
    if (entity?.id != null) byId.set(String(entity.id), entity);
  }
  const rootIds = new Set(roots.filter((entity) => entity?.id != null).map((entity) => String(entity.id)));
  const rootAnchors = new Set(roots.flatMap((entity) => originAnchors(entity?.origin)));
  const cache = new Map();

  const descends = (entityId, stack = new Set()) => {
    const id = String(entityId);
    if (cache.has(id)) return cache.get(id);
    if (stack.has(id)) return false;
    const entity = byId.get(id);
    if (!entity) return false;
    const origin = entity.origin;
    if (!origin || typeof origin !== 'object') { cache.set(id, false); return false; }
    if (rootIds.has(id) && originGroundedDirectly(origin)) { cache.set(id, true); return true; }
    if (originAnchors(origin).some((anchor) => rootAnchors.has(anchor))) { cache.set(id, true); return true; }
    const nextStack = new Set(stack); nextStack.add(id);
    const grounded = originParents(origin).some((parent) => descends(parent, nextStack));
    cache.set(id, grounded);
    return grounded;
  };

  const losses = [];
  for (const entity of entities) {
    const id = entity?.id == null ? '<missing-id>' : String(entity.id);
    if (!entity?.origin || typeof entity.origin !== 'object') {
      losses.push({ id, kind: String(entity?.kind ?? 'unknown'), reason: 'origin-missing' });
      continue;
    }
    if (!descends(id)) losses.push({ id, kind: String(entity.kind ?? 'unknown'), reason: 'origin-not-grounded' });
  }
  losses.sort((a, b) => a.id.localeCompare(b.id) || a.kind.localeCompare(b.kind));
  return Object.freeze({ provenanceLossCount: losses.length, losses: Object.freeze(losses) });
}

export function collectDerivedProvenanceEntities({ ssa, memoryssa, compatibility } = {}) {
  const entities = [];
  for (const definition of asArray(ssa?.definitions)) {
    entities.push({ id: String(definition.valueId ?? definition.definitionId), kind: `ssa-${definition.kind}`, origin: definition.origin });
  }
  for (const use of asArray(ssa?.uses)) entities.push({ id: String(use.useId), kind: 'ssa-use', origin: use.origin });
  for (const definition of asArray(memoryssa?.definitions)) entities.push({ id: String(definition.id), kind: `memoryssa-${definition.kind}`, origin: definition.origin });
  for (const use of asArray(memoryssa?.uses)) entities.push({ id: String(use.id), kind: 'memoryssa-use', origin: use.origin });
  for (const item of asArray(compatibility?.provenanceEntities)) {
    entities.push({ id: String(item.id), kind: String(item.kind ?? 'compatibility-projection'), origin: item.origin });
  }
  return entities;
}

export async function verifyDeterminism({ build, variants, normalize = (value) => value } = {}) {
  if (typeof build !== 'function') throw new TypeError('determinism-build-required');
  if (!Array.isArray(variants) || variants.length < 2) throw new TypeError('determinism-two-variants-required');
  const outputs = [];
  for (const variant of variants) outputs.push(normalize(await build(variant)));
  const canonical = outputs.map((value) => stableStringify(value));
  const first = canonical[0];
  const mismatches = [];
  for (let index = 1; index < canonical.length; index += 1) {
    if (canonical[index] !== first) mismatches.push(index);
  }
  return Object.freeze({ deterministic: mismatches.length === 0, mismatchVariantIndexes: Object.freeze(mismatches), canonicalOutput: first });
}
