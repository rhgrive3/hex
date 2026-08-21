/**
 * Browser-safe exact Bool/BV backend.
 *
 * This is a real finite-domain decision procedure, not a mock: it enumerates
 * every assignment in the supported Bool/BV domain, evaluates Hex's own Expr
 * DAG, and returns a validated model for SAT. The finite scope is explicit;
 * queries outside it return RESOURCE_LIMIT/UNSUPPORTED and can never mint a
 * proof.
 */

import { stableDigest } from '../../core/identity/index.js';
import {
  EXPR_KIND,
  SORT_KIND,
  BV_UNARY_OP,
  BV_BINARY_OP,
  BV_COMPARE_OP,
  BOOL_CONNECTIVE_OP,
  CAST_OP,
  isBoolSort,
  isBvSort,
} from '../expr/kinds.js';
import { evaluateExpr, EVAL_STATUS } from '../expr/evaluate.js';
import { isVerificationQuery } from '../verify/query.js';
import { PROOF_AUTHORITY, SolverBackend } from './backend.js';
import { SOLVER_STATUS, createSolverResult } from './result.js';
import { SolverSession } from './session.js';

export const EXHAUSTIVE_BACKEND_ID = 'hex-exhaustive-bv';
export const EXHAUSTIVE_BACKEND_VERSION = '1.0.0';

function childExpressions(expr) {
  if (!expr || typeof expr !== 'object') return [];
  switch (expr.kind) {
    case EXPR_KIND.UNARY: return [expr.arg];
    case EXPR_KIND.BINARY:
    case EXPR_KIND.COMPARE: return [expr.left, expr.right];
    case EXPR_KIND.CONNECTIVE: return Array.isArray(expr.args) ? expr.args : [];
    case EXPR_KIND.ITE: return [expr.cond, expr.thenExpr, expr.elseExpr];
    case EXPR_KIND.EXTRACT:
    case EXPR_KIND.CAST: return [expr.arg];
    case EXPR_KIND.CONCAT: return [expr.left, expr.right];
    default: return [];
  }
}

function sameBvSort(left, right) {
  return isBvSort(left?.sort) && isBvSort(right?.sort) && left.sort.width === right.sort.width;
}

