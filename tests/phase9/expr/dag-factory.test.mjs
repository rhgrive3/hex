import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SORT_KIND,
  EXPR_KIND,
  BV_UNARY_OP,
  BV_BINARY_OP,
  BV_COMPARE_OP,
  BOOL_CONNECTIVE_OP,
  CAST_OP,
  boolSort,
  bvSort,
  sameSort,
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

test('factory enforces strict sort validation and immutability', () => {
  const bTrue = createBool(true);
  assert.equal(bTrue.kind, EXPR_KIND.CONST);
  assert.equal(bTrue.sort.kind, SORT_KIND.BOOL);
  assert.equal(bTrue.value, true);
  assert.throws(() => { bTrue.value = false; }, TypeError);

  const bv8 = createBv(8, 255);
  assert.equal(bv8.kind, EXPR_KIND.CONST);
  assert.equal(bv8.sort.kind, SORT_KIND.BV);
  assert.equal(bv8.sort.width, 8);
  assert.equal(bv8.value, 255n);

  // Normalization on creation
  const bv8Over = createBv(8, 256);
  assert.equal(bv8Over.value, 0n);

  assert.throws(() => createBv(0, 1), TypeError);
  assert.throws(() => createBv(-8, 1), TypeError);
});

test('FreshSymbol and UnknownSemantic are strictly distinct and non-conflated', () => {
  const sym = createFreshSymbol(bvSort(32), 'x', { origin: 'arg0' });
  assert.equal(sym.kind, EXPR_KIND.FRESH_SYMBOL);
  assert.equal(sym.sort.width, 32);
  assert.equal(sym.name, 'x');
  assert.equal(sym.meta.origin, 'arg0');

  const unk = createUnknownSemantic(bvSort(32), 'unsupported-floating-point-op', { opcode: 'fadd' });
  assert.equal(unk.kind, EXPR_KIND.UNKNOWN_SEMANTIC);
  assert.notEqual(unk.kind, sym.kind);
  assert.equal(unk.reason, 'unsupported-floating-point-op');
  assert.deepEqual(unk.detail, { opcode: 'fadd' });

  // UnknownSemantic is never confused with FreshSymbol
  assert.notEqual(unk.kind, EXPR_KIND.FRESH_SYMBOL);
});

test('factory rejects width and sort mismatches in operations', () => {
  const bv8_a = createBv(8, 10);
  const bv8_b = createBv(8, 20);
  const bv32 = createBv(32, 20);
  const boolVal = createBool(true);

  // Valid binary
  const addNode = createBinary(BV_BINARY_OP.ADD, bv8_a, bv8_b);
  assert.equal(addNode.kind, EXPR_KIND.BINARY);
  assert.equal(addNode.sort.width, 8);

  // Width mismatch rejected
  assert.throws(() => createBinary(BV_BINARY_OP.ADD, bv8_a, bv32), TypeError);
  // Sort mismatch rejected
  assert.throws(() => createBinary(BV_BINARY_OP.ADD, bv8_a, boolVal), TypeError);

  // Comparison
  const cmpNode = createCompare(BV_COMPARE_OP.ULT, bv8_a, bv8_b);
  assert.equal(cmpNode.kind, EXPR_KIND.COMPARE);
  assert.equal(cmpNode.sort.kind, SORT_KIND.BOOL);
  assert.throws(() => createCompare(BV_COMPARE_OP.ULT, bv8_a, bv32), TypeError);

  // ITE sort matching
  const iteNode = createIte(cmpNode, bv8_a, bv8_b);
  assert.equal(iteNode.kind, EXPR_KIND.ITE);
  assert.equal(iteNode.sort.width, 8);
  // Condition must be bool
  assert.throws(() => createIte(bv8_a, bv8_a, bv8_b), TypeError);
  // Branches must have same sort
  assert.throws(() => createIte(cmpNode, bv8_a, bv32), TypeError);

  // Connectives
  const notNode = createConnective(BOOL_CONNECTIVE_OP.NOT, cmpNode);
  assert.equal(notNode.kind, EXPR_KIND.CONNECTIVE);
  assert.throws(() => createConnective(BOOL_CONNECTIVE_OP.NOT, bv8_a), TypeError);
  assert.throws(() => createConnective(BOOL_CONNECTIVE_OP.NOT, cmpNode, cmpNode), TypeError);

  // Extract
  const ext = createExtract(bv32, 15, 8);
  assert.equal(ext.sort.width, 8);
  assert.throws(() => createExtract(bv32, 32, 0), RangeError);
  assert.throws(() => createExtract(bv32, 5, 10), RangeError);

  // Concat
  const concat = createConcat(bv8_a, bv32);
  assert.equal(concat.sort.width, 40);

  // Cast
  const trunc = createCast(CAST_OP.TRUNC, bv32, 8);
  assert.equal(trunc.sort.width, 8);
  assert.throws(() => createCast(CAST_OP.TRUNC, bv8_a, 8), RangeError);
  const zext = createCast(CAST_OP.ZEXT, bv8_a, 16);
  assert.equal(zext.sort.width, 16);
  assert.throws(() => createCast(CAST_OP.ZEXT, bv8_a, 8), RangeError);
});
