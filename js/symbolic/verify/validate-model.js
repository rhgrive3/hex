/**
 * js/symbolic/verify/validate-model.js
 *
 * Independent SAT model validator using Hex's pure evaluator.
 * Validates that solver-returned counterexamples and witness bindings
 * genuinely satisfy all query constraints and assertions.
 */

import { evaluateExpr, EVAL_STATUS } from '../expr/evaluate.js';
import { SORT_KIND } from '../expr/kinds.js';

export function validateSatModel(query, model) {
  if (!model || (typeof model !== 'object' && !(model instanceof Map))) {
    return { valid: false, reason: 'missing-model', detail: { model } };
  }

  let constraints = [];
  let assertion = null;

  if (query) {
    if (Array.isArray(query.constraints)) {
      constraints = query.constraints;
    } else if (query.constraints) {
      constraints = [query.constraints];
    } else if (Array.isArray(query)) {
      constraints = query;
    } else if (query.expression) {
      constraints = [query.expression];
    } else if (query.kind && query.sort) {
      constraints = [query];
    }

    if (query.assertion) {
      assertion = query.assertion;
    }
  }

  // 1. Evaluate all constraints against the model bindings
  for (let i = 0; i < constraints.length; i++) {
    const c = constraints[i];
    if (!c) continue;

    const evalRes = evaluateExpr(c, model);
    if (evalRes.status !== EVAL_STATUS.VALUE) {
      return {
        valid: false,
        reason: 'constraint-violation',
        detail: {
          constraintIndex: i,
          constraint: c,
          status: evalRes.status,
          evalReason: evalRes.reason,
          symbol: evalRes.symbol?.name || evalRes.symbol?.symbolId || null,
        },
      };
    }

    if (c.sort?.kind !== SORT_KIND.BOOL) {
      return {
        valid: false,
        reason: 'invalid-query-predicate',
        detail: { constraintIndex: i, sort: c.sort },
      };
    }

    const isSatisfied = evalRes.value === true;

    if (!isSatisfied) {
      return {
        valid: false,
        reason: 'constraint-violation',
        detail: {
          constraintIndex: i,
          constraint: c,
          expected: true,
          actual: evalRes.value,
        },
      };
    }
  }

  // 2. Evaluate target assertion if present
  if (assertion) {
    const evalRes = evaluateExpr(assertion, model);
    if (evalRes.status !== EVAL_STATUS.VALUE) {
      return {
        valid: false,
        reason: 'assertion-violation',
        detail: {
          assertion,
          status: evalRes.status,
          evalReason: evalRes.reason,
          symbol: evalRes.symbol?.name || evalRes.symbol?.symbolId || null,
        },
      };
    }

    if (assertion.sort?.kind !== SORT_KIND.BOOL) {
      return { valid: false, reason: 'invalid-query-assertion', detail: { sort: assertion.sort } };
    }

    const isSatisfied = evalRes.value === true;

    if (!isSatisfied) {
      return {
        valid: false,
        reason: 'assertion-violation',
        detail: {
          assertion,
          expected: true,
          actual: evalRes.value,
        },
      };
    }
  }

  return { valid: true };
}