function validateExprNode(expr) {
  if (!expr || typeof expr !== 'object' || !Object.values(EXPR_KIND).includes(expr.kind)) return 'unsupported-expression-kind';
  if (!isBoolSort(expr.sort) && !isBvSort(expr.sort)) return 'invalid-expression-sort';
  switch (expr.kind) {
    case EXPR_KIND.CONST:
      if (isBoolSort(expr.sort) && typeof expr.value !== 'boolean') return 'invalid-bool-constant';
      if (isBvSort(expr.sort) && typeof expr.value !== 'bigint') return 'invalid-bv-constant';
      return null;
    case EXPR_KIND.FRESH_SYMBOL:
      return typeof expr.name === 'string' && expr.name && typeof (expr.symbolId || expr.name) === 'string' ? null : 'malformed-symbol';
    case EXPR_KIND.UNKNOWN_SEMANTIC:
      return `unknown-semantic:${expr.reason || 'unspecified'}`;
    case EXPR_KIND.UNARY:
      return Object.values(BV_UNARY_OP).includes(expr.op) && sameBvSort(expr, expr.arg) ? null : 'invalid-unary-expression';
    case EXPR_KIND.BINARY:
      return Object.values(BV_BINARY_OP).includes(expr.op) && sameBvSort(expr.left, expr.right) && sameBvSort(expr, expr.left)
        ? null : 'invalid-binary-expression';
    case EXPR_KIND.COMPARE:
      return Object.values(BV_COMPARE_OP).includes(expr.op) && isBoolSort(expr.sort) && sameBvSort(expr.left, expr.right)
        ? null : 'invalid-compare-expression';
    case EXPR_KIND.CONNECTIVE: {
      if (!Object.values(BOOL_CONNECTIVE_OP).includes(expr.op) || !isBoolSort(expr.sort) || !Array.isArray(expr.args) || !expr.args.every((arg) => isBoolSort(arg?.sort))) return 'invalid-connective-expression';
      if (expr.args.length === 0 || (expr.op === BOOL_CONNECTIVE_OP.NOT && expr.args.length !== 1) ||
          ([BOOL_CONNECTIVE_OP.IMPLIES, BOOL_CONNECTIVE_OP.EQ, BOOL_CONNECTIVE_OP.NE].includes(expr.op) && expr.args.length !== 2)) return 'invalid-connective-arity';
      return null;
    }
    case EXPR_KIND.ITE:
      return isBoolSort(expr.cond?.sort) && expr.thenExpr?.sort?.kind === expr.elseExpr?.sort?.kind &&
        ((isBoolSort(expr.thenExpr?.sort) && isBoolSort(expr.sort)) ||
          (isBvSort(expr.thenExpr?.sort) && isBvSort(expr.sort) && expr.thenExpr.sort.width === expr.elseExpr.sort.width && expr.sort.width === expr.thenExpr.sort.width))
        ? null : 'invalid-ite-expression';
    case EXPR_KIND.EXTRACT:
      return isBvSort(expr.arg?.sort) && Number.isSafeInteger(expr.high) && Number.isSafeInteger(expr.low) &&
        expr.low >= 0 && expr.high >= expr.low && expr.high < expr.arg.sort.width && isBvSort(expr.sort) &&
        expr.sort.width === expr.high - expr.low + 1 ? null : 'invalid-extract-expression';
    case EXPR_KIND.CONCAT:
      return isBvSort(expr.left?.sort) && isBvSort(expr.right?.sort) && isBvSort(expr.sort) &&
        expr.sort.width === expr.left.sort.width + expr.right.sort.width ? null : 'invalid-concat-expression';
    case EXPR_KIND.CAST:
      return Object.values(CAST_OP).includes(expr.op) && isBvSort(expr.arg?.sort) && isBvSort(expr.sort) &&
        Number.isSafeInteger(expr.targetWidth) && expr.sort.width === expr.targetWidth &&
        ((expr.op === CAST_OP.TRUNC && expr.targetWidth < expr.arg.sort.width) ||
          ([CAST_OP.ZEXT, CAST_OP.SEXT].includes(expr.op) && expr.targetWidth > expr.arg.sort.width))
        ? null : 'invalid-cast-expression';
    default:
      return 'unsupported-expression-kind';
  }
}

function collectSymbols(expressions) {
  const symbols = new Map();
  const visited = new Set();
  let nodeCount = 0;
  let unsupportedReason = null;

  function visit(expr) {
    if (!expr || typeof expr !== 'object') {
      unsupportedReason ||= 'malformed-expression-node';
      return;
    }
    if (visited.has(expr)) return;
    visited.add(expr);
    nodeCount++;
    unsupportedReason ||= validateExprNode(expr);
    if (expr.kind === EXPR_KIND.FRESH_SYMBOL) {
      const key = String(expr.symbolId || expr.name || '');
      if (!key || !expr.name) unsupportedReason ||= 'malformed-symbol';
      else {
        const existing = symbols.get(key);
        if (existing && stableDigest(existing.sort) !== stableDigest(expr.sort)) unsupportedReason ||= 'symbol-sort-conflict';
        symbols.set(key, { key, name: String(expr.name), symbolId: String(expr.symbolId || key), sort: expr.sort });
      }
    }
    for (const child of childExpressions(expr)) visit(child);
  }

  for (const expr of expressions) visit(expr);
  return { symbols: [...symbols.values()].sort((a, b) => a.key.localeCompare(b.key)), nodeCount, unsupportedReason };
}

function symbolConstantPair(left, right) {
  if (left?.kind === EXPR_KIND.FRESH_SYMBOL && right?.kind === EXPR_KIND.CONST) return [left, right];
  if (right?.kind === EXPR_KIND.FRESH_SYMBOL && left?.kind === EXPR_KIND.CONST) return [right, left];
  return null;
}

function deriveFixedBindings(constraints) {
  const fixed = new Map();
  for (const constraint of constraints) {
    if (constraint?.kind !== EXPR_KIND.COMPARE || constraint.op !== 'eq') continue;
    const pair = symbolConstantPair(constraint.left, constraint.right);
    if (!pair) continue;
    const [symbol, constant] = pair;
    const key = String(symbol.symbolId || symbol.name);
    const value = constant.value;
    if (fixed.has(key) && fixed.get(key) !== value) return { contradiction: true, fixed };
    fixed.set(key, value);
  }
  return { contradiction: false, fixed };
}

