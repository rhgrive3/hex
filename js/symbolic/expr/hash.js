/**
 * js/symbolic/expr/hash.js
 *
 * Deterministic structural hashing and collision-safe structural equality
 * for solver-neutral Bool/BV expression nodes.
 * Provenance, origin mappings, and UI metadata are strictly excluded from
 * the structural hash.
 */

import { createHash } from 'node:crypto';
import {
  EXPR_KIND,
  sortToString,
  sameSort,
} from './kinds.js';

const hashCache = new WeakMap();

function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex');
}

export function computeStructuralHash(node) {
  if (!node) return 'null';
  if (hashCache.has(node)) {
    return hashCache.get(node);
  }

  let canonicalRep = '';
  const sortStr = sortToString(node.sort);

  switch (node.kind) {
    case EXPR_KIND.CONST:
      canonicalRep = `CONST:${sortStr}:${typeof node.value === 'bigint' ? '0x' + node.value.toString(16) : String(node.value)}`;
      break;

    case EXPR_KIND.FRESH_SYMBOL:
      canonicalRep = `SYM:${sortStr}:${node.name}`;
      break;

    case EXPR_KIND.UNKNOWN_SEMANTIC:
      canonicalRep = `UNKNOWN:${sortStr}:${node.reason}:${node.detail ? JSON.stringify(node.detail) : ''}`;
      break;

    case EXPR_KIND.UNARY:
      canonicalRep = `UNARY:${node.op}:${sortStr}(${computeStructuralHash(node.arg)})`;
      break;

    case EXPR_KIND.BINARY:
      canonicalRep = `BINARY:${node.op}:${sortStr}(${computeStructuralHash(node.left)},${computeStructuralHash(node.right)})`;
      break;

    case EXPR_KIND.COMPARE:
      canonicalRep = `CMP:${node.op}(${computeStructuralHash(node.left)},${computeStructuralHash(node.right)})`;
      break;

    case EXPR_KIND.CONNECTIVE: {
      const childHashes = node.args.map(computeStructuralHash).join(',');
      canonicalRep = `CONN:${node.op}(${childHashes})`;
      break;
    }

    case EXPR_KIND.ITE:
      canonicalRep = `ITE:${sortStr}(${computeStructuralHash(node.cond)},${computeStructuralHash(node.thenExpr)},${computeStructuralHash(node.elseExpr)})`;
      break;

    case EXPR_KIND.EXTRACT:
      canonicalRep = `EXTRACT:${sortStr}[${node.high}:${node.low}](${computeStructuralHash(node.arg)})`;
      break;

    case EXPR_KIND.CONCAT:
      canonicalRep = `CONCAT:${sortStr}(${computeStructuralHash(node.left)},${computeStructuralHash(node.right)})`;
      break;

    case EXPR_KIND.CAST:
      canonicalRep = `CAST:${node.op}:${sortStr}(${computeStructuralHash(node.arg)})`;
      break;

    default:
      canonicalRep = `GENERIC:${node.kind}:${sortStr}`;
  }

  const hash = sha256Hex(canonicalRep);
  hashCache.set(node, hash);
  return hash;
}

export function structuralEquals(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.kind !== b.kind) return false;
  if (!sameSort(a.sort, b.sort)) return false;

  switch (a.kind) {
    case EXPR_KIND.CONST:
      return a.value === b.value;

    case EXPR_KIND.FRESH_SYMBOL:
      return a.name === b.name;

    case EXPR_KIND.UNKNOWN_SEMANTIC:
      return a.reason === b.reason && JSON.stringify(a.detail) === JSON.stringify(b.detail);

    case EXPR_KIND.UNARY:
      return a.op === b.op && structuralEquals(a.arg, b.arg);

    case EXPR_KIND.BINARY:
      return a.op === b.op && structuralEquals(a.left, b.left) && structuralEquals(a.right, b.right);

    case EXPR_KIND.COMPARE:
      return a.op === b.op && structuralEquals(a.left, b.left) && structuralEquals(a.right, b.right);

    case EXPR_KIND.CONNECTIVE:
      if (a.op !== b.op || a.args.length !== b.args.length) return false;
      for (let i = 0; i < a.args.length; i++) {
        if (!structuralEquals(a.args[i], b.args[i])) return false;
      }
      return true;

    case EXPR_KIND.ITE:
      return (
        structuralEquals(a.cond, b.cond) &&
        structuralEquals(a.thenExpr, b.thenExpr) &&
        structuralEquals(a.elseExpr, b.elseExpr)
      );

    case EXPR_KIND.EXTRACT:
      return a.high === b.high && a.low === b.low && structuralEquals(a.arg, b.arg);

    case EXPR_KIND.CONCAT:
      return structuralEquals(a.left, b.left) && structuralEquals(a.right, b.right);

    case EXPR_KIND.CAST:
      return a.op === b.op && a.targetWidth === b.targetWidth && structuralEquals(a.arg, b.arg);

    default:
      return false;
  }
}
