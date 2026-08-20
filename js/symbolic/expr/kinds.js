/**
 * js/symbolic/expr/kinds.js
 *
 * Defines solver-neutral sort kinds, expression node kinds, and operator types.
 * Enforces strict sort validation and explicit bitvector width requirements.
 */

export const SORT_KIND = Object.freeze({
  BOOL: 'bool',
  BV: 'bv',
});

export function boolSort() {
  return Object.freeze({ kind: SORT_KIND.BOOL });
}

export function bvSort(width) {
  const w = Number(width);
  if (!Number.isSafeInteger(w) || w <= 0) {
    throw new TypeError(`bvSort: width must be a positive safe integer >= 1, got ${width}`);
  }
  return Object.freeze({ kind: SORT_KIND.BV, width: w });
}

export function isBoolSort(sort) {
  return !!sort && sort.kind === SORT_KIND.BOOL;
}

export function isBvSort(sort) {
  return !!sort && sort.kind === SORT_KIND.BV && Number.isSafeInteger(sort.width) && sort.width > 0;
}

export function assertValidSort(sort, context = 'sort') {
  if (isBoolSort(sort)) return;
  if (isBvSort(sort)) return;
  throw new TypeError(`${context}: invalid sort ${JSON.stringify(sort)}`);
}

export function sameSort(a, b) {
  if (!a || !b) return false;
  if (a.kind !== b.kind) return false;
  if (a.kind === SORT_KIND.BOOL) return true;
  if (a.kind === SORT_KIND.BV) return a.width === b.width;
  return false;
}

export function sortToString(sort) {
  if (isBoolSort(sort)) return 'Bool';
  if (isBvSort(sort)) return `BV${sort.width}`;
  return 'UnknownSort';
}

export const EXPR_KIND = Object.freeze({
  CONST: 'const',
  FRESH_SYMBOL: 'fresh_symbol',
  UNKNOWN_SEMANTIC: 'unknown_semantic',
  UNARY: 'unary',
  BINARY: 'binary',
  COMPARE: 'compare',
  CONNECTIVE: 'connective',
  ITE: 'ite',
  EXTRACT: 'extract',
  CONCAT: 'concat',
  CAST: 'cast',
});

export const BV_UNARY_OP = Object.freeze({
  NOT: 'not',
  NEG: 'neg',
});

export const BV_BINARY_OP = Object.freeze({
  ADD: 'add',
  SUB: 'sub',
  MUL: 'mul',
  UDIV: 'udiv',
  SDIV: 'sdiv',
  UREM: 'urem',
  SREM: 'srem',
  AND: 'and',
  OR: 'or',
  XOR: 'xor',
  SHL: 'shl',
  LSHR: 'lshr',
  ASHR: 'ashr',
});

export const BV_COMPARE_OP = Object.freeze({
  EQ: 'eq',
  NE: 'ne',
  ULT: 'ult',
  ULE: 'ule',
  UGT: 'ugt',
  UGE: 'uge',
  SLT: 'slt',
  SLE: 'sle',
  SGT: 'sgt',
  SGE: 'sge',
});

export const BOOL_CONNECTIVE_OP = Object.freeze({
  AND: 'and',
  OR: 'or',
  NOT: 'not',
  XOR: 'xor',
  IMPLIES: 'implies',
  EQ: 'eq',
  NE: 'ne',
});

export const CAST_OP = Object.freeze({
  TRUNC: 'trunc',
  ZEXT: 'zext',
  SEXT: 'sext',
});
