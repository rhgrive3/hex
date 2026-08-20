/**
 * js/symbolic/expr/evaluate.js
 *
 * Pure deterministic evaluator for Bool and BV expression DAGs.
 * Correctly handles concrete evaluation, environment symbol substitution,
 * unknown semantic propagation, and unbound symbols.
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
  isBoolSort,
  isBvSort,
} from './kinds.js';
import {
  wrap,
  toUnsigned,
  toSigned,
  bvAdd,
  bvSub,
  bvMul,
  bvUdiv,
  bvUrem,
  bvSdiv,
  bvSrem,
  bvAnd,
  bvOr,
  bvXor,
  bvNot,
  bvNeg,
  bvShl,
  bvLshr,
  bvAshr,
  bvEq,
  bvNe,
  bvUlt,
  bvUle,
  bvUgt,
  bvUge,
  bvSlt,
  bvSle,
  bvSgt,
  bvSge,
  bvTrunc,
  bvZext,
  bvSext,
  bvExtract,
  bvConcat,
} from './bitvector.js';

export const EVAL_STATUS = Object.freeze({
  VALUE: 'value',
  UNKNOWN: 'unknown',
  UNBOUND_SYMBOL: 'unbound_symbol',
});

function lookupEnv(name, id, env) {
  if (!env) return undefined;
  if (env instanceof Map) {
    if (id != null && env.has(id)) return env.get(id);
    if (name != null && env.has(name)) return env.get(name);
    return undefined;
  }
  if (typeof env === 'object') {
    if (id != null && Object.prototype.hasOwnProperty.call(env, id)) return env[id];
    if (name != null && Object.prototype.hasOwnProperty.call(env, name)) return env[name];
    return undefined;
  }
  return undefined;
}

export function evaluateExpr(expr, env = null) {
  if (!expr) {
    return { status: EVAL_STATUS.UNKNOWN, reason: 'missing-expression' };
  }

  switch (expr.kind) {
    case EXPR_KIND.CONST:
      return { status: EVAL_STATUS.VALUE, sort: expr.sort, value: expr.value };

    case EXPR_KIND.FRESH_SYMBOL: {
      const bound = lookupEnv(expr.name, expr.symbolId, env);
      if (bound === undefined) {
        return { status: EVAL_STATUS.UNBOUND_SYMBOL, symbol: expr };
      }
      if (isBoolSort(expr.sort)) {
        const val = typeof bound === 'object' && bound !== null && 'value' in bound ? bound.value : bound;
        return { status: EVAL_STATUS.VALUE, sort: expr.sort, value: Boolean(val) };
      }
      if (isBvSort(expr.sort)) {
        const raw = typeof bound === 'object' && bound !== null && 'value' in bound ? bound.value : bound;
        const val = wrap(raw, expr.sort.width);
        return { status: EVAL_STATUS.VALUE, sort: expr.sort, value: val };
      }
      return { status: EVAL_STATUS.UNKNOWN, reason: 'unsupported-symbol-sort' };
    }

    case EXPR_KIND.UNKNOWN_SEMANTIC:
      return {
        status: EVAL_STATUS.UNKNOWN,
        reason: expr.reason,
        detail: expr.detail,
        sort: expr.sort,
      };

    case EXPR_KIND.UNARY: {
      const sub = evaluateExpr(expr.arg, env);
      if (sub.status !== EVAL_STATUS.VALUE) return sub;
      const w = expr.sort.width;
      let val;
      if (expr.op === BV_UNARY_OP.NOT) val = bvNot(sub.value, w);
      else if (expr.op === BV_UNARY_OP.NEG) val = bvNeg(sub.value, w);
      else return { status: EVAL_STATUS.UNKNOWN, reason: `unsupported-unary-op-${expr.op}` };
      return { status: EVAL_STATUS.VALUE, sort: expr.sort, value: val };
    }

    case EXPR_KIND.BINARY: {
      const l = evaluateExpr(expr.left, env);
      if (l.status !== EVAL_STATUS.VALUE) return l;
      const r = evaluateExpr(expr.right, env);
      if (r.status !== EVAL_STATUS.VALUE) return r;
      const w = expr.sort.width;
      let val;
      switch (expr.op) {
        case BV_BINARY_OP.ADD: val = bvAdd(l.value, r.value, w); break;
        case BV_BINARY_OP.SUB: val = bvSub(l.value, r.value, w); break;
        case BV_BINARY_OP.MUL: val = bvMul(l.value, r.value, w); break;
        case BV_BINARY_OP.UDIV: val = bvUdiv(l.value, r.value, w); break;
        case BV_BINARY_OP.SDIV: val = bvSdiv(l.value, r.value, w); break;
        case BV_BINARY_OP.UREM: val = bvUrem(l.value, r.value, w); break;
        case BV_BINARY_OP.SREM: val = bvSrem(l.value, r.value, w); break;
        case BV_BINARY_OP.AND: val = bvAnd(l.value, r.value, w); break;
        case BV_BINARY_OP.OR: val = bvOr(l.value, r.value, w); break;
        case BV_BINARY_OP.XOR: val = bvXor(l.value, r.value, w); break;
        case BV_BINARY_OP.SHL: val = bvShl(l.value, r.value, w); break;
        case BV_BINARY_OP.LSHR: val = bvLshr(l.value, r.value, w); break;
        case BV_BINARY_OP.ASHR: val = bvAshr(l.value, r.value, w); break;
        default: return { status: EVAL_STATUS.UNKNOWN, reason: `unsupported-binary-op-${expr.op}` };
      }
      return { status: EVAL_STATUS.VALUE, sort: expr.sort, value: val };
    }

    case EXPR_KIND.COMPARE: {
      const l = evaluateExpr(expr.left, env);
      if (l.status !== EVAL_STATUS.VALUE) return l;
      const r = evaluateExpr(expr.right, env);
      if (r.status !== EVAL_STATUS.VALUE) return r;
      const w = expr.left.sort.width;
      let res;
      switch (expr.op) {
        case BV_COMPARE_OP.EQ: res = bvEq(l.value, r.value, w); break;
        case BV_COMPARE_OP.NE: res = bvNe(l.value, r.value, w); break;
        case BV_COMPARE_OP.ULT: res = bvUlt(l.value, r.value, w); break;
        case BV_COMPARE_OP.ULE: res = bvUle(l.value, r.value, w); break;
        case BV_COMPARE_OP.UGT: res = bvUgt(l.value, r.value, w); break;
        case BV_COMPARE_OP.UGE: res = bvUge(l.value, r.value, w); break;
        case BV_COMPARE_OP.SLT: res = bvSlt(l.value, r.value, w); break;
        case BV_COMPARE_OP.SLE: res = bvSle(l.value, r.value, w); break;
        case BV_COMPARE_OP.SGT: res = bvSgt(l.value, r.value, w); break;
        case BV_COMPARE_OP.SGE: res = bvSge(l.value, r.value, w); break;
        default: return { status: EVAL_STATUS.UNKNOWN, reason: `unsupported-compare-op-${expr.op}` };
      }
      return { status: EVAL_STATUS.VALUE, sort: boolSort(), value: Boolean(res) };
    }

    case EXPR_KIND.CONNECTIVE: {
      if (expr.op === BOOL_CONNECTIVE_OP.NOT) {
        const sub = evaluateExpr(expr.args[0], env);
        if (sub.status !== EVAL_STATUS.VALUE) return sub;
        return { status: EVAL_STATUS.VALUE, sort: boolSort(), value: !sub.value };
      }
      if (expr.op === BOOL_CONNECTIVE_OP.AND) {
        let hasPending = null;
        for (const a of expr.args) {
          const res = evaluateExpr(a, env);
          if (res.status === EVAL_STATUS.VALUE && res.value === false) {
            return { status: EVAL_STATUS.VALUE, sort: boolSort(), value: false };
          }
          if (res.status !== EVAL_STATUS.VALUE && !hasPending) {
            hasPending = res;
          }
        }
        if (hasPending) return hasPending;
        return { status: EVAL_STATUS.VALUE, sort: boolSort(), value: true };
      }
      if (expr.op === BOOL_CONNECTIVE_OP.OR) {
        let hasPending = null;
        for (const a of expr.args) {
          const res = evaluateExpr(a, env);
          if (res.status === EVAL_STATUS.VALUE && res.value === true) {
            return { status: EVAL_STATUS.VALUE, sort: boolSort(), value: true };
          }
          if (res.status !== EVAL_STATUS.VALUE && !hasPending) {
            hasPending = res;
          }
        }
        if (hasPending) return hasPending;
        return { status: EVAL_STATUS.VALUE, sort: boolSort(), value: false };
      }
      if (expr.op === BOOL_CONNECTIVE_OP.XOR) {
        let count = 0;
        for (const a of expr.args) {
          const res = evaluateExpr(a, env);
          if (res.status !== EVAL_STATUS.VALUE) return res;
          if (res.value) count++;
        }
        return { status: EVAL_STATUS.VALUE, sort: boolSort(), value: count % 2 === 1 };
      }
      if (expr.op === BOOL_CONNECTIVE_OP.IMPLIES) {
        const p = evaluateExpr(expr.args[0], env);
        if (p.status === EVAL_STATUS.VALUE && p.value === false) {
          return { status: EVAL_STATUS.VALUE, sort: boolSort(), value: true };
        }
        const q = evaluateExpr(expr.args[1], env);
        if (q.status === EVAL_STATUS.VALUE && q.value === true) {
          return { status: EVAL_STATUS.VALUE, sort: boolSort(), value: true };
        }
        if (p.status !== EVAL_STATUS.VALUE) return p;
        if (q.status !== EVAL_STATUS.VALUE) return q;
        return { status: EVAL_STATUS.VALUE, sort: boolSort(), value: !p.value || q.value };
      }
      if (expr.op === BOOL_CONNECTIVE_OP.EQ) {
        const l = evaluateExpr(expr.args[0], env);
        if (l.status !== EVAL_STATUS.VALUE) return l;
        const r = evaluateExpr(expr.args[1], env);
        if (r.status !== EVAL_STATUS.VALUE) return r;
        return { status: EVAL_STATUS.VALUE, sort: boolSort(), value: l.value === r.value };
      }
      if (expr.op === BOOL_CONNECTIVE_OP.NE) {
        const l = evaluateExpr(expr.args[0], env);
        if (l.status !== EVAL_STATUS.VALUE) return l;
        const r = evaluateExpr(expr.args[1], env);
        if (r.status !== EVAL_STATUS.VALUE) return r;
        return { status: EVAL_STATUS.VALUE, sort: boolSort(), value: l.value !== r.value };
      }
      return { status: EVAL_STATUS.UNKNOWN, reason: `unsupported-connective-op-${expr.op}` };
    }

    case EXPR_KIND.ITE: {
      const c = evaluateExpr(expr.cond, env);
      if (c.status === EVAL_STATUS.VALUE) {
        return c.value ? evaluateExpr(expr.thenExpr, env) : evaluateExpr(expr.elseExpr, env);
      }
      return c;
    }

    case EXPR_KIND.EXTRACT: {
      const sub = evaluateExpr(expr.arg, env);
      if (sub.status !== EVAL_STATUS.VALUE) return sub;
      const val = bvExtract(sub.value, expr.arg.sort.width, expr.high, expr.low);
      return { status: EVAL_STATUS.VALUE, sort: expr.sort, value: val };
    }

    case EXPR_KIND.CONCAT: {
      const l = evaluateExpr(expr.left, env);
      if (l.status !== EVAL_STATUS.VALUE) return l;
      const r = evaluateExpr(expr.right, env);
      if (r.status !== EVAL_STATUS.VALUE) return r;
      const val = bvConcat(l.value, expr.left.sort.width, r.value, expr.right.sort.width);
      return { status: EVAL_STATUS.VALUE, sort: expr.sort, value: val };
    }

    case EXPR_KIND.CAST: {
      const sub = evaluateExpr(expr.arg, env);
      if (sub.status !== EVAL_STATUS.VALUE) return sub;
      const fw = expr.arg.sort.width;
      const tw = expr.targetWidth;
      let val;
      if (expr.op === CAST_OP.TRUNC) val = bvTrunc(sub.value, fw, tw);
      else if (expr.op === CAST_OP.ZEXT) val = bvZext(sub.value, fw, tw);
      else if (expr.op === CAST_OP.SEXT) val = bvSext(sub.value, fw, tw);
      else return { status: EVAL_STATUS.UNKNOWN, reason: `unsupported-cast-op-${expr.op}` };
      return { status: EVAL_STATUS.VALUE, sort: expr.sort, value: val };
    }

    default:
      return { status: EVAL_STATUS.UNKNOWN, reason: `unknown-expr-kind-${expr.kind}` };
  }
}
