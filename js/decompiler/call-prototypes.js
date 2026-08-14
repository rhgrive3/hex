/*
 * Fixed-arity external call knowledge used by the semantic decompiler.
 *
 * AAPCS64 tells us where arguments live, but it does not encode how many a
 * particular callee accepts. In particular, modelCall.args is only a snapshot
 * of live x0..x7 values at the call site; it is not arity evidence. Never turn
 * those merely-live registers into source-level arguments.
 */

const FIXED = new Map([
  ['puts', 1], ['putchar', 1], ['strlen', 1], ['free', 1], ['malloc', 1],
  ['calloc', 2], ['realloc', 2], ['memcpy', 3], ['memmove', 3], ['memset', 3],
  ['memcmp', 3], ['strcmp', 2], ['strncmp', 3], ['strcpy', 2], ['strncpy', 3],
  ['strcat', 2], ['strncat', 3], ['strchr', 2], ['strrchr', 2], ['atoi', 1],
  ['atol', 1], ['atoll', 1], ['abs', 1], ['labs', 1], ['llabs', 1],
  ['close', 1], ['read', 3], ['write', 3], ['lseek', 3],
  ['fopen', 2], ['fclose', 1], ['fflush', 1], ['fread', 4], ['fwrite', 4],
]);

const VARIADIC_MIN = new Map([
  ['printf', 1], ['fprintf', 2], ['sprintf', 2], ['snprintf', 3],
]);

export function normalizeExternalSymbol(name) {
  let s = String(name || '').trim();
  s = s.replace(/^_+/, '').replace(/^(?:imp_|j_)/, '');
  const suffix = s.search(/(?:\$|@@?)/);
  if (suffix >= 0) s = s.slice(0, suffix);
  return s;
}

export function knownCallPrototype(name) {
  const normalized = normalizeExternalSymbol(name);
  if (FIXED.has(normalized)) return { name: normalized, arity: FIXED.get(normalized), variadic: false, confidence: 1 };
  if (VARIADIC_MIN.has(normalized)) return { name: normalized, arity: VARIADIC_MIN.get(normalized), variadic: true, confidence: 0.95 };
  return null;
}

function validArity(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 && n <= 8 ? n : null;
}

function range(n) {
  const count = Math.max(0, Math.min(8, Number(n) || 0));
  return Array.from({ length: count }, (_, i) => i);
}

/**
 * Return argument register indexes only when the count is supported by actual
 * prototype/API evidence. null means "arity unknown"; [] means proven zero.
 */
export function callArgumentIndices({ name, modelCall = null, override = null, defaultCallArgs = null } = {}) {
  const recoveredArity = validArity(override?.arity);
  if (recoveredArity != null) return range(recoveredArity);

  // Existing semantic API metadata may carry a fixed schema. The live values
  // in modelCall.args are deliberately ignored here.
  const apiArity = Array.isArray(modelCall?.api?.args) ? modelCall.api.args.length : null;
  if (apiArity != null) return range(apiArity);

  const known = knownCallPrototype(name);
  if (known) return range(known.arity); // Variadic entries expose only their proven fixed prefix.

  // Compatibility escape hatch for embedders that deliberately opt into a
  // guessed count. There is intentionally no built-in default.
  if (defaultCallArgs != null) return range(defaultCallArgs);
  return null;
}
