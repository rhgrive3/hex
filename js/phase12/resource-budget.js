import { deepFreeze } from '../core/identity/index.js';

export const RESOURCE_BUDGET_VERSION = 'hex-phase12-resource-budget-v1';

function positive(value, fallback) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

/**
 * One small adapter for bounded Phase 12 work. It deliberately reports a
 * typed stop state; callers must not turn a stop into an apparently complete
 * result.
 */
export function createResourceBudget(options = {}) {
  const limits = deepFreeze({
    maxBytes: positive(options.maxBytes, 16 * 1024 * 1024),
    maxNodes: positive(options.maxNodes, 100_000),
    maxEntries: positive(options.maxEntries, 100_000),
    maxWork: positive(options.maxWork, 1_000_000),
    maxDepth: positive(options.maxDepth, 128),
    maxOutputBytes: positive(options.maxOutputBytes, 8 * 1024 * 1024),
  });
  const signal = options.signal || null;
  const used = { bytes: 0, nodes: 0, entries: 0, work: 0, outputBytes: 0 };
  let stopped = null;
  const stop = (reason, detail = null) => {
    if (!stopped) stopped = Object.freeze({ status: 'partial', reason, detail });
    return false;
  };
  const check = (kind, amount, limit, reason) => {
    if (stopped) return false;
    if (signal?.aborted) return stop('cancelled', signal.reason?.message || null);
    const value = Number(amount);
    if (!Number.isSafeInteger(value) || value < 0 || used[kind] + value > limit) return stop(reason, { kind, amount: value, used: used[kind], limit });
    used[kind] += value;
    return true;
  };
  return Object.freeze({
    version: RESOURCE_BUDGET_VERSION,
    limits,
    get stopped() { return stopped; },
    consumeBytes: (amount) => check('bytes', amount, limits.maxBytes, 'resource-limit-bytes'),
    consumeNodes: (amount = 1) => check('nodes', amount, limits.maxNodes, 'resource-limit-nodes'),
    consumeEntries: (amount = 1) => check('entries', amount, limits.maxEntries, 'resource-limit-entries'),
    consumeWork: (amount = 1) => check('work', amount, limits.maxWork, 'resource-limit-work'),
    consumeOutputBytes: (amount) => check('outputBytes', amount, limits.maxOutputBytes, 'resource-limit-output'),
    checkDepth: (depth) => depth <= limits.maxDepth ? !stopped : stop('resource-limit-depth', { depth, limit: limits.maxDepth }),
    checkpoint: () => !stopped && !signal?.aborted,
    partial: (reason = stopped?.reason || 'partial') => Object.freeze({ status: 'partial', reason, usage: Object.freeze({ ...used }), limits }),
    snapshot: () => Object.freeze({ version: RESOURCE_BUDGET_VERSION, limits, usage: Object.freeze({ ...used }), stopped }),
  });
}

export function assertBudgetComplete(budget, code = 'phase12-resource-limit') {
  if (budget?.stopped) {
    const error = new Error(code);
    error.code = code;
    error.reason = budget.stopped.reason;
    throw error;
  }
  return true;
}
