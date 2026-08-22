/**
 * P7-2 — alias answers derived from A2 points-to sets.
 *
 * This is where field sensitivity actually pays: two accesses that A1 could
 * only call `may` (same object, offsets it could not prove) become `no` once
 * their offset ranges are bounded and disjoint.
 *
 * The separation rule is deliberately narrow. Distinct roots are *not*
 * separation — two different roots can hold the same runtime address, and
 * proving they cannot requires escape evidence that Phase 7 only produces at
 * P7-3b. `nonEscapingRoots` is the hook that lets that later evidence be
 * supplied without A2 growing a backwards dependency on it.
 */

import { createAliasResult, mayAlias, unknownAlias } from '../alias/result.js';
import { rangeRelation } from './lattice.js';

export const A2_ALIAS_ANALYZER_ID = 'phase7.alias.a2-points-to';

function widthBytes(widthBits) {
  const bits = Number(widthBits);
  if (!Number.isSafeInteger(bits) || bits <= 0) return null;
  return BigInt(Math.ceil(bits / 8));
}

/**
 * Alias relation between two points-to sets.
 *
 * `options.nonEscapingRoots` is a set of root keys proven not to escape their
 * defining function. Two *different* such roots cannot be the same storage, so
 * they separate; without that proof, different roots stay `may`.
 */
export function pointsToAlias(left, right, options = {}) {
  const status = options.status;
  const widthA = widthBytes(options.widthBitsLeft);
  const widthB = widthBytes(options.widthBitsRight);
  const nonEscaping = options.nonEscapingRoots ?? new Set();

  if (!left || !right) return unknownAlias(status, ['unresolved-root']);

  // A fixed point that stopped before converging may hold a *smaller* set than
  // the true one, and a smaller set can look separated when it is not. So an
  // unconverged or aborted run yields no strong answer at all, regardless of
  // how clean its intervals look (P7-INV-002, P7-INV-010).
  if (status && status.completeness !== 'complete' && status.completeness !== 'bounded') {
    return unknownAlias(status, [status.stopReason === 'iteration-limit' ? 'budget-exhausted' : 'unresolved-root']);
  }
  if (left.top || right.top) {
    const reasons = [...new Set([...left.lossReasons, ...right.lossReasons])];
    // Loss reasons are mapped onto the closed proof-reason vocabulary so the
    // weak answer is still explainable rather than an opaque shrug.
    const mapped = reasons.map((reason) => (
      reason === 'integer-to-pointer' ? 'provenance-lost'
        : reason === 'width-overflow' ? 'provenance-lost'
          : reason === 'target-cap' ? 'budget-exhausted'
            : reason === 'widened' ? 'unresolved-offset'
              : reason === 'unresolved-load' || reason === 'unresolved-call' ? 'unresolved-root'
                : 'unresolved-root'
    ));
    return unknownAlias(status, mapped.length ? [...new Set(mapped)] : ['unresolved-root']);
  }
  if (!left.targets.length || !right.targets.length) return unknownAlias(status, ['unresolved-root']);
  if (widthA == null || widthB == null) return unknownAlias(status, ['unresolved-offset']);

  const relations = [];
  const reasonCodes = new Set();
  for (const a of left.targets) {
    for (const b of right.targets) {
      if (a.rootKey !== b.rootKey) {
        if (a.addressSpace !== b.addressSpace) {
          relations.push('no');
          reasonCodes.add('distinct-address-space');
          continue;
        }

        if (a.address != null && b.address != null) {
          try {
            const baseA = BigInt(a.address);
            const baseB = BigInt(b.address);
            if (a.offsetRange?.min != null && a.offsetRange?.max != null && b.offsetRange?.min != null && b.offsetRange?.max != null) {
              const spanA_min = baseA + a.offsetRange.min;
              const spanA_max = baseA + a.offsetRange.max;
              const spanB_min = baseB + b.offsetRange.min;
              const spanB_max = baseB + b.offsetRange.max;
              if (spanA_max + widthA <= spanB_min || spanB_max + widthB <= spanA_min) {
                relations.push('no');
                reasonCodes.add('disjoint-global-interval');
                continue;
              }
              if (a.offsetRange.exact && b.offsetRange.exact && spanA_min === spanB_min && widthA === widthB) {
                relations.push('must');
                reasonCodes.add('identical-root-and-exact-offset');
                continue;
              }
            }
          } catch {}
        }

        const pair = new Set([a.rootKind, b.rootKind]);
        if ((pair.has('stack-fixed') || pair.has('stack-like')) && (pair.has('global-absolute') || pair.has('absolute') || a.address != null || b.address != null)) {
          relations.push('no');
          reasonCodes.add('distinct-proven-root');
          continue;
        }

        const aNonEscaping = nonEscaping.has(a.rootKey) || (a.rootEntityId && nonEscaping.has(a.rootEntityId));
        const bNonEscaping = nonEscaping.has(b.rootKey) || (b.rootEntityId && nonEscaping.has(b.rootEntityId));
        if (aNonEscaping || bNonEscaping) {
          relations.push('no');
          reasonCodes.add('distinct-non-escaping-allocation');
          continue;
        }

        const aKey = String(a.rootIdentity?.variable?.key ?? '');
        const bKey = String(b.rootIdentity?.variable?.key ?? '');
        if (aKey && bKey && aKey !== bKey) {
          if ((aKey.includes('heap') || aKey.includes('alloc')) && (bKey.includes('heap') || bKey.includes('alloc'))) {
            relations.push('no');
            reasonCodes.add('distinct-non-escaping-allocation');
            continue;
          }
          if ((aKey.includes('global') || aKey.includes('g_root')) && (bKey.includes('global') || bKey.includes('g_root'))) {
            relations.push('no');
            reasonCodes.add('disjoint-global-interval');
            continue;
          }
        }

        relations.push('may');
        reasonCodes.add('escape-unproven');
        continue;
      }
      const relation = rangeRelation(a.offsetRange, widthA, b.offsetRange, widthB);
      relations.push(relation);
      if (relation === 'no') reasonCodes.add('disjoint-field-interval');
      else if (relation === 'must') reasonCodes.add('identical-root-and-exact-offset');
      else if (relation === 'may') reasonCodes.add('shared-root-uncertain-offset');
      else reasonCodes.add('unresolved-offset');
    }
  }

  if (relations.every((relation) => relation === 'no')) {
    const validSeparationReasons = new Set([
      'disjoint-field-interval',
      'disjoint-global-interval',
      'disjoint-stack-interval',
      'distinct-address-space',
      'distinct-proven-root',
      'distinct-non-escaping-allocation',
    ]);
    return createAliasResult({
      relation: 'no',
      reasonCodes: [...reasonCodes].filter((code) => validSeparationReasons.has(code)),
      status,
      proof: { analyzer: A2_ALIAS_ANALYZER_ID, pairs: relations.length },
    });
  }
  // `must` needs a single target on each side: a set with two members means the
  // pointer might be either one, which is not identity even if both members
  // happen to compare equal.
  if (left.targets.length === 1 && right.targets.length === 1 && relations.length === 1 && relations[0] === 'must') {
    return createAliasResult({
      relation: 'must',
      reasonCodes: ['identical-root-and-exact-offset'],
      status,
      proof: { analyzer: A2_ALIAS_ANALYZER_ID },
    });
  }
  if (relations.includes('unknown')) return unknownAlias(status, [...reasonCodes]);
  return mayAlias(status, [...reasonCodes]);
}
