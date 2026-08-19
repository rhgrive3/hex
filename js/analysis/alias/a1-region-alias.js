/**
 * P7-1 — A1 coarse region alias analysis.
 *
 * A1 answers "can these two memory regions be the same storage?" using only
 * facts that region identity already carries: address space, frame/image scope,
 * fixed intervals, and canonical root identity. It deliberately does not try to
 * solve points-to; that is A2's job.
 *
 * Two design points are load-bearing.
 *
 * First, A1 does not reimplement separation. It delegates the relation to the
 * existing conservative floor in `legacy-safety-floor.js` and then *explains*
 * that relation with a machine-readable proof reason. Reimplementing interval
 * logic beside the floor would create exactly the second semantic engine the
 * architecture forbids, and would let the two drift apart silently.
 *
 * Second, the only place A1 is allowed to be stronger than the floor is where
 * it holds a positive proof the floor does not consult — currently, proven
 * distinct physical address spaces. Any such refinement is cross-checked
 * against the floor, and a contradiction collapses to the weaker answer rather
 * than picking the more useful one.
 */

import { stableStringify } from '../../core/identity/index.js';
import { createAnalysisStatus } from '../status.js';
import { createAliasResult, mayAlias, unknownAlias } from './result.js';
import { aliasMemoryRegions } from './legacy-safety-floor.js';
import { isPreciseMemoryRegion, sameMemoryRegionIdentity } from './regions-v2.js';

export const A1_ANALYZER_ID = 'phase7.alias.a1-region';
export const A1_ANALYZER_VERSION = '1.0.0';

/**
 * Region kinds that live in one flat byte-addressed space. Two of these can
 * always alias each other for address-space purposes; separation must come from
 * intervals or roots instead.
 */
const FLAT_MEMORY_KINDS = new Set(['stack-fixed', 'global-absolute', 'rooted-offset']);

/** Region kinds that carry their own explicit, self-describing address space. */
const EXPLICIT_SPACE_KINDS = new Set(['tls', 'io', 'physical-space']);

const FLAT_MEMORY_SPACE = 'memory';

function toBigInt(value) {
  try { return typeof value === 'bigint' ? value : BigInt(value); }
  catch { return null; }
}

function widthBytes(region) {
  const bits = Number(region?.widthBits);
  if (!Number.isSafeInteger(bits) || bits <= 0) return null;
  return BigInt(Math.ceil(bits / 8));
}

/**
 * The address space a region provably occupies, or `null` when unproven.
 *
 * `null` is not "some default space" — an unknown region has no proven space at
 * all, and returning a default here would manufacture separation proofs out of
 * missing information.
 */
export function provenAddressSpace(region) {
  if (!region) return null;
  if (FLAT_MEMORY_KINDS.has(region.kind)) return FLAT_MEMORY_SPACE;
  if (EXPLICIT_SPACE_KINDS.has(region.kind)) {
    const space = region.addressSpace == null ? null : String(region.addressSpace).trim();
    return space || null;
  }
  return null;
}

/**
 * True when the two regions are proven to sit in physically different address
 * spaces. This is the one separation proof A1 adds on top of the floor.
 */
function provenDistinctAddressSpace(a, b) {
  const left = provenAddressSpace(a);
  const right = provenAddressSpace(b);
  if (left == null || right == null) return false;
  return left !== right;
}

/**
 * Names the evidence behind whatever relation the floor produced.
 *
 * A relation with no nameable proof cannot be reported as strong; the caller
 * downgrades in that case rather than shipping an unexplained `no`.
 */
