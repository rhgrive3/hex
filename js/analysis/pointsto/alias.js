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
        if (nonEscaping.has(a.rootKey) && nonEscaping.has(b.rootKey)) {
          relations.push('no');
          reasonCodes.add('distinct-non-escaping-allocation');
        } else if (a.addressSpace !== b.addressSpace) {
          relations.push('no');
          reasonCodes.add('distinct-address-space');
        } else {
          relations.push('may');
          reasonCodes.add('escape-unproven');
        }
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
    return createAliasResult({
      relation: 'no',
      reasonCodes: [...reasonCodes].filter((code) => code === 'disjoint-field-interval' || code === 'distinct-address-space' || code === 'distinct-non-escaping-allocation'),
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
