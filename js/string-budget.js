export const STRING_SCAN_BUDGET = Object.freeze({
  inputBytes: 64 * 1024 * 1024,
  resultLimit: 60_000,
  estimatedHeapBytes: 32 * 1024 * 1024,
});

export class StringCollectionBudget {
  constructor(config = STRING_SCAN_BUDGET) {
    this.inputRemaining = finiteBudget(config.inputBytes, 0, 0);
    this.resultLimit = finiteBudget(config.resultLimit, 1, 1, true);
    this.heapLimit = finiteBudget(config.estimatedHeapBytes, 1, 1);
    this.results = 0;
    this.estimatedHeap = 0;
    this.truncationReason = null;
  }

  requestBytes(size) {
    if (this.inputRemaining <= 0) return 0;
    const n = Math.min(this.inputRemaining, Math.max(0, Number(size) || 0));
    this.inputRemaining -= n;
    return n;
  }

  requestLimit() {
    return Math.max(0, this.resultLimit - this.results);
  }

  accept(text) {
    if (this.results >= this.resultLimit) {
      this.truncationReason ||= 'result-budget';
      return false;
    }
    const bytes = 96 + String(text || '').length * 2;
    if (this.estimatedHeap + bytes > this.heapLimit) {
      this.truncationReason ||= 'heap-budget';
      return false;
    }
    this.results++;
    this.estimatedHeap += bytes;
    return true;
  }

  get exhausted() {
    return this.requestLimit() <= 0 || this.estimatedHeap >= this.heapLimit;
  }
}

function finiteBudget(value, fallback, minimum, integer = false) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  const bounded = Math.max(minimum, numeric);
  return integer ? Math.floor(bounded) : bounded;
}
