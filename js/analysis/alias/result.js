/**
 * Canonical Phase 7 alias result contract.
 *
 * P7-INV-002: relation and completeness are independent dimensions. This file
 * is the only place that is allowed to construct a `must` or `no` answer, and
 * it refuses to build one without a proof reason. That is deliberate — the
 * cheapest way to make a decompiler look good is to answer `no` when the
 * analysis simply gave up, and the only structural defence is to make the
 * strong answers impossible to spell without evidence.
 */

import { deepFreeze } from '../../core/identity/index.js';
import { createAnalysisStatus, isCompleteStatus } from '../status.js';

export const ALIAS_RESULT_SCHEMA_VERSION = 1;
export const ALIAS_RESULT_CONTRACT_VERSION = '1.0.0';

export const ALIAS_RELATIONS = Object.freeze(['must', 'may', 'no', 'unknown']);

/** Relations that require positive proof rather than absence of evidence. */
export const STRONG_ALIAS_RELATIONS = Object.freeze(['must', 'no']);

/**
 * The closed set of proof classes A1/A2 may cite.
 *
 * Adding a member here is a semantic contract change: it asserts that some new
 * kind of positive evidence is sufficient to separate or identify two
 * locations. Free-form strings would let an implementation invent a
 * justification at the call site.
 */
export const ALIAS_PROOF_REASONS = Object.freeze([
  // Separation proofs (permit `no`).
  'distinct-address-space',
  'disjoint-stack-interval',
  'disjoint-global-interval',
  'disjoint-field-interval',
  'distinct-proven-root',
  'distinct-non-escaping-allocation',
  // Identity proofs (permit `must`).
  'identical-region-identity',
  'identical-root-and-exact-offset',
  // Weak answers: recorded so `may`/`unknown` can also be explained.
  'overlapping-interval',
  'shared-root-uncertain-offset',
  'unresolved-root',
  'unresolved-offset',
  'unresolved-address-space',
  'phi-merged-roots',
  'provenance-lost',
  'union-overlap',
  'escape-unproven',
  'budget-exhausted',
  'analysis-unsupported',
]);

const SEPARATION_PROOFS = new Set([
  'distinct-address-space',
  'disjoint-stack-interval',
  'disjoint-global-interval',
  'disjoint-field-interval',
  'distinct-proven-root',
  'distinct-non-escaping-allocation',
]);

const IDENTITY_PROOFS = new Set([
  'identical-region-identity',
  'identical-root-and-exact-offset',
]);

const RELATION_SET = new Set(ALIAS_RELATIONS);
const REASON_SET = new Set(ALIAS_PROOF_REASONS);

function fail(code) { throw new TypeError(code); }

function reasonList(values) {
  if (values == null) return [];
  if (!Array.isArray(values)) fail('alias-result-invalid-reason-codes');
  const out = [...new Set(values.map((value) => String(value ?? '').trim()))];
  for (const value of out) if (!REASON_SET.has(value)) fail(`alias-result-unknown-reason:${value}`);
  return out.sort();
}

function idList(values, code) {
  if (values == null) return [];
  if (!Array.isArray(values)) fail(code);
  return [...new Set(values.map((value) => String(value ?? '').trim()).filter(Boolean))].sort();
}

/**
 * Builds an alias answer.
 *
 * The three checks below are the merge-blocking part:
 *  1. a strong relation needs at least one proof reason of the matching class;
 *  2. a strong relation cannot come out of an aborted/fail-closed run;
 *  3. a `no` cannot be justified by an identity proof (or vice versa), which
 *     catches the copy-paste mistake of citing a reason that argues the
 *     opposite of the answer given.
 */
export function createAliasResult(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('alias-result-invalid');
  const relation = String(input.relation ?? '').trim();
  if (!RELATION_SET.has(relation)) fail('alias-result-invalid-relation');
  const status = input.status?.schemaVersion ? input.status : createAnalysisStatus(input.status ?? {});
  const reasonCodes = reasonList(input.reasonCodes);

  if (STRONG_ALIAS_RELATIONS.includes(relation)) {
    if (!isCompleteStatus(status) && status.completeness !== 'bounded') {
      fail('alias-result-strong-relation-requires-sound-status');
    }
    if (!reasonCodes.length) fail('alias-result-strong-relation-requires-proof');
    if (relation === 'no' && !reasonCodes.some((code) => SEPARATION_PROOFS.has(code))) {
      fail('alias-result-no-alias-requires-separation-proof');
    }
    if (relation === 'must' && !reasonCodes.some((code) => IDENTITY_PROOFS.has(code))) {
      fail('alias-result-must-alias-requires-identity-proof');
    }
  }

  const out = {
    schemaVersion: ALIAS_RESULT_SCHEMA_VERSION,
    relation,
    reasonCodes,
    evidenceIds: idList(input.evidenceIds, 'alias-result-invalid-evidence-ids'),
    regionIds: idList(input.regionIds, 'alias-result-invalid-region-ids'),
    proof: input.proof == null ? null : input.proof,
    status,
  };
  return deepFreeze(out);
}

/**
 * The conservative answer used whenever nothing stronger is proven.
 *
 * `unknown` rather than `may`: they behave the same for transform safety, but
 * they are tracked separately in the precision metric, and collapsing them
 * would let a candidate claim precision it does not have.
 */
export function unknownAlias(status, reasonCodes = ['unresolved-root'], extra = {}) {
  return createAliasResult({ relation: 'unknown', status, reasonCodes, ...extra });
}

export function mayAlias(status, reasonCodes = ['overlapping-interval'], extra = {}) {
  return createAliasResult({ relation: 'may', status, reasonCodes, ...extra });
}

/**
 * The single question a transform is allowed to ask before moving memory
 * operations past each other. `may` and `unknown` are both refusals.
 */
export function permitsSeparationTransform(result) {
  return !!result && result.relation === 'no' && result.status.stopReason == null;
}
