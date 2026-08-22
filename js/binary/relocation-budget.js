export const DEFAULT_RELOCATION_BUDGET_LIMITS = Object.freeze({
  maxOutput: 250_000,
  maxInputBytes: 32 * 1024 * 1024,
  maxOperations: 4_000_000,
  maxWallMs: 1_500,
});

function positiveLimit(value, fallback) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

export function createRelocationBudget({ limits = {}, onLimit = null } = {}) {
  const resolved = {
    maxOutput: positiveLimit(limits.maxOutput, DEFAULT_RELOCATION_BUDGET_LIMITS.maxOutput),
    maxInputBytes: positiveLimit(limits.maxInputBytes, DEFAULT_RELOCATION_BUDGET_LIMITS.maxInputBytes),
    maxOperations: positiveLimit(limits.maxOperations, DEFAULT_RELOCATION_BUDGET_LIMITS.maxOperations),
    maxWallMs: positiveLimit(limits.maxWallMs, DEFAULT_RELOCATION_BUDGET_LIMITS.maxWallMs),
  };
  const now = typeof limits.now === 'function' ? limits.now : Date.now;
  const started = now();
  let inputBytes = 0;
  let operations = 0;
  let stopped = false;
  let reason = null;

  const stop = (message) => {
    if (!stopped) {
      stopped = true;
      reason = message;
      if (typeof onLimit === 'function') onLimit(message);
    }
    return false;
  };

  return {
    limits: resolved,
    get stopped() { return stopped; },
    get reason() { return reason; },
    claimInput(bytes, source = 'relocation table') {
      if (stopped) return false;
      if (!Number.isSafeInteger(bytes) || bytes < 0) return stop(`${source} input size is not safely representable`);
      if (bytes > resolved.maxInputBytes - inputBytes) return stop(`${source} input bytes exceed ${resolved.maxInputBytes}`);
      inputBytes += bytes;
      return true;
    },
    step(cost = 1) {
      if (stopped) return false;
      // A negative cost gave back work that had already been consumed, so
      // alternating step(1)/step(-1) never reached maxOperations; fractional,
      // NaN and Infinity costs put the counter in a state the limit check
      // could not reason about (#1377). Match DynamicSymbolBudget.step():
      // only a non-negative safe integer is spendable, anything else stops.
      if (!Number.isSafeInteger(cost) || cost < 0) return stop('decode work operation cost is invalid');
      operations += cost;
      if (!Number.isSafeInteger(operations) || operations > resolved.maxOperations) return stop(`decode work exceeds ${resolved.maxOperations} operations`);
      if (operations === 1 || (operations & 0xfff) === 0) {
        if (now() - started > resolved.maxWallMs) return stop(`decode time exceeds ${resolved.maxWallMs} ms`);
      }
      return true;
    },
    push(out, item, source = 'relocation table') {
      if (stopped) return false;
      if (out.length >= resolved.maxOutput) return stop(`${source} expanded relocations exceed ${resolved.maxOutput}`);
      out.push(item);
      return true;
    },
    snapshot(output = 0) {
      return { inputBytes, operations, output, stopped, reason, ...resolved };
    },
  };
}
