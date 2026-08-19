/**
 * P7-2 — points-to lattice: offset ranges and points-to sets.
 *
 * Everything expensive about A2 lives in this file's join and widening rules,
 * so they are stated explicitly rather than emerging from the solver's control
 * flow.
 *
 * Lattice, top-down:
 *   TOP    = "may point anywhere" (`top: true`) — the conservative answer.
 *   sets   = a finite union of (root, offset-range) targets.
 *   BOTTOM = the empty set — "no value reaches here yet", used only as the
 *            fixed-point seed. It is never a published answer, because an
 *            empty points-to set would falsely prove separation from everything.
 *
 * Offsets are *signed mathematical* offsets relative to a canonical root, which
 * is the same convention `canonical-address-v2-core.js` uses. They are not
 * machine addresses, so they are never reduced modulo the pointer width: a
 * wrapped interval compares as if it were small and would manufacture a false
 * `NoAlias`. Any arithmetic that could wrap is therefore widened to unbounded
 * instead (see `addRange`).
 */

import { deepFreeze, stableDigest, stableStringify } from '../../core/identity/index.js';

export const POINTS_TO_LATTICE_VERSION = '1.0.0';

/** Default iteration/size limits. Termination never relies on these alone. */
export const POINTS_TO_DEFAULT_BUDGET = Object.freeze({
  maxTargetsPerSet: 8,
  maxIterations: 32,
  widenAfterIterations: 3,
  maxValues: 65536,
});

export const PROVENANCE_LOSS_REASONS = Object.freeze([
  'integer-to-pointer',
  'width-overflow',
  'non-linear-arithmetic',
  'unresolved-load',
  'unresolved-call',
  'widened',
  'target-cap',
  'unsupported-operation',
]);

function fail(code) { throw new TypeError(code); }

function big(value) {
  if (value == null) return null;
  try { return typeof value === 'bigint' ? value : BigInt(value); }
  catch { return null; }
}

/**
 * A closed signed interval, or an unbounded end when a bound is `null`.
 * `exact` records that the range is a single proven value, which is what
 * `must` answers require.
 */
export function createOffsetRange(min, max) {
  const lo = big(min);
  const hi = big(max);
  if (lo != null && hi != null && lo > hi) fail('points-to-invalid-offset-range');
  return deepFreeze({ min: lo, max: hi, exact: lo != null && lo === hi });
}

export const UNBOUNDED_RANGE = createOffsetRange(null, null);

export function exactRange(value) {
  const v = big(value);
  if (v == null) return UNBOUNDED_RANGE;
  return createOffsetRange(v, v);
}

function rangeIsUnbounded(range) {
  return range.min == null || range.max == null;
}

export function joinRange(a, b) {
  if (a == null) return b;
  if (b == null) return a;
  const min = a.min == null || b.min == null ? null : (a.min < b.min ? a.min : b.min);
  const max = a.max == null || b.max == null ? null : (a.max > b.max ? a.max : b.max);
  return createOffsetRange(min, max);
}

/**
 * Widening: any end that moved outward since the previous iteration is thrown
 * to infinity. This is what guarantees termination for loop-carried pointer
 * phis, and it always loses precision in the safe direction.
 */
export function widenRange(previous, next) {
  if (previous == null) return next;
  let min = next.min;
  let max = next.max;
  if (previous.min == null || min == null || min < previous.min) min = null;
  if (previous.max == null || max == null || max > previous.max) max = null;
  return createOffsetRange(min, max);
}

/**
 * Signed bounds representable at `widthBits`. Used to detect the case where a
 * machine-width add could have wrapped; a wrapped offset cannot be compared as
 * an interval.
 */
function signedBounds(widthBits) {
  const bits = Number(widthBits);
  if (!Number.isSafeInteger(bits) || bits <= 1 || bits > 512) return null;
  const half = 1n << BigInt(bits - 1);
  return { min: -half, max: half - 1n };
}

/**
 * Checked range addition.
 *
 * Returns `{ range, lost }`. `lost` is set when the result could have wrapped
 * at the pointer width, in which case the range is unbounded and the caller
 * must record provenance loss instead of silently keeping a small interval.
 */
