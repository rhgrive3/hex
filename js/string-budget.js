export const STRING_SCAN_BUDGET = Object.freeze({
  inputBytes: 64 * 1024 * 1024,
  resultLimit: 60_000,
  estimatedHeapBytes: 32 * 1024 * 1024,
});

export class StringCollectionBudget {
  constructor(config = STRING_SCAN_BUDGET) {
    const inputBytes = Number(config.inputBytes);
    const resultLimit = Number(config.resultLimit);
    const estimatedHeapBytes = Number(config.estimatedHeapBytes);
    this.inputRemaining = Number.isFinite(inputBytes) ? Math.max(0, inputBytes) : 0;
    this.resultLimit = Number.isFinite(resultLimit) ? Math.max(1, Math.floor(resultLimit)) : 1;
    this.heapLimit = Number.isFinite(estimatedHeapBytes) ? Math.max(1, estimatedHeapBytes) : 1;
    this.results = 0;
    this.estimatedHeap = 0;
    this.truncationReason = null;
  }

  requestBytes(size) {
    if (this.inputRemaining <= 0) return 0;
    const requested = Number(size);
    const n = Number.isFinite(requested)
      ? Math.min(this.inputRemaining, Math.max(0, requested))
      : 0;
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