function explainRelation(relation, a, b) {
  if (relation === 'no') {
    if (provenDistinctAddressSpace(a, b)) return ['distinct-address-space'];
    if (a.kind === 'stack-fixed' && b.kind === 'stack-fixed') return ['disjoint-stack-interval'];
    if (a.kind === 'global-absolute' && b.kind === 'global-absolute') return ['disjoint-global-interval'];
    if (a.kind === 'rooted-offset' && b.kind === 'rooted-offset') return ['disjoint-field-interval'];
    // Cross-kind separation the floor proves from explicit storage classes:
    // stack-vs-global and stack-vs-external-entry memory.
    const kinds = new Set([a.kind, b.kind]);
    if (kinds.has('stack-fixed') && (kinds.has('global-absolute') || kinds.has('rooted-offset'))) {
      return ['distinct-proven-root'];
    }
    if (EXPLICIT_SPACE_KINDS.has(a.kind) && EXPLICIT_SPACE_KINDS.has(b.kind)) return ['distinct-address-space'];
    return [];
  }
  if (relation === 'must') {
    if (sameMemoryRegionIdentity(a, b)) return ['identical-region-identity'];
    const offsetA = a.kind === 'global-absolute' ? toBigInt(a.address) : toBigInt(a.offset);
    const offsetB = b.kind === 'global-absolute' ? toBigInt(b.address) : toBigInt(b.offset);
    if (offsetA != null && offsetA === offsetB && widthBytes(a) != null && widthBytes(a) === widthBytes(b)) {
      return ['identical-root-and-exact-offset'];
    }
    if (EXPLICIT_SPACE_KINDS.has(a.kind) && a.kind === b.kind
      && a.addressSpace === b.addressSpace
      && a.rootIdentity != null && stableStringify(a.rootIdentity) === stableStringify(b.rootIdentity)) {
      return ['identical-root-and-exact-offset'];
    }
    return [];
  }
  if (relation === 'may') {
    if (a.kind === 'unknown' || b.kind === 'unknown') return ['unresolved-root'];
    if (a.kind === 'rooted-offset' && b.kind === 'rooted-offset' && a.rootEntityId !== b.rootEntityId) {
      // Distinct roots are not separation by themselves: two roots can hold the
      // same runtime address. Separation waits for P7-3 escape evidence.
      return ['escape-unproven'];
    }
    return ['overlapping-interval'];
  }
  if (!isPreciseMemoryRegion(a) || !isPreciseMemoryRegion(b)) return ['unresolved-root'];
  return ['unresolved-offset'];
}

function statusFor(options) {
  if (options?.status) return options.status;
  return createAnalysisStatus({
    snapshotId: options?.snapshotId ?? 'snapshot-unbound',
    analyzerId: A1_ANALYZER_ID,
    analyzerVersion: A1_ANALYZER_VERSION,
    completeness: 'complete',
    budgetClass: options?.budgetClass ?? null,
  });
}

/**
 * A1 region alias query.
 *
 * Returns a full `AliasResult`, never a bare relation string, so completeness
 * and proof travel with the answer to every consumer.
 */
export function a1RegionAlias(a, b, options = {}) {
  const status = statusFor(options);

  // A cancelled or budget-exhausted caller may not receive a strong answer at
  // all, regardless of what the regions look like (P7-INV-010).
  if (status.stopReason != null && status.completeness !== 'bounded') {
    return unknownAlias(status, ['budget-exhausted'], { regionIds: [a?.id, b?.id].filter(Boolean) });
  }

  if (!a || !b) return unknownAlias(status, ['unresolved-root']);

  const regionIds = [a.id, b.id].filter(Boolean);
  const floor = aliasMemoryRegions(a, b);

  // The one A1 refinement over the floor. It is checked against the floor
  // rather than trusted: if the floor believes these two regions must alias,
  // then our address-space belief is wrong and the honest answer is unknown.
  if (floor !== 'no' && provenDistinctAddressSpace(a, b)) {
    if (floor === 'must') {
      return unknownAlias(status, ['unresolved-address-space'], { regionIds });
    }
    return createAliasResult({
      relation: 'no',
      reasonCodes: ['distinct-address-space'],
      regionIds,
      status,
      proof: { left: provenAddressSpace(a), right: provenAddressSpace(b), refinement: 'a1-address-space' },
    });
  }

  const reasonCodes = explainRelation(floor, a, b);

  if (floor === 'no' || floor === 'must') {
    // An unexplainable strong relation is downgraded rather than published.
    // The floor is conservative, so this can only lose precision, never
    // soundness — and it guarantees every strong A1 answer carries a proof.
    if (!reasonCodes.length) {
      return mayAlias(status, ['overlapping-interval'], { regionIds });
    }
    return createAliasResult({ relation: floor, reasonCodes, regionIds, status });
  }

  if (floor === 'may') return mayAlias(status, reasonCodes.length ? reasonCodes : ['overlapping-interval'], { regionIds });
  return unknownAlias(status, reasonCodes.length ? reasonCodes : ['unresolved-root'], { regionIds });
}

/**
 * Adapter for the MemorySSA `queryAlias` provider seam.
 *
 * MemorySSA is the canonical consumer of alias facts; wiring A1 in here instead
 * of giving consumers a private path is what keeps one semantic truth.
 */
export function createA1AliasProvider(options = {}) {
  const status = statusFor(options);
  return function queryAlias(left, right) {
    const result = a1RegionAlias(left, right, { ...options, status });
    return {
      relation: result.relation,
      reasonCodes: result.reasonCodes,
      evidenceIds: result.evidenceIds,
      proof: {
        analyzerId: result.status.analyzerId,
        analyzerVersion: result.status.analyzerVersion,
        completeness: result.status.completeness,
        stopReason: result.status.stopReason,
        regionIds: result.regionIds,
      },
    };
  };
}