export function addRange(range, delta, widthBits) {
  const d = big(delta);
  if (d == null) return { range: UNBOUNDED_RANGE, lost: 'non-linear-arithmetic' };
  if (rangeIsUnbounded(range)) {
    const min = range.min == null ? null : range.min + d;
    const max = range.max == null ? null : range.max + d;
    return { range: createOffsetRange(min, max), lost: null };
  }
  const min = range.min + d;
  const max = range.max + d;
  const bounds = signedBounds(widthBits);
  if (bounds && (min < bounds.min || max > bounds.max)) {
    return { range: UNBOUNDED_RANGE, lost: 'width-overflow' };
  }
  return { range: createOffsetRange(min, max), lost: null };
}

/** Adds two ranges (pointer + ranged index). */
export function addRanges(a, b, widthBits) {
  if (rangeIsUnbounded(a) || rangeIsUnbounded(b)) {
    return { range: UNBOUNDED_RANGE, lost: null };
  }
  const min = a.min + b.min;
  const max = a.max + b.max;
  const bounds = signedBounds(widthBits);
  if (bounds && (min < bounds.min || max > bounds.max)) {
    return { range: UNBOUNDED_RANGE, lost: 'width-overflow' };
  }
  return { range: createOffsetRange(min, max), lost: null };
}

/**
 * Interval relation between two accesses at the same root.
 *
 * `sizeA`/`sizeB` are access widths in bytes. Anything unbounded is `may`; an
 * exact match of both position and width is `must`; provable non-overlap is
 * `no`.
 */
export function rangeRelation(a, sizeA, b, sizeB) {
  const wa = big(sizeA);
  const wb = big(sizeB);
  if (wa == null || wb == null || wa <= 0n || wb <= 0n) return 'unknown';
  if (rangeIsUnbounded(a) || rangeIsUnbounded(b)) return 'may';
  if (a.exact && b.exact) {
    if (a.min === b.min && wa === wb) return 'must';
    if (a.min + wa <= b.min || b.min + wb <= a.min) return 'no';
    return 'may';
  }
  // Non-exact ranges: separation needs the whole spans to miss each other.
  if (a.max + wa <= b.min || b.max + wb <= a.min) return 'no';
  return 'may';
}

function rootKeyOf(target) {
  return stableStringify({
    addressSpace: target.addressSpace,
    rootKind: target.rootKind,
    rootIdentity: target.rootIdentity ?? null,
    rootEntityId: target.rootEntityId ?? null,
    address: target.address ?? null,
  });
}

/** One (root, offset-range) member of a points-to set. */
export function createPointsToTarget(input = {}) {
  const target = {
    addressSpace: String(input.addressSpace ?? 'memory'),
    rootKind: String(input.rootKind ?? 'unknown'),
    rootIdentity: input.rootIdentity ?? null,
    rootEntityId: input.rootEntityId == null ? null : String(input.rootEntityId),
    address: input.address == null ? null : String(input.address),
    offsetRange: input.offsetRange ?? UNBOUNDED_RANGE,
    widthBits: input.widthBits == null ? null : Number(input.widthBits),
    evidenceIds: [...new Set((input.evidenceIds ?? []).map(String))].sort(),
  };
  target.rootKey = rootKeyOf(target);
  return deepFreeze(target);
}

/**
 * A points-to set.
 *
 * `top` and an empty `targets` list are different things and must stay
 * different: `top` means "anywhere", empty means "nothing has flowed here yet".
 */
export function createPointsToSet(input = {}) {
  const top = input.top === true;
  const targets = top ? [] : [...(input.targets ?? [])].sort((a, b) => a.rootKey.localeCompare(b.rootKey));
  const lossReasons = [...new Set(input.lossReasons ?? [])].sort();
  // A loss reason outside the declared vocabulary would be an unexplainable
  // imprecision: the alias layer maps these onto proof reasons, and a free-form
  // string there becomes an answer nobody can account for.
  for (const reason of lossReasons) {
    if (!PROVENANCE_LOSS_REASONS.includes(reason)) fail(`points-to-unknown-loss-reason:${reason}`);
  }
  return deepFreeze({
    top,
    targets: deepFreeze(targets),
    lossReasons: deepFreeze(lossReasons),
  });
}

