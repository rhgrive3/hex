import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SORT_KIND,
  BV_UNARY_OP,
  BV_BINARY_OP,
  BV_COMPARE_OP,
  BOOL_CONNECTIVE_OP,
  CAST_OP,
  boolSort,
  bvSort,
} from '../../../js/symbolic/expr/kinds.js';
import {
  createBool,
  createBv,
  createFreshSymbol,
  createUnknownSemantic,
  createUnary,
  createBinary,
  createCompare,
  createConnective,
  createIte,
  createExtract,
  createConcat,
  createCast,
} from '../../../js/symbolic/expr/factory.js';
import {
  evaluateExpr,
  EVAL_STATUS,
} from '../../../js/symbolic/expr/evaluate.js';

test('pure evaluator evaluates constant arithmetic and bitwise trees', () => {
  // ((BV8(200) + BV8(100)) & BV8(0x0F))
  const c200 = createBv(8, 200);
  const c100 = createBv(8, 100);
  const cMask = createBv(8, 0x0F);

  const add = createBinary(BV_BINARY_OP.ADD, c200, c100); // 300 % 256 = 44 (0x2C)
  const and = createBinary(BV_BINARY_OP.AND, add, cMask);  // 44 & 0x0F = 12

  const res = evaluateExpr(and);
  assert.equal(res.status, EVAL_STATUS.VALUE);
  assert.equal(res.value, 12n);
  assert.equal(res.sort.width, 8);
});

test('pure evaluator evaluates comparisons and connectives', () => {
  const c10 = createBv(8, 10);
  const c20 = createBv(8, 20);

  const cmp1 = createCompare(BV_COMPARE_OP.ULT, c10, c20); // true
  const cmp2 = createCompare(BV_COMPARE_OP.EQ, c10, c20);  // false

  const andConn = createConnective(BOOL_CONNECTIVE_OP.AND, cmp1, cmp2); // false
  const orConn = createConnective(BOOL_CONNECTIVE_OP.OR, cmp1, cmp2);   // true
  const notConn = createConnective(BOOL_CONNECTIVE_OP.NOT, cmp2);        // true
  const impConn = createConnective(BOOL_CONNECTIVE_OP.IMPLIES, cmp1, cmp2); // false (true -> false)

  assert.equal(evaluateExpr(andConn).value, false);
  assert.equal(evaluateExpr(orConn).value, true);
  assert.equal(evaluateExpr(notConn).value, true);
  assert.equal(evaluateExpr(impConn).value, false);
});

test('pure evaluator evaluates ITE conditionals', () => {
  const cTrue = createBool(true);
  const cFalse = createBool(false);
  const cA = createBv(16, 0xAAAA);
  const cB = createBv(16, 0xBBBB);

  const ite1 = createIte(cTrue, cA, cB);
  const ite2 = createIte(cFalse, cA, cB);

  assert.equal(evaluateExpr(ite1).value, 0xAAAAn);
  assert.equal(evaluateExpr(ite2).value, 0xBBBBn);
});

test('pure evaluator substitutes environment symbols', () => {
  const symX = createFreshSymbol(bvSort(32), 'x');
  const symY = createFreshSymbol(bvSort(32), 'y');
  const add = createBinary(BV_BINARY_OP.ADD, symX, symY);

  // Without environment: returns unbound symbol
  const resUnbound = evaluateExpr(add);
  assert.equal(resUnbound.status, EVAL_STATUS.UNBOUND_SYMBOL);
  assert.equal(resUnbound.symbol.name, 'x');

  // With partial environment
  const envPartial = new Map([['x', 10n]]);
  const resPartial = evaluateExpr(add, envPartial);
  assert.equal(resPartial.status, EVAL_STATUS.UNBOUND_SYMBOL);
  assert.equal(resPartial.symbol.name, 'y');

  // With full environment
  const envFull = new Map([['x', 100n], ['y', 200n]]);
  const resFull = evaluateExpr(add, envFull);
  assert.equal(resFull.status, EVAL_STATUS.VALUE);
  assert.equal(resFull.value, 300n);
});

test('pure evaluator propagates UnknownSemantic fail-closed', () => {
  const unk = createUnknownSemantic(bvSort(32), 'unmodeled-sys-call', { syscall: 42 });
  const c1 = createBv(32, 1);
  const add = createBinary(BV_BINARY_OP.ADD, unk, c1);

  const res = evaluateExpr(add);
  assert.equal(res.status, EVAL_STATUS.UNKNOWN);
  assert.equal(res.reason, 'unmodeled-sys-call');
  assert.deepEqual(res.detail, { syscall: 42 });
});
