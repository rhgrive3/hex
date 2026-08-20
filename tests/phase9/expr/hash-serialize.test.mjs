import assert from 'node:assert/strict';
import test from 'node:test';

import {
  bvSort,
  boolSort,
  BV_BINARY_OP,
  BV_COMPARE_OP,
  BOOL_CONNECTIVE_OP,
} from '../../../js/symbolic/expr/kinds.js';
import {
  createBool,
  createBv,
  createFreshSymbol,
  createBinary,
  createCompare,
  createConnective,
} from '../../../js/symbolic/expr/factory.js';
import {
  computeStructuralHash,
  structuralEquals,
} from '../../../js/symbolic/expr/hash.js';
import {
  serializeExprDag,
  deserializeExprDag,
  EXPR_SCHEMA_VERSION,
  EXPR_DAG_VERSION,
} from '../../../js/symbolic/expr/serialize.js';

test('structural hash is deterministic and invariant to metadata differences', () => {
  const sym1 = createFreshSymbol(bvSort(32), 'x', { origin: 'loc1', row: 10 });
  const sym2 = createFreshSymbol(bvSort(32), 'x', { origin: 'loc2', row: 99 });

  const c1 = createBv(32, 42);
  const expr1 = createBinary(BV_BINARY_OP.ADD, sym1, c1);
  const expr2 = createBinary(BV_BINARY_OP.ADD, sym2, c1);

  const hash1 = computeStructuralHash(expr1);
  const hash2 = computeStructuralHash(expr2);

  // Both should have identical structural hash because metadata is excluded
  assert.equal(hash1, hash2);
  assert.equal(typeof hash1, 'string');
  assert.equal(hash1.length, 32); // stableDigest hex
});

test('structural hash distinguishes different operations, sorts, and operands', () => {
  const symX = createFreshSymbol(bvSort(32), 'x');
  const c42 = createBv(32, 42);
  const c43 = createBv(32, 43);

  const add = createBinary(BV_BINARY_OP.ADD, symX, c42);
  const sub = createBinary(BV_BINARY_OP.SUB, symX, c42);
  const addDifferentConst = createBinary(BV_BINARY_OP.ADD, symX, c43);

  const hashAdd = computeStructuralHash(add);
  const hashSub = computeStructuralHash(sub);
  const hashDiffConst = computeStructuralHash(addDifferentConst);

  assert.notEqual(hashAdd, hashSub);
  assert.notEqual(hashAdd, hashDiffConst);
});

test('structural equality provides collision safety beyond hash comparison', () => {
  const symA = createFreshSymbol(bvSort(8), 'a');
  const symB = createFreshSymbol(bvSort(8), 'b');
  const c1 = createBv(8, 1);

  const exprA = createBinary(BV_BINARY_OP.ADD, symA, c1);
  const exprA_dup = createBinary(BV_BINARY_OP.ADD, symA, c1);
  const exprB = createBinary(BV_BINARY_OP.ADD, symB, c1);

  assert.equal(structuralEquals(exprA, exprA_dup), true);
  assert.equal(structuralEquals(exprA, exprB), false);
});

test('canonical serialization is deterministic and round-trips accurately', () => {
  const symX = createFreshSymbol(bvSort(64), 'param0');
  const cMask = createBv(64, 0xFFFFFFFF00000000n);
  const andNode = createBinary(BV_BINARY_OP.AND, symX, cMask);
  const cZero = createBv(64, 0);
  const cmpNode = createCompare(BV_COMPARE_OP.EQ, andNode, cZero);

  const jsonStr1 = serializeExprDag(cmpNode, { metadata: { source: 'test' } });
  const jsonStr2 = serializeExprDag(cmpNode, { metadata: { source: 'test' } });

  // Exact deterministic string equality
  assert.equal(jsonStr1, jsonStr2);

  const parsed = JSON.parse(jsonStr1);
  assert.equal(parsed.schemaVersion, EXPR_SCHEMA_VERSION);
  assert.equal(parsed.expressionDagVersion, EXPR_DAG_VERSION);

  // Round-trip deserialization
  const roundTripped = deserializeExprDag(jsonStr1);
  assert.equal(structuralEquals(cmpNode, roundTripped), true);
  assert.equal(computeStructuralHash(cmpNode), computeStructuralHash(roundTripped));
});