export const BOTTOM_POINTS_TO = createPointsToSet({ targets: [] });
export function topPointsTo(reason) {
  return createPointsToSet({ top: true, lossReasons: reason ? [reason] : ['unsupported-operation'] });
}

export function pointsToIsBottom(set) {
  return !set.top && set.targets.length === 0;
}

/**
 * Set join. Same-root targets merge their ranges; distinct roots accumulate
 * until the target cap, at which point the set collapses to TOP rather than
 * silently dropping a target (dropping one would falsely prove separation).
 */
export function joinPointsTo(a, b, budget = POINTS_TO_DEFAULT_BUDGET) {
  if (a.top || b.top) {
    return createPointsToSet({ top: true, lossReasons: [...a.lossReasons, ...b.lossReasons] });
  }
  const byRoot = new Map();
  for (const target of [...a.targets, ...b.targets]) {
    const prior = byRoot.get(target.rootKey);
    if (!prior) { byRoot.set(target.rootKey, target); continue; }
    byRoot.set(target.rootKey, createPointsToTarget({
      ...prior,
      offsetRange: joinRange(prior.offsetRange, target.offsetRange),
      widthBits: prior.widthBits === target.widthBits ? prior.widthBits : null,
      evidenceIds: [...prior.evidenceIds, ...target.evidenceIds],
    }));
  }
  if (byRoot.size > (budget.maxTargetsPerSet ?? POINTS_TO_DEFAULT_BUDGET.maxTargetsPerSet)) {
    return createPointsToSet({ top: true, lossReasons: [...a.lossReasons, ...b.lossReasons, 'target-cap'] });
  }
  return createPointsToSet({
    targets: [...byRoot.values()],
    lossReasons: [...a.lossReasons, ...b.lossReasons],
  });
}

/** Widening applied at loop headers once the iteration threshold is passed. */
export function widenPointsTo(previous, next, budget = POINTS_TO_DEFAULT_BUDGET) {
  if (next.top) return next;
  if (previous == null) return next;
  if (previous.top) return previous;
  const priorByRoot = new Map(previous.targets.map((target) => [target.rootKey, target]));
  let anyWidened = false;
  const targets = next.targets.map((target) => {
    const prior = priorByRoot.get(target.rootKey);
    if (!prior) return target;
    const widenedRange = widenRange(prior.offsetRange, target.offsetRange);
    // Compare by value, not by object identity: widenRange always allocates,
    // so an identity check would report every stable range as widened and the
    // fixed point would never look converged.
    if (widenedRange.min !== target.offsetRange.min || widenedRange.max !== target.offsetRange.max) {
      anyWidened = true;
    }
    return createPointsToTarget({ ...target, offsetRange: widenedRange });
  });
  if (targets.length > (budget.maxTargetsPerSet ?? POINTS_TO_DEFAULT_BUDGET.maxTargetsPerSet)) {
    return topPointsTo('target-cap');
  }
  return createPointsToSet({
    targets,
    lossReasons: [...next.lossReasons, ...(anyWidened ? ['widened'] : [])],
  });
}

/** Structural equality, used as the fixed-point stop condition. */
export function pointsToEqual(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return false;
  return pointsToDigest(a) === pointsToDigest(b);
}

export function pointsToDigest(set) {
  return stableDigest({
    top: set.top,
    lossReasons: set.lossReasons,
    targets: set.targets.map((target) => ({
      rootKey: target.rootKey,
      min: target.offsetRange.min == null ? null : target.offsetRange.min.toString(),
      max: target.offsetRange.max == null ? null : target.offsetRange.max.toString(),
      widthBits: target.widthBits,
    })),
  });
}

/**
 * Monotonicity check used by the property tests: a join must never be lower in
 * the lattice than either input.
 */
export function pointsToLessOrEqual(a, b) {
  if (b.top) return true;
  if (a.top) return false;
  for (const target of a.targets) {
    const other = b.targets.find((candidate) => candidate.rootKey === target.rootKey);
    if (!other) return false;
    const inner = target.offsetRange;
    const outer = other.offsetRange;
    if (outer.min != null && (inner.min == null || inner.min < outer.min)) return false;
    if (outer.max != null && (inner.max == null || inner.max > outer.max)) return false;
  }
  return true;
}
