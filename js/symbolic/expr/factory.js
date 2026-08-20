/**
 * js/symbolic/expr/factory.js
 *
 * Immutable factory constructors for solver-neutral Bool/BV expression nodes.
 * Strict type-checking, sort invariants, and validation on construction.
 * FreshSymbol and UnknownSemantic are strictly distinct and non-conflated.
 */

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
  isBoolSort,
  isBvSort,
  assertValidSort,
  sameSort,
  sortToString,
} from './kinds.js';
import { wrap } from './bitvector.js';

let symbolCounter = 0;

export function resetSymbolCounterForTesting(val = 0) {
  symbolCounter = val;
}

export function createBool(value) {
  const boolVal = Boolean(value);
  return Object.freeze({
    kind: EXPR_KIND.CONST,
    sort: boolSort(),
    value: boolVal,
  });
}

export function createBv(width, value) {
  const sort = bvSort(width);
  const normalized = wrap(value, sort.width);
  return Object.freeze({
    kind: EXPR_KIND.CONST,
    sort,
    value: normalized,
  });
}

export function createFreshSymbol(sort, name, meta = {}) {
  assertValidSort(sort, 'createFreshSymbol');
  if (!name || typeof name !== 'string') {
    throw new TypeError(`createFreshSymbol: name must be a non-empty string, got ${name}`);
  }
  const id = `sym_${++symbolCounter}_${name}`;
  return Object.freeze({
    kind: EXPR_KIND.FRESH_SYMBOL,
    sort,
    name,
    symbolId: id,
    meta: Object.freeze({ ...meta }),
  });
}

export function createUnknownSemantic(sort, reason, detail = null) {
  assertValidSort(sort, 'createUnknownSemantic');
  if (!reason || typeof reason !== 'string') {
    throw new TypeError(`createUnknownSemantic: reason must be a non-empty string, got ${reason}`);
  }
  return Object.freeze({
    kind: EXPR_KIND.UNKNOWN_SEMANTIC,
    sort,
    reason,
    detail: detail ? Object.freeze(JSON.parse(JSON.stringify(detail))) : null,
  });
}

export function createUnary(op, arg) {
  if (!Object.values(BV_UNARY_OP).includes(op)) {
    throw new TypeError(`createUnary: unknown BV unary op '${op}'`);
  }
  if (!arg || !isBvSort(arg.sort)) {
    throw new TypeError(`createUnary (${op}): operand must have BV sort, got ${sortToString(arg?.sort)}`);
  }
  return Object.freeze({
    kind: EXPR_KIND.UNARY,
    sort: arg.sort,
    op,
    arg,
  });
}

export function createBinary(op, left, right) {
  if (!Object.values(BV_BINARY_OP).includes(op)) {
    throw new TypeError(`createBinary: unknown BV binary op '${op}'`);
  }
  if (!left || !isBvSort(left.sort)) {
    throw new TypeError(`createBinary (${op}): left operand must have BV sort, got ${sortToString(left?.sort)}`);
  }
  if (!right || !isBvSort(right.sort)) {
    throw new TypeError(`createBinary (${op}): right operand must have BV sort, got ${sortToString(right?.sort)}`);
  }
  if (left.sort.width !== right.sort.width) {
    throw new TypeError(
      `createBinary (${op}): operand width mismatch (left=${left.sort.width}, right=${right.sort.width})`
    );
  }
  return Object.freeze({
    kind: EXPR_KIND.BINARY,
    sort: left.sort,
    op,
    left,
    right,
  });
}

export function createCompare(op, left, right) {
  if (!Object.values(BV_COMPARE_OP).includes(op)) {
    throw new TypeError(`createCompare: unknown BV compare op '${op}'`);
  }
  if (!left || !isBvSort(left.sort)) {
    throw new TypeError(`createCompare (${op}): left operand must have BV sort, got ${sortToString(left?.sort)}`);
  }
  if (!right || !isBvSort(right.sort)) {
    throw new TypeError(`createCompare (${op}): right operand must have BV sort, got ${sortToString(right?.sort)}`);
  }
  if (left.sort.width !== right.sort.width) {
    throw new TypeError(
      `createCompare (${op}): operand width mismatch (left=${left.sort.width}, right=${right.sort.width})`
    );
  }
  return Object.freeze({
    kind: EXPR_KIND.COMPARE,
    sort: boolSort(),
    op,
    left,
    right,
  });
}

