/**
 * Global Edge Reachability query engine.
 *
 * A string such as "complete" is not path evidence. A global claim requires
 * an explicit, internally inspectable path certificate: entry/target identity,
 * every incoming path predicate, PHI choices, loop bounds, and coverage.
 */

import { createConnective } from '../expr/factory.js';
import { BOOL_CONNECTIVE_OP } from '../expr/kinds.js';
import {
  VERIFICATION_QUERY_KIND,
  CLAIM_KIND,
  VERDICT,
} from './query.js';
import { COMPLETENESS_STATUS, createCompleteness } from '../translate/support-matrix.js';
import { SOLVER_STATUS } from '../solver/result.js';
import { verifyConditionalEdgeFeasibility } from './edge-feasibility.js';

function isExpr(value) {
  return !!value && typeof value === 'object' && typeof value.kind === 'string' && value.sort?.kind === 'bool';
}

function unknown(reasonCode, proofStatement) {
  return Object.freeze({
    verdict: VERDICT.UNKNOWN,
    claimKind: CLAIM_KIND.GLOBAL_EDGE_UNREACHABLE,
    reasonCode,
    proofStatement,
    solverStatus: SOLVER_STATUS.UNSUPPORTED,
    completeness: createCompleteness({
      controlFlow: COMPLETENESS_STATUS.PARTIAL,
      pathCoverage: COMPLETENESS_STATUS.PARTIAL,
    }),
    queryHash: null,
    query: null,
    solverResult: null,
    evidence: null,
  });
}

function pathExpression(path) {
  if (isExpr(path?.condition)) return path.condition;
  if (Array.isArray(path?.conditions) && path.conditions.length > 0 && path.conditions.every(isExpr)) {
    return path.conditions.length === 1
      ? path.conditions[0]
      : createConnective(BOOL_CONNECTIVE_OP.AND, ...path.conditions);
  }
  return null;
}

export async function verifyGlobalEdgeReachability({
  ir = null,
  entryBlock = 0,
  targetBlock = null,
  targetEdge = null,
  pathCompleteness = 'partial',
  globalScope = null,
  backend = null,
  session = null,
  options = {},
} = {}) {
  if (pathCompleteness !== COMPLETENESS_STATUS.COMPLETE) {
    return unknown(
      'incomplete-path-coverage',
      'Global unreachability cannot be proved: CFG incoming path coverage or loop unrolling is incomplete (local infeasibility is not global unreachability)'
    );
  }

  if (!globalScope || globalScope.entryBlock !== entryBlock || globalScope.targetBlock !== targetBlock) {
    return unknown('missing-global-path-evidence', 'Global unreachability requires an explicit entry/target path certificate');
  }
  if (globalScope.pathCoverageEvidence?.complete !== true ||
      !Number.isInteger(globalScope.pathCoverageEvidence?.coveredPaths) ||
      globalScope.pathCoverageEvidence.coveredPaths < 0) {
    return unknown('missing-path-coverage-evidence', 'Global unreachability requires machine-readable path coverage evidence');
  }
  if (globalScope.loopBounds?.complete !== true) {
    return unknown('incomplete-loop-bounds', 'Global unreachability requires complete loop-bound evidence');
  }
  if (!Array.isArray(globalScope.incomingPaths) || globalScope.incomingPaths.length === 0) {
    return unknown('missing-incoming-cfg-paths', 'Global unreachability requires every incoming CFG path');
  }
  if (globalScope.incomingPaths.some((path) => path?.complete !== true ||
      !(path.pathId || path.id) || path.fromBlock == null || path.toBlock !== targetBlock || !pathExpression(path))) {
    return unknown('incomplete-incoming-cfg-paths', 'Global unreachability requires complete predicates for every incoming CFG path');
  }
  if (globalScope.pathCoverageEvidence.coveredPaths !== globalScope.incomingPaths.length ||
      (globalScope.pathCoverageEvidence.totalPaths != null && globalScope.pathCoverageEvidence.totalPaths !== globalScope.incomingPaths.length)) {
    return unknown('path-coverage-count-mismatch', 'Global path coverage count does not match the enumerated incoming CFG paths');
  }
  if (!Array.isArray(globalScope.phiChoices) || globalScope.phiChoices.some((choice) => choice?.complete !== true)) {
    return unknown('incomplete-phi-choices', 'Global unreachability requires explicit PHI predecessor choices');
  }
  if (!isExpr(targetEdge)) {
    return unknown('missing-target-edge-condition', 'Global unreachability requires a translated target-edge condition');
  }

  const pathPredicates = globalScope.incomingPaths.map(pathExpression);
  const incomingReachability = pathPredicates.length === 1
    ? pathPredicates[0]
    : createConnective(BOOL_CONNECTIVE_OP.OR, ...pathPredicates);
  if (!Array.isArray(globalScope.entryPreconditions) || !Array.isArray(globalScope.branchPredicates)) {
    return unknown('missing-global-predicates', 'Global path evidence must explicitly enumerate entry and branch predicates');
  }
  const entryPreconditions = globalScope.entryPreconditions;
  const branchPredicates = globalScope.branchPredicates;
  if (![...entryPreconditions, ...branchPredicates].every(isExpr)) {
    return unknown('invalid-global-preconditions', 'Global path evidence contains an unresolved predicate');
  }

  const result = await verifyConditionalEdgeFeasibility({
    ir,
    fromBlock: entryBlock,
    toBlock: targetBlock,
    edgeCondition: targetEdge,
    preconditions: [...entryPreconditions, ...branchPredicates, incomingReachability],
    backend,
    session,
    options: { ...options, globalScope },
    queryKind: VERIFICATION_QUERY_KIND.GLOBAL_EDGE_REACHABILITY,
    claimKind: CLAIM_KIND.GLOBAL_EDGE_UNREACHABLE,
  });

  if (result.verdict === VERDICT.PROVED) {
    return Object.freeze({
      ...result,
      proofStatement: `Global edge from block ${entryBlock} to ${targetBlock} is PROVED UNREACHABLE under the complete path certificate`,
      globalScope,
    });
  }
  return Object.freeze({ ...result, globalScope });
}
