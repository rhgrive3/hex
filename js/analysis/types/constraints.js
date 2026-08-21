/**
 * P7-4 — type constraint model.
 *
 * The type architecture has four layers, and they are kept apart even when
 * their representations happen to be compatible (§10):
 *
 *   MachineType             — what the hardware moved: width, class, address space
 *   ABIType                 — how a value was passed or returned
 *   RecoveredStructuralType — inferred layout: fields, intervals, arrays
 *   NominalLanguageType     — a named source-language type
 *
 * Collapsing them is tempting because `int32` at the machine layer and `int` at
 * the nominal layer often coincide. They are still different claims with
 * different authority, and a contradiction at one layer says nothing about the
 * others.
 *
 * The other structural rule is P7-INV-005: hard and soft evidence are separate
 * kinds, not two ends of one confidence scale. Soft evidence ranks candidates;
 * it can never erase a hard contradiction, and no amount of it promotes a
 * conclusion to certainty.
 */

import { deepFreeze, stableDigest, stableStringify } from '../../core/identity/index.js';

export const TYPE_CONSTRAINT_SCHEMA_VERSION = 1;

export const TYPE_LAYERS = Object.freeze([
  'machine',
  'abi',
  'structural',
  'nominal',
]);

/**
 * Hard constraint kinds. Each is something the binary or a verified authority
 * *states*, not something an analysis guessed.
 */
export const HARD_CONSTRAINT_KINDS = Object.freeze([
  'access-width',
  'abi-location',
  'debug-type',
  'runtime-metadata-type',
  'pointer-stride',
  'call-prototype',
  'user-declared',
]);

/** Soft evidence kinds. These rank candidates and nothing more. */
export const SOFT_EVIDENCE_KINDS = Object.freeze([
  'symbol-spelling',
  'selector-pattern',
  'runtime-library-pattern',
  'use-shape',
  'array-stride-heuristic',
  'signature-candidate',
  'decompiler-hint',
]);

/**
 * Where a constraint's authority comes from. `debug-matched` is deliberately
 * distinct from `debug-unmatched`: only an identity-verified debug source may
 * ever produce a hard constraint (P7-5, FM-7).
 */
export const CONSTRAINT_ORIGINS = Object.freeze([
  'binary-evidence',
  'abi-boundary',
  'debug-matched',
  'debug-unmatched',
  'runtime-verified',
  'runtime-observed',
  'library-model',
  'user-approved',
  'heuristic',
]);

/** Origins permitted to state a hard constraint. */
const HARD_ORIGINS = new Set(['binary-evidence', 'abi-boundary', 'debug-matched', 'runtime-verified', 'user-approved']);

const LAYER_SET = new Set(TYPE_LAYERS);
const HARD_SET = new Set(HARD_CONSTRAINT_KINDS);
const SOFT_SET = new Set(SOFT_EVIDENCE_KINDS);
const ORIGIN_SET = new Set(CONSTRAINT_ORIGINS);

function fail(code) { throw new TypeError(code); }

function nonEmpty(value, code) {
  const text = String(value ?? '').trim();
  if (!text) fail(code);
  return text;
}

function idList(values, code) {
  if (values == null) return [];
  if (!Array.isArray(values)) fail(code);
  return [...new Set(values.map((value) => nonEmpty(value, code)))].sort();
}

/**
 * A type claim at one layer.
 *
 * `descriptor` is layer-specific and opaque here; two claims are compared by
 * their canonical serialization, so equality means "the same claim", not "the
 * same object".
 */
export function createTypeClaim(input = {}) {
  const layer = nonEmpty(input.layer, 'type-claim-layer-required');
  if (!LAYER_SET.has(layer)) fail('type-claim-invalid-layer');
  const claim = {
    layer,
    entityId: nonEmpty(input.entityId, 'type-claim-entity-required'),
    descriptor: input.descriptor ?? null,
  };
  if (claim.descriptor == null) fail('type-claim-descriptor-required');
  claim.key = stableDigest({ layer: claim.layer, entityId: claim.entityId, descriptor: claim.descriptor });
  return deepFreeze(claim);
}

