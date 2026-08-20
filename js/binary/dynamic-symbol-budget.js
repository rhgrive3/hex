export const DEFAULT_DYNAMIC_SYMBOL_LIMITS = Object.freeze({
  maxSymbolRecords: 100_000,
  maxOutputObjects: 500_000,
  maxInputBytes: 64 * 1024 * 1024,
  maxOperations: 2_000_000,
  maxWallMs: 2_000,
  maxEstimatedBytes: 96 * 1024 * 1024,
});

function positiveLimit(value, fallback) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

export function createDynamicSymbolBudget({ limits = {}, onLimit = null } = {}) {
  const resolved = {
    maxSymbolRecords: positiveLimit(limits.maxSymbolRecords, DEFAULT_DYNAMIC_SYMBOL_LIMITS.maxSymbolRecords),
    maxOutputObjects: positiveLimit(limits.maxOutputObjects, DEFAULT_DYNAMIC_SYMBOL_LIMITS.maxOutputObjects),
    maxInputBytes: positiveLimit(limits.maxInputBytes, DEFAULT_DYNAMIC_SYMBOL_LIMITS.maxInputBytes),
    maxOperations: positiveLimit(limits.maxOperations, DEFAULT_DYNAMIC_SYMBOL_LIMITS.maxOperations),
    maxWallMs: positiveLimit(limits.maxWallMs, DEFAULT_DYNAMIC_SYMBOL_LIMITS.maxWallMs),
    maxEstimatedBytes: positiveLimit(limits.maxEstimatedBytes, DEFAULT_DYNAMIC_SYMBOL_LIMITS.maxEstimatedBytes),
  };
  const now = typeof limits.now === 'function' ? limits.now : Date.now;
  const started = now();
  let inputBytes = 0;
  let operations = 0;
  let outputObjects = 0;
  let estimatedBytes = 0;
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
  const wallOkay = (stage) => {
    if (stopped) return false;
    if (now() - started > resolved.maxWallMs) return stop(`${stage} exceeded ${resolved.maxWallMs} ms wall-clock budget`);
    return true;
  };

  return {
    limits: resolved,
    get stopped() { return stopped; },
    get reason() { return reason; },
    claimInput(bytes, source = 'dynamic symbol table') {
      if (stopped) return false;
      if (!Number.isSafeInteger(bytes) || bytes < 0) return stop(`${source} input size is not safely representable`);
      if (bytes > resolved.maxInputBytes - inputBytes) return stop(`${source} input bytes exceed ${resolved.maxInputBytes}`);
      inputBytes += bytes;
      return true;
    },
    step(cost = 1, stage = 'dynamic symbol decode') {
      if (stopped) return false;
      if (!Number.isSafeInteger(cost) || cost < 0) return stop(`${stage} operation cost is invalid`);
      operations += cost;
      if (!Number.isSafeInteger(operations) || operations > resolved.maxOperations) return stop(`${stage} exceeds ${resolved.maxOperations} operations`);
      return operations === 1 || (operations & 0xfff) === 0 ? wallOkay(stage) : true;
    },
    claimOutput(count = 1, bytesPerObject = 128, source = 'dynamic symbol decode') {
      if (stopped) return false;
      if (!Number.isSafeInteger(count) || count < 0 || !Number.isSafeInteger(bytesPerObject) || bytesPerObject < 0) return stop(`${source} output estimate is invalid`);
      const bytes = count * bytesPerObject;
      if (!Number.isSafeInteger(bytes)) return stop(`${source} output estimate exceeds safe integer range`);
      if (count > resolved.maxOutputObjects - outputObjects) return stop(`${source} output objects exceed ${resolved.maxOutputObjects}`);
      if (bytes > resolved.maxEstimatedBytes - estimatedBytes) return stop(`${source} estimated memory exceeds ${resolved.maxEstimatedBytes} bytes`);
      outputObjects += count;
      estimatedBytes += bytes;
      return true;
    },
    checkWall(stage = 'dynamic symbol decode') { return wallOkay(stage); },
    snapshot() {
      return { ...resolved, inputBytes, operations, outputObjects, estimatedBytes, stopped, reason };
    },
  };
}