function assignmentModel(symbols, assignments) {
  const byName = new Map();
  for (const symbol of symbols) {
    const value = assignments.get(symbol.key);
    if (!byName.has(symbol.name)) byName.set(symbol.name, value);
    else byName.set(symbol.symbolId, value);
  }
  return Object.fromEntries(byName.entries());
}

function evaluateAll(query, model) {
  for (const constraint of query.constraints) {
    const result = evaluateExpr(constraint, model);
    if (result.status !== EVAL_STATUS.VALUE || result.sort?.kind !== SORT_KIND.BOOL || result.value !== true) return false;
  }
  if (query.assertion) {
    const result = evaluateExpr(query.assertion, model);
    if (result.status !== EVAL_STATUS.VALUE || result.sort?.kind !== SORT_KIND.BOOL || result.value !== true) return false;
  }
  return true;
}

function domainSize(symbol) {
  return symbol.sort.kind === SORT_KIND.BOOL ? 2n : 1n << BigInt(symbol.sort.width);
}

function domainValue(symbol, index) {
  if (symbol.sort.kind === SORT_KIND.BOOL) return index === 1n;
  return index;
}

class ExhaustiveSolverSession extends SolverSession {
  async _executeCheck(query, options = {}, token, signal) {
    const startedAt = Date.now();
    if (!isVerificationQuery(query)) {
      return createSolverResult({
        status: SOLVER_STATUS.INVALID_QUERY,
        reason: 'invalid-verification-query',
        backend: this.backend.id,
        backendVersion: this.backend.version,
        queryHash: query?.queryHash || null,
      });
    }

    const constraints = Array.isArray(query.constraints) ? query.constraints : [];
    const expressions = [...constraints, ...(query.assertion ? [query.assertion] : [])];
    const maxConstraints = Number(options.maxConstraints ?? this.options.maxConstraints ?? 4096);
    const maxExprNodes = Number(options.maxExprNodes ?? this.options.maxExprNodes ?? 100000);
    if (constraints.length > maxConstraints) {
      return createSolverResult({ status: SOLVER_STATUS.RESOURCE_LIMIT, reason: 'constraint-budget-exceeded', backend: this.backend.id, backendVersion: this.backend.version, queryHash: query.queryHash });
    }

    const collected = collectSymbols(expressions);
    if (collected.nodeCount > maxExprNodes) {
      return createSolverResult({ status: SOLVER_STATUS.RESOURCE_LIMIT, reason: 'expression-node-budget-exceeded', backend: this.backend.id, backendVersion: this.backend.version, queryHash: query.queryHash });
    }
    if (collected.unsupportedReason) {
      return createSolverResult({ status: SOLVER_STATUS.UNSUPPORTED, reason: collected.unsupportedReason, backend: this.backend.id, backendVersion: this.backend.version, queryHash: query.queryHash });
    }
    if (constraints.some((constraint) => constraint?.sort?.kind !== SORT_KIND.BOOL) ||
        (query.assertion && query.assertion.sort?.kind !== SORT_KIND.BOOL)) {
      return createSolverResult({ status: SOLVER_STATUS.UNSUPPORTED, reason: 'non-boolean-query-predicate', backend: this.backend.id, backendVersion: this.backend.version, queryHash: query.queryHash });
    }

    const maxBvWidth = Number(options.maxBvWidth ?? this.backend.capabilities().maxBvWidth);
    if (collected.symbols.some((symbol) => symbol.sort.kind === SORT_KIND.BV && symbol.sort.width > maxBvWidth)) {
      return createSolverResult({ status: SOLVER_STATUS.UNSUPPORTED, reason: `bitvector-width-exceeds-${maxBvWidth}`, backend: this.backend.id, backendVersion: this.backend.version, queryHash: query.queryHash });
    }

    const derived = deriveFixedBindings(constraints);
    if (derived.contradiction) {
      return createSolverResult({ status: SOLVER_STATUS.UNSAT, stats: { solveTimeMs: Date.now() - startedAt, nodesEvaluated: 0 }, backend: this.backend.id, backendVersion: this.backend.version, queryHash: query.queryHash });
    }

    const assignments = new Map(derived.fixed);
    const freeSymbols = collected.symbols.filter((symbol) => !assignments.has(symbol.key));
    const maxAssignments = BigInt(Math.max(1, Math.floor(Number(options.maxAssignments ?? this.options.maxAssignments ?? (1 << 20)))));
    let totalAssignments = 1n;
    for (const symbol of freeSymbols) {
      totalAssignments *= domainSize(symbol);
      if (totalAssignments > maxAssignments) {
        return createSolverResult({ status: SOLVER_STATUS.RESOURCE_LIMIT, reason: 'assignment-budget-exceeded', stats: { solveTimeMs: Date.now() - startedAt, nodesEvaluated: 0 }, backend: this.backend.id, backendVersion: this.backend.version, queryHash: query.queryHash });
      }
    }

    let nodesEvaluated = 0;
    const yieldEvery = Math.max(1, Math.floor(Number(options.yieldEvery ?? 4096)));
    let found = null;
    const visit = async (position) => {
      if (signal?.aborted) return 'cancelled';
      if (found) return 'found';
      if (position >= freeSymbols.length) {
        nodesEvaluated++;
        const model = assignmentModel(collected.symbols, assignments);
        if (evaluateAll(query, model)) found = model;
        if (nodesEvaluated % yieldEvery === 0) await Promise.resolve();
        return found ? 'found' : 'continue';
      }
      const symbol = freeSymbols[position];
      const size = domainSize(symbol);
      for (let index = 0n; index < size; index++) {
        if (signal?.aborted) return 'cancelled';
        assignments.set(symbol.key, domainValue(symbol, index));
        const outcome = await visit(position + 1);
        if (outcome === 'cancelled' || outcome === 'found') return outcome;
      }
      assignments.delete(symbol.key);
      return 'continue';
    };

    const outcome = await visit(0);
    if (outcome === 'cancelled') {
      return createSolverResult({ status: SOLVER_STATUS.CANCELLED, reason: 'provider-aborted', backend: this.backend.id, backendVersion: this.backend.version, queryHash: query.queryHash, lifecycle: { cancelled: true, publishable: false } });
    }
    const stats = { solveTimeMs: Date.now() - startedAt, nodesEvaluated };
    if (found) return createSolverResult({ status: SOLVER_STATUS.SAT, model: found, stats, backend: this.backend.id, backendVersion: this.backend.version, queryHash: query.queryHash });
    return createSolverResult({ status: SOLVER_STATUS.UNSAT, stats, backend: this.backend.id, backendVersion: this.backend.version, queryHash: query.queryHash });
  }
}

