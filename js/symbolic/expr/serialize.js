/**
 * js/symbolic/expr/serialize.js
 *
 * Deterministic canonical serialization and deserialization for Expr DAGs.
 * Enforces stable schema versions, sorted object keys, and exact BigInt hex representations.
 */

import {
  SORT_KIND,
  EXPR_KIND,
  boolSort,
  bvSort,
} from './kinds.js';
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
} from './factory.js';

export const EXPR_SCHEMA_VERSION = '1.0.0';
export const EXPR_DAG_VERSION = '1.0.0';

function canonicalizeObject(obj) {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }
  if (Array.isArray(obj)) {
    return obj.map(canonicalizeObject);
  }
  const sorted = {};
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = canonicalizeObject(obj[key]);
  }
  return sorted;
}

export function exprToPlain(node) {
  if (!node) return null;
  const base = {
    kind: node.kind,
    sort: node.sort.kind === SORT_KIND.BOOL ? { kind: 'bool' } : { kind: 'bv', width: node.sort.width },
  };

  switch (node.kind) {
    case EXPR_KIND.CONST:
      return {
        ...base,
        value: typeof node.value === 'bigint' ? `0x${node.value.toString(16)}` : node.value,
      };

    case EXPR_KIND.FRESH_SYMBOL:
      return {
        ...base,
        name: node.name,
        symbolId: node.symbolId,
        meta: node.meta && Object.keys(node.meta).length ? node.meta : undefined,
      };

    case EXPR_KIND.UNKNOWN_SEMANTIC:
      return {
        ...base,
        reason: node.reason,
        detail: node.detail ?? undefined,
      };

    case EXPR_KIND.UNARY:
      return {
        ...base,
        op: node.op,
        arg: exprToPlain(node.arg),
      };

    case EXPR_KIND.BINARY:
      return {
        ...base,
        op: node.op,
        left: exprToPlain(node.left),
        right: exprToPlain(node.right),
      };

    case EXPR_KIND.COMPARE:
      return {
        ...base,
        op: node.op,
        left: exprToPlain(node.left),
        right: exprToPlain(node.right),
      };

    case EXPR_KIND.CONNECTIVE:
      return {
        ...base,
        op: node.op,
        args: node.args.map(exprToPlain),
      };

    case EXPR_KIND.ITE:
      return {
        ...base,
        cond: exprToPlain(node.cond),
        thenExpr: exprToPlain(node.thenExpr),
        elseExpr: exprToPlain(node.elseExpr),
      };

    case EXPR_KIND.EXTRACT:
      return {
        ...base,
        high: node.high,
        low: node.low,
        arg: exprToPlain(node.arg),
      };

    case EXPR_KIND.CONCAT:
      return {
        ...base,
        left: exprToPlain(node.left),
        right: exprToPlain(node.right),
      };

    case EXPR_KIND.CAST:
      return {
        ...base,
        op: node.op,
        targetWidth: node.targetWidth,
        arg: exprToPlain(node.arg),
      };

    default:
      throw new TypeError(`exprToPlain: unknown node kind '${node.kind}'`);
  }
}

export function plainToExpr(plain) {
  if (!plain) return null;
  const sort = plain.sort.kind === 'bool' ? boolSort() : bvSort(plain.sort.width);

  switch (plain.kind) {
    case EXPR_KIND.CONST:
      if (sort.kind === SORT_KIND.BOOL) {
        return createBool(plain.value);
      }
      return createBv(sort.width, BigInt(plain.value));

    case EXPR_KIND.FRESH_SYMBOL:
      return createFreshSymbol(sort, plain.name, plain.meta || {});

    case EXPR_KIND.UNKNOWN_SEMANTIC:
      return createUnknownSemantic(sort, plain.reason, plain.detail);

    case EXPR_KIND.UNARY:
      return createUnary(plain.op, plainToExpr(plain.arg));

    case EXPR_KIND.BINARY:
      return createBinary(plain.op, plainToExpr(plain.left), plainToExpr(plain.right));

    case EXPR_KIND.COMPARE:
      return createCompare(plain.op, plainToExpr(plain.left), plainToExpr(plain.right));

    case EXPR_KIND.CONNECTIVE:
      return createConnective(plain.op, ...plain.args.map(plainToExpr));

    case EXPR_KIND.ITE:
      return createIte(plainToExpr(plain.cond), plainToExpr(plain.thenExpr), plainToExpr(plain.elseExpr));

    case EXPR_KIND.EXTRACT:
      return createExtract(plainToExpr(plain.arg), plain.high, plain.low);

    case EXPR_KIND.CONCAT:
      return createConcat(plainToExpr(plain.left), plainToExpr(plain.right));

    case EXPR_KIND.CAST:
      return createCast(plain.op, plainToExpr(plain.arg), plain.targetWidth);

    default:
      throw new TypeError(`plainToExpr: unknown plain node kind '${plain.kind}'`);
  }
}

export function serializeExprDag(node, options = {}) {
  const payload = {
    schemaVersion: EXPR_SCHEMA_VERSION,
    expressionDagVersion: EXPR_DAG_VERSION,
    metadata: options.metadata || {},
    root: exprToPlain(node),
  };
  const canonical = canonicalizeObject(payload);
  return JSON.stringify(canonical);
}

export function deserializeExprDag(jsonOrObject) {
  const obj = typeof jsonOrObject === 'string' ? JSON.parse(jsonOrObject) : jsonOrObject;
  if (!obj || typeof obj !== 'object') {
    throw new TypeError('deserializeExprDag: input must be a valid serialized DAG object or JSON');
  }
  if (obj.schemaVersion !== EXPR_SCHEMA_VERSION) {
    throw new Error(`deserializeExprDag: incompatible schema version ${obj.schemaVersion}, expected ${EXPR_SCHEMA_VERSION}`);
  }
  return plainToExpr(obj.root);
}