export function createConnective(op, ...args) {
  if (!Object.values(BOOL_CONNECTIVE_OP).includes(op)) {
    throw new TypeError(`createConnective: unknown boolean connective op '${op}'`);
  }
  if (args.length === 0) {
    throw new TypeError(`createConnective (${op}): requires at least one argument`);
  }
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a || !isBoolSort(a.sort)) {
      throw new TypeError(`createConnective (${op}): arg[${i}] must have Bool sort, got ${sortToString(a?.sort)}`);
    }
  }
  if (op === BOOL_CONNECTIVE_OP.NOT && args.length !== 1) {
    throw new TypeError(`createConnective (not): exactly one argument required, got ${args.length}`);
  }
  if ((op === BOOL_CONNECTIVE_OP.IMPLIES || op === BOOL_CONNECTIVE_OP.EQ || op === BOOL_CONNECTIVE_OP.NE) && args.length !== 2) {
    throw new TypeError(`createConnective (${op}): exactly two arguments required, got ${args.length}`);
  }
  return Object.freeze({
    kind: EXPR_KIND.CONNECTIVE,
    sort: boolSort(),
    op,
    args: Object.freeze([...args]),
  });
}

export function createIte(cond, thenExpr, elseExpr) {
  if (!cond || !isBoolSort(cond.sort)) {
    throw new TypeError(`createIte: condition must have Bool sort, got ${sortToString(cond?.sort)}`);
  }
  if (!thenExpr || !elseExpr) {
    throw new TypeError('createIte: thenExpr and elseExpr must be defined');
  }
  if (!sameSort(thenExpr.sort, elseExpr.sort)) {
    throw new TypeError(
      `createIte: branch sort mismatch (then=${sortToString(thenExpr.sort)}, else=${sortToString(elseExpr.sort)})`
    );
  }
  return Object.freeze({
    kind: EXPR_KIND.ITE,
    sort: thenExpr.sort,
    cond,
    thenExpr,
    elseExpr,
  });
}

export function createExtract(arg, high, low) {
  if (!arg || !isBvSort(arg.sort)) {
    throw new TypeError(`createExtract: operand must have BV sort, got ${sortToString(arg?.sort)}`);
  }
  const h = Number(high);
  const l = Number(low);
  if (!Number.isSafeInteger(h) || !Number.isSafeInteger(l) || l < 0 || h < l || h >= arg.sort.width) {
    throw new RangeError(
      `createExtract: invalid bit indices [high=${high}, low=${low}] for BV${arg.sort.width}`
    );
  }
  const outWidth = h - l + 1;
  return Object.freeze({
    kind: EXPR_KIND.EXTRACT,
    sort: bvSort(outWidth),
    arg,
    high: h,
    low: l,
  });
}

export function createConcat(left, right) {
  if (!left || !isBvSort(left.sort)) {
    throw new TypeError(`createConcat: left operand must have BV sort, got ${sortToString(left?.sort)}`);
  }
  if (!right || !isBvSort(right.sort)) {
    throw new TypeError(`createConcat: right operand must have BV sort, got ${sortToString(right?.sort)}`);
  }
  const totalWidth = left.sort.width + right.sort.width;
  return Object.freeze({
    kind: EXPR_KIND.CONCAT,
    sort: bvSort(totalWidth),
    left,
    right,
  });
}

export function createCast(op, arg, targetWidth) {
  if (!Object.values(CAST_OP).includes(op)) {
    throw new TypeError(`createCast: unknown cast op '${op}'`);
  }
  if (!arg || !isBvSort(arg.sort)) {
    throw new TypeError(`createCast (${op}): operand must have BV sort, got ${sortToString(arg?.sort)}`);
  }
  const tw = Number(targetWidth);
  if (!Number.isSafeInteger(tw) || tw <= 0) {
    throw new RangeError(`createCast (${op}): targetWidth must be a positive integer >= 1, got ${targetWidth}`);
  }
  const fw = arg.sort.width;
  if (op === CAST_OP.TRUNC && tw >= fw) {
    throw new RangeError(`createCast (trunc): targetWidth (${tw}) must be strictly less than fromWidth (${fw})`);
  }
  if ((op === CAST_OP.ZEXT || op === CAST_OP.SEXT) && tw <= fw) {
    throw new RangeError(`createCast (${op}): targetWidth (${tw}) must be strictly greater than fromWidth (${fw})`);
  }
  return Object.freeze({
    kind: EXPR_KIND.CAST,
    sort: bvSort(tw),
    op,
    arg,
    targetWidth: tw,
  });
}