export class ExhaustiveBvBackend extends SolverBackend {
  constructor({
    id = EXHAUSTIVE_BACKEND_ID,
    version = EXHAUSTIVE_BACKEND_VERSION,
    maxBvWidth = 8,
    maxAssignments = 1 << 20,
    maxConstraints = 4096,
    maxExprNodes = 100000,
  } = {}) {
    super({ id, version, proofAuthority: PROOF_AUTHORITY.EXACT, isRemote: false, isWasm: false });
    this.maxBvWidth = Math.max(1, Math.floor(Number(maxBvWidth)));
    this.maxAssignments = Math.max(1, Math.floor(Number(maxAssignments)));
    this.maxConstraints = Math.max(1, Math.floor(Number(maxConstraints)));
    this.maxExprNodes = Math.max(1, Math.floor(Number(maxExprNodes)));
  }

  baseCapabilities() {
    return {
      ...super.baseCapabilities(),
      supportedSorts: ['bool', 'bv'],
      maxBvWidth: this.maxBvWidth,
      supportsIncremental: false,
      supportsCancellation: true,
      supportsModelExtraction: true,
      sessionReuseAfterTimeout: false,
      exactProofs: true,
      executionIsolation: 'caller-selected',
      memoryBudgetClass: 'measured-only',
      maxAssignments: this.maxAssignments,
      maxConstraints: this.maxConstraints,
      maxExprNodes: this.maxExprNodes,
    };
  }

  createSession(options = {}) {
    return new ExhaustiveSolverSession(this, {
      maxBvWidth: this.maxBvWidth,
      maxAssignments: this.maxAssignments,
      maxConstraints: this.maxConstraints,
      maxExprNodes: this.maxExprNodes,
      ...options,
    });
  }
}
