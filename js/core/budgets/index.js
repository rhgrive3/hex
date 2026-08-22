export const RESOURCE_BUDGET_CONTRACT_VERSION = 'hex-resource-budget-v1';

const SCOPE_NAME_RE = /^[a-zA-Z0-9_\-\.]+$/;

export class BudgetExceededError extends Error {
  constructor(resource, used, limit, scope = 'root', scopePath = 'root') {
    super(`Resource budget exceeded for ${resource}: ${used} > ${limit} (scope: ${scopePath})`);
    this.name = 'BudgetExceededError';
    this.code = 'budget-exhausted';
    this.resource = resource;
    this.used = used;
    this.limit = limit;
    this.scope = scope;
    this.scopePath = scopePath;
  }
}

const DEFAULT_LIMITS = Object.freeze({
  workUnits: 100000,
  bytesRead: 64 * 1024 * 1024,
  residentBytes: 64 * 1024 * 1024,
  artifactsMaterialized: 10000,
  pagesFetched: 10000,
  queueOperations: 100000,
});

function validateLimit(value, name) {
  if (value === undefined || value === null) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || !Number.isSafeInteger(n)) {
    throw new TypeError(`budget-limit-invalid:${name}`);
  }
  return n;
}

export class ResourceBudget {
  constructor(limits = {}, { signal = null, parent = null, name = 'root' } = {}) {
    if (typeof name !== 'string' || !name || !SCOPE_NAME_RE.test(name)) {
      throw new TypeError('budget-scope-name-invalid');
    }
    this.name = name;
    this.parent = parent;
    this.scopePath = parent ? (parent.scopePath ? `${parent.scopePath}/${name}` : name) : name;
    this.signal = signal || parent?.signal || null;
    this.children = new Map();

    if (parent?.children.has(name)) {
      throw new Error(`budget-duplicate-sibling-scope:${name}`);
    }

    const validatedLimits = Object.create(null);
    if (!parent) {
      for (const [k, v] of Object.entries(DEFAULT_LIMITS)) {
        validatedLimits[k] = v;
      }
    }
    for (const [k, v] of Object.entries(limits)) {
      if (v !== undefined) {
        validatedLimits[k] = validateLimit(v, k);
      }
    }
    this.limits = Object.freeze(validatedLimits);
    this.used = Object.create(null);

    if (parent) parent.children.set(name, this);
  }

  checkCancelled() {
    if (!this.signal?.aborted) return;
    throw this.signal.reason ?? new DOMException('Aborted', 'AbortError');
  }

  scope(name, limits = {}, options = {}) {
    return new ResourceBudget(limits, { ...options, parent: this, name });
  }

  consume(resource, amount = 1) {
    this.checkCancelled();
    const n = Number(amount);
    if (!Number.isFinite(n) || n < 0) throw new TypeError('budget-consumption-invalid');

    // Preflight check across local and all ancestors
    let curr = this;
    while (curr) {
      const next = (curr.used[resource] || 0) + n;
      const limit = curr.limits[resource];
      if (limit != null && next > limit) {
        throw new BudgetExceededError(resource, next, limit, curr.name, curr.scopePath);
      }
      curr = curr.parent;
    }

    // Apply consumption atomically
    curr = this;
    while (curr) {
      curr.used[resource] = (curr.used[resource] || 0) + n;
      curr = curr.parent;
    }
    return this.used[resource];
  }

  remaining(resource) {
    let rem = Infinity;
    let curr = this;
    let anyLimited = false;
    while (curr) {
      const limit = curr.limits[resource];
      if (limit != null) {
        anyLimited = true;
        const localRem = Math.max(0, limit - (curr.used[resource] || 0));
        if (localRem < rem) rem = localRem;
      }
      curr = curr.parent;
    }
    return anyLimited ? rem : Infinity;
  }

  snapshot({ recursive = false } = {}) {
    const snap = {
      contractVersion: RESOURCE_BUDGET_CONTRACT_VERSION,
      name: this.name,
      scopePath: this.scopePath,
      limits: this.limits,
      used: Object.freeze({ ...this.used }),
    };
    if (recursive) {
      const sortedChildren = [...this.children.values()]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((c) => c.snapshot({ recursive: true }));
      snap.children = Object.freeze(sortedChildren);
    }
    return Object.freeze(snap);
  }
}

export function createResourceBudget(limits, options) {
  return new ResourceBudget(limits, options);
}
