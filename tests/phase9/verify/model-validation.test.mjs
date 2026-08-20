import assert from 'node:assert/strict';
import test from 'node:test';

import { bvSort, boolSort, BV_BINARY_OP, BV_COMPARE_OP, BOOL_CONNECTIVE_OP } from '../../../js/symbolic/expr/kinds.js';
import {
  createBv,
  createBool,
  createFreshSymbol,
  createBinary,
  createCompare,
  createConnective,
  createUnknownSemantic,
} from '../../../js/symbolic/expr/factory.js';
import { createVerificationQuery, VERIFICATION_QUERY_KIND, CLAIM_KIND } from '../../../js/symbolic/verify/query.js';
import { validateSatModel } from '../../../js/symbolic/verify/validate-model.js';

test('model validator accepts valid models for arithmetic and comparison constraints', () => {
  const x = createFreshSymbol(bvSort(32), 'x');
  const c5 = createBv(32, 5n);
  const addExpr = createBinary(BV_BINARY_OP.ADD, x, c5);
  const c47 = createBv(32, 47n);
  const eqExpr = createCompare(BV_COMPARE_OP.EQ, addExpr, c47);

  const query = createVerificationQuery({
    kind: VERIFICATION_QUERY_KIND.CONDITIONAL_EDGE_FEASIBILITY,
    claimKind: CLAIM_KIND.EDGE_FEASIBLE,
    constraints: [eqExpr],
  });

  const model = new Map([['x', 42n]]);
  const res = validateSatModel(query, model);
  assert.equal(res.valid, true);

  // Object model format with BigInt
  const resObj = validateSatModel(query, { x: 42n });
  assert.equal(resObj.valid, true);

  // Object model format with { value } wrapper
  const resWrapped = validateSatModel(query, { x: { value: 42n } });
  assert.equal(resWrapped.valid, true);
});

test('model validator rejects models that violate constraints', () => {
  const x = createFreshSymbol(bvSort(32), 'x');
  const c10 = createBv(32, 10n);
  const gtExpr = createCompare(BV_COMPARE_OP.UGT, x, c10);

  const query = createVerificationQuery({
    kind: VERIFICATION_QUERY_KIND.CONDITIONAL_EDGE_FEASIBILITY,
    claimKind: CLAIM_KIND.EDGE_FEASIBLE,
    constraints: [gtExpr],
  });

  // Violating binding (x = 5 <= 10)
  const invalidModel = { x: 5n };
  const res = validateSatModel(query, invalidModel);
  assert.equal(res.valid, false);
  assert.equal(res.reason, 'constraint-violation');
  assert.equal(res.detail.expected, true);
  assert.equal(res.detail.actual, false);
});

test('model validator validates assertions independently', () => {
  const a = createFreshSymbol(boolSort(), 'a');
  const b = createFreshSymbol(boolSort(), 'b');
  const cAnd = createConnective(BOOL_CONNECTIVE_OP.AND, a, b);

  const query = createVerificationQuery({
    kind: VERIFICATION_QUERY_KIND.BOUNDED_EQUIVALENCE,
    claimKind: CLAIM_KIND.EQUIVALENT,
    constraints: [a],
    assertion: cAnd,
  });

  // Model satisfies constraint `a`, but violates assertion `a AND b` because `b = false`
  const model1 = { a: true, b: false };
  const res1 = validateSatModel(query, model1);
  assert.equal(res1.valid, false);
  assert.equal(res1.reason, 'assertion-violation');

  // Model satisfies both
  const model2 = { a: true, b: true };
  const res2 = validateSatModel(query, model2);
  assert.equal(res2.valid, true);
});

test('model validator fails closed on unbound symbols or unknown semantics', () => {
  const x = createFreshSymbol(bvSort(64), 'x');
  const y = createFreshSymbol(bvSort(64), 'y');
  const eq = createCompare(BV_COMPARE_OP.EQ, x, y);

  const query = createVerificationQuery({
    kind: VERIFICATION_QUERY_KIND.CONDITIONAL_EDGE_FEASIBILITY,
    claimKind: CLAIM_KIND.EDGE_FEASIBLE,
    constraints: [eq],
  });

  // y is missing from model
  const partialModel = { x: 100n };
  const resPartial = validateSatModel(query, partialModel);
  assert.equal(resPartial.valid, false);
  assert.equal(resPartial.reason, 'constraint-violation');
  assert.equal(resPartial.detail.status, 'unbound_symbol');

  // UnknownSemantic in constraint
  const unk = createUnknownSemantic(boolSort(), 'unsupported-hardware-flag');
  const queryUnk = createVerificationQuery({
    kind: VERIFICATION_QUERY_KIND.CONDITIONAL_EDGE_FEASIBILITY,
    claimKind: CLAIM_KIND.EDGE_FEASIBLE,
    constraints: [unk],
  });

  const resUnk = validateSatModel(queryUnk, { x: 100n });
  assert.equal(resUnk.valid, false);
  assert.equal(resUnk.reason, 'constraint-violation');
  assert.equal(resUnk.detail.status, 'unknown');
});

test('model validator handles missing or malformed models gracefully', () => {
  const query = createVerificationQuery({
    kind: VERIFICATION_QUERY_KIND.CONDITIONAL_EDGE_FEASIBILITY,
    claimKind: CLAIM_KIND.EDGE_FEASIBLE,
    constraints: [createBool(true)],
  });

  assert.equal(validateSatModel(query, null).valid, false);
  assert.equal(validateSatModel(query, undefined).valid, false);
  assert.equal(validateSatModel(query, 'not-a-model').valid, false);
});
