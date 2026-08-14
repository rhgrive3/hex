// Keep compiler-truth diagnostics serializable when a semantic counterexample contains BigInt values.
if (typeof BigInt.prototype.toJSON !== 'function') {
  Object.defineProperty(BigInt.prototype, 'toJSON', { value() { return this.toString(); }, configurable: true });
}
await import('./run-core.mjs');