export function createHardConstraint(input = {}) {
  const kind = nonEmpty(input.kind, 'hard-constraint-kind-required');
  if (!HARD_SET.has(kind)) fail('hard-constraint-invalid-kind');
  const origin = nonEmpty(input.origin, 'hard-constraint-origin-required');
  if (!ORIGIN_SET.has(origin)) fail('hard-constraint-invalid-origin');
  // The structural guard against FM-7: a heuristic or an unmatched debug file
  // cannot state a hard fact no matter how confident it sounds.
  if (!HARD_ORIGINS.has(origin)) fail(`hard-constraint-origin-not-authoritative:${origin}`);
  return deepFreeze({
    kind,
    origin,
    claim: createTypeClaim(input.claim ?? {}),
    evidenceIds: idList(input.evidenceIds, 'hard-constraint-invalid-evidence-ids'),
    providerVersion: input.providerVersion == null ? null : String(input.providerVersion),
    buildIdentity: input.buildIdentity == null ? null : String(input.buildIdentity),
  });
}

export function createSoftEvidence(input = {}) {
  const kind = nonEmpty(input.kind, 'soft-evidence-kind-required');
  if (!SOFT_SET.has(kind)) fail('soft-evidence-invalid-kind');
  const origin = nonEmpty(input.origin ?? 'heuristic', 'soft-evidence-origin-required');
  if (!ORIGIN_SET.has(origin)) fail('soft-evidence-invalid-origin');
  const weight = Number(input.weight ?? 0.5);
  if (!Number.isFinite(weight) || weight < 0 || weight > 1) fail('soft-evidence-invalid-weight');
  return deepFreeze({
    kind,
    origin,
    claim: createTypeClaim(input.claim ?? {}),
    weight,
    evidenceIds: idList(input.evidenceIds, 'soft-evidence-invalid-evidence-ids'),
  });
}

/**
 * Do two claims at the same layer conflict?
 *
 * Equality is not the same as representational compatibility. Two claims that
 * describe the same storage differently are compatible; two that describe it
 * *incompatibly* conflict. Anything the comparison cannot decide is reported as
 * a conflict rather than waved through, because an undetected contradiction is
 * how false certainty gets published.
 */
export function claimsConflict(left, right) {
  if (left.layer !== right.layer) return false;
  if (left.entityId !== right.entityId) return false;
  if (left.key === right.key) return false;

  const a = left.descriptor;
  const b = right.descriptor;
  if (a == null || b == null) return true;

  if (left.layer === 'machine') {
    // Different widths for the same access are a genuine contradiction; a
    // different class at the same width is too (an integer is not a pointer).
    if (a.widthBits != null && b.widthBits != null && a.widthBits !== b.widthBits) return true;
    if (a.class != null && b.class != null && a.class !== b.class) return true;
    if (a.addressSpace != null && b.addressSpace != null && a.addressSpace !== b.addressSpace) return true;
    return false;
  }
  if (left.layer === 'abi') {
    if (a.location != null && b.location != null && a.location !== b.location) return true;
    if (a.passingClass != null && b.passingClass != null && a.passingClass !== b.passingClass) return true;
    return false;
  }
  if (left.layer === 'structural') {
    // Overlapping byte intervals with incompatible member types conflict;
    // disjoint intervals coexist happily in one aggregate.
    const overlap = intervalsOverlap(a, b);
    if (!overlap) return false;
    if (a.memberType != null && b.memberType != null && stableStringify(a.memberType) !== stableStringify(b.memberType)) return true;
    return false;
  }
  // Nominal types: two different names for one entity is a conflict unless one
  // is declared an alias of the other.
  if (a.name != null && b.name != null) {
    if (a.name === b.name) return false;
    const aliases = new Set([...(a.aliases ?? []), ...(b.aliases ?? [])]);
    return !(aliases.has(a.name) && aliases.has(b.name));
  }
  return true;
}

function toBigInt(val, fallback = 0n) {
  if (val == null) return fallback;
  if (typeof val === 'bigint') return val;
  if (typeof val === 'number') {
    if (!Number.isFinite(val)) return null;
    return BigInt(Math.trunc(val));
  }
  try { return BigInt(val); } catch { return null; }
}

function intervalsOverlap(a, b) {
  const aStart = toBigInt(a.offset, 0n);
  const bStart = toBigInt(b.offset, 0n);
  const aSize = toBigInt(a.sizeBytes, 0n);
  const bSize = toBigInt(b.sizeBytes, 0n);
  if (aStart == null || bStart == null || aSize == null || bSize == null || aSize <= 0n || bSize <= 0n) return true;
  return aStart < bStart + bSize && bStart < aStart + aSize;
}

/** A recorded contradiction. It is a first-class result, not an error. */
export function createContradiction(input = {}) {
  return deepFreeze({
    layer: nonEmpty(input.layer, 'contradiction-layer-required'),
    entityId: nonEmpty(input.entityId, 'contradiction-entity-required'),
    left: input.left,
    right: input.right,
    detail: input.detail == null ? null : String(input.detail),
  });
}
