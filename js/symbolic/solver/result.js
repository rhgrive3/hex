/**
 * js/symbolic/solver/result.js
 *
 * Strict 9-status taxonomy and validation for SolverResult.
 * Ensures timeouts, resource limits, and unsupported features are never
 * conflated with UNSAT or proved results.
 */

export const SOLVER_STATUS = Object.freeze({
  SAT: 'sat',
  UNSAT: 'unsat',
  UNKNOWN: 'unknown',
  TIMEOUT: 'timeout',
  RESOURCE_LIMIT: 'resource-limit',
  UNSUPPORTED: 'unsupported',
  CANCELLED: 'cancelled',
  PROVIDER_FAILURE: 'provider-failure',
  INVALID_QUERY: 'invalid-query',
});

export function isSat(result) {
  return result?.status === SOLVER_STATUS.SAT;
}

export function isUnsat(result) {
  return result?.status === SOLVER_STATUS.UNSAT;
}

export function isSolverFailure(result) {
  if (!result || !result.status) return true;
  return (
    result.status === SOLVER_STATUS.UNKNOWN ||
    result.status === SOLVER_STATUS.TIMEOUT ||
    result.status === SOLVER_STATUS.RESOURCE_LIMIT ||
    result.status === SOLVER_STATUS.UNSUPPORTED ||
    result.status === SOLVER_STATUS.CANCELLED ||
    result.status === SOLVER_STATUS.PROVIDER_FAILURE ||
    result.status === SOLVER_STATUS.INVALID_QUERY
  );
}

export function createSolverResult({
  status,
  model = null,
  reason = null,
  stats = {},
  backend = 'unknown',
  backendVersion = '0.0.0',
  queryHash = null,
  lifecycle = {},
}) {
  if (!Object.values(SOLVER_STATUS).includes(status)) {
    throw new TypeError(`createSolverResult: invalid solver status '${status}'`);
  }

  // Model is only permitted when status is SAT
  let normalizedModel = null;
  if (status === SOLVER_STATUS.SAT && model) {
    if (model instanceof Map) {
      normalizedModel = new Map(model);
    } else if (typeof model === 'object') {
      normalizedModel = { ...model };
    }
  }

  const normalizedLifecycle = Object.freeze({
    timedOut: lifecycle?.timedOut === true,
    cancelled: lifecycle?.cancelled === true,
    stale: lifecycle?.stale === true,
    disposed: lifecycle?.disposed === true,
    budgetExceeded: lifecycle?.budgetExceeded === true,
    late: lifecycle?.late === true,
    publishable: lifecycle?.publishable !== false &&
      lifecycle?.timedOut !== true &&
      lifecycle?.cancelled !== true &&
      lifecycle?.stale !== true &&
      lifecycle?.disposed !== true &&
      lifecycle?.budgetExceeded !== true,
  });

  return Object.freeze({
    status,
    model: normalizedModel,
    reason: reason ? String(reason) : null,
    stats: Object.freeze({
      solveTimeMs: Number(stats.solveTimeMs) || 0,
      nodesEvaluated: Number(stats.nodesEvaluated) || 0,
      memoryBytesDelta: Number(stats.memoryBytesDelta) || 0,
      ...stats,
    }),
    backend: String(backend),
    backendVersion: String(backendVersion),
    queryHash: queryHash ? String(queryHash) : null,
    lifecycle: normalizedLifecycle,
  });
}

export function isValidSolverResult(result, { query = null, backend = null } = {}) {
  if (!result || typeof result !== 'object' || !Object.values(SOLVER_STATUS).includes(result.status)) return false;
  if (backend) {
    if (result.backend !== String(backend.id) || result.backendVersion !== String(backend.version)) return false;
  }
  if (query?.queryHash && result.queryHash !== String(query.queryHash)) return false;
  if (result.lifecycle?.publishable === false && (result.status === SOLVER_STATUS.SAT || result.status === SOLVER_STATUS.UNSAT)) return false;
  if (result.status !== SOLVER_STATUS.SAT && result.model != null) return false;
  return true;
}
