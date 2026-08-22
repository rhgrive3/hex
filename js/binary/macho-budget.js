export const MACHO_METADATA_LIMITS = Object.freeze({
  inputBytes: 64 * 1024 * 1024,
  records: 250_000,
  objects: 500_000,
  stringBytes: 16 * 1024 * 1024,
  operations: 2_000_000,
  warnings: 2048,
  estimatedHeapBytes: 128 * 1024 * 1024,
  wallClockMs: 5_000,
});

function metadataOf(image) {
  image.metadata ||= {};
  return image.metadata.machoMetadata ||= { complete: true, reasons: [] };
}

export function markMachOMetadataPartial(image, reason) {
  const meta = metadataOf(image);
  meta.complete = false;
  if (!meta.reasons.includes(reason)) meta.reasons.push(reason);
}

/*
 * Caller-supplied limits used to be merged over the defaults unvalidated, so
 * `records: NaN` made `next > limits.records` permanently false and removed the
 * ceiling entirely, while `stringBytes: NaN` leaked a non-finite value out
 * through `remainingStringBytes` and `remaining()` into bounded decode paths
 * (#1376). A limit is only a limit if it is a finite positive integer; anything
 * else falls back to the declared default rather than disabling the budget.
 */
function metadataLimit(value, fallback) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

function resolveMetadataLimits(overrides = {}) {
  const out = {};
  for (const [key, fallback] of Object.entries(MACHO_METADATA_LIMITS)) {
    out[key] = metadataLimit(overrides[key], fallback);
  }
  return out;
}

export function createMachOMetadataBudget(image, options = {}) {
  const limits = resolveMetadataLimits(options.limits || options.metadataLimits || {});
  const signal = options.signal || null;
  const started = Date.now();
  const used = {
    inputBytes: 0, records: 0, objects: 0, stringBytes: 0,
    operations: 0, warnings: Math.min(image.warnings?.length || 0, limits.warnings),
    estimatedHeapBytes: 0,
  };
  const meta = metadataOf(image);
  meta.limits = { ...limits }; meta.used = used;
  let nextTimeCheck = 1024;
  const stop = (reason) => { markMachOMetadataPartial(image, `budget:${reason}`); return false; };
  return {
    limits, used, signal,
    get remainingStringBytes() { return Math.max(0, limits.stringBytes - used.stringBytes); },
    remaining(key) { return Math.max(0, Number(limits[key] ?? 0) - Number(used[key] ?? 0)); },
    take(cost = {}, reason = 'metadata') {
      if (signal?.aborted) return stop('aborted');
      const opCost = Math.max(0, Number(cost.operations || 0));
      if (used.operations + opCost >= nextTimeCheck) {
        nextTimeCheck = used.operations + opCost + 1024;
        if (Date.now() - started > limits.wallClockMs) return stop('wall-clock');
      }
      for (const key of Object.keys(used)) {
        const next = used[key] + Math.max(0, Number(cost[key] || 0));
        if (!Number.isFinite(next) || next > limits[key]) return stop(`${reason}:${key}`);
      }
      for (const key of Object.keys(used)) used[key] += Math.max(0, Number(cost[key] || 0));
      return true;
    },
    partial(reason, warning = null) {
      markMachOMetadataPartial(image, reason);
      if (warning) this.warn(warning);
      return false;
    },
    warn(message) {
      const text = String(message);
      if (image.warnings?.includes(text)) return true;
      if (!this.take({ warnings:1, objects:1, stringBytes:text.length*2, estimatedHeapBytes:text.length*2+32 }, 'warning')) return false;
      image.warnings.push(text); return true;
    },
    snapshot() {
      const current = metadataOf(image);
      return { complete:current.complete, reasons:[...current.reasons], limits:{...limits}, used:{...used} };
    },
  };
}

export function ensureMachOMetadataBudget(image, budget = null) {
  if (budget) return budget;
  if (image.__machoMetadataBudget) return image.__machoMetadataBudget;
  const created = createMachOMetadataBudget(image);
  Object.defineProperty(image, '__machoMetadataBudget', { value:created, configurable:true, enumerable:false, writable:false });
  return created;
}
