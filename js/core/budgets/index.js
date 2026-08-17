export const RESOURCE_BUDGET_CONTRACT_VERSION = 'hex-resource-budget-v1';

export class BudgetExceededError extends Error {
  constructor(resource, used, limit) {
    super(`Resource budget exceeded for ${resource}: ${used} > ${limit}`);
    this.name = 'BudgetExceededError';
    this.code = 'budget-exhausted';
    this.resource = resource;
    this.used = used;
    this.limit = limit;
  }
}

const DEFAULT_LIMITS = Object.freeze({
  workUnits:100000,
  bytesRead:64 * 1024 * 1024,
  residentBytes:64 * 1024 * 1024,
  artifactsMaterialized:10000,
  pagesFetched:10000,
  queueOperations:100000,
});

export class ResourceBudget {
  constructor(limits = {}, { signal = null } = {}) {
    this.limits = Object.freeze({ ...DEFAULT_LIMITS, ...limits });
    this.used = Object.create(null);
    this.signal = signal;
  }

  checkCancelled() {
    if (!this.signal?.aborted) return;
    throw this.signal.reason || new DOMException('Aborted', 'AbortError');
  }

  consume(resource, amount = 1) {
    this.checkCancelled();
    const n = Number(amount);
    if (!Number.isFinite(n) || n < 0) throw new TypeError('budget-consumption-invalid');
    const next = (this.used[resource] || 0) + n;
    const limit = this.limits[resource];
    if (limit != null && next > limit) throw new BudgetExceededError(resource, next, limit);
    this.used[resource] = next;
    return next;
  }

  remaining(resource) {
    const limit = this.limits[resource];
    return limit == null ? Infinity : Math.max(0, limit - (this.used[resource] || 0));
  }

  snapshot() {
    return Object.freeze({ contractVersion:RESOURCE_BUDGET_CONTRACT_VERSION, limits:this.limits, used:Object.freeze({ ...this.used }) });
  }
}

export function createResourceBudget(limits, options) { return new ResourceBudget(limits, options); }
