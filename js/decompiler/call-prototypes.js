/*
 * Fixed-arity external call knowledge used by the semantic decompiler.
 *
 * AAPCS64 tells us where arguments live, but it does not encode how many a
 * particular callee accepts.  Never turn merely-live x0..x7 registers into
 * source-level arguments.  We only emit arguments when arity is proven by a
 * recovered call-site/prototype or by this small, stable ABI knowledge table.
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
  // Mach-O C symbols normally carry one leading underscore.  Also accept the
  // common import/stub spellings without making target-specific guesses.
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

function validIndex(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 && n < 8 ? n : null;
}

function explicitIndices(modelCall) {
  const out = [];
  for (const arg of modelCall?.args || []) {
    const n = validIndex(arg?.index);
    if (n != null && !out.includes(n)) out.push(n);
  }
  return out.sort((a, b) => a - b);
}

function range(n) {
  const count = Math.max(0, Math.min(8, Number(n) || 0));
  return Array.from({ length: count }, (_, i) => i);
}

/**
 * Return only call argument registers whose existence has evidence.
 * `override` may be supplied by interprocedural/user prototype recovery.
 */
export function callArgumentIndices({ name, modelCall = null, override = null, defaultCallArgs = null } = {}) {
  const explicit = explicitIndices(modelCall);
  const recoveredArity = validIndex(override?.arity) ?? (override?.arity === 8 ? 8 : null);
  if (recoveredArity != null) {
    const base = range(recoveredArity);
    if (!override?.variadic) return base;
    return [...new Set([...base, ...explicit])].sort((a, b) => a - b);
  }

  const known = knownCallPrototype(name);
  if (known) {
    const base = range(known.arity);
    if (!known.variadic) return base;
    return [...new Set([...base, ...explicit])].sort((a, b) => a - b);
  }

  if (explicit.length) return explicit;
  // Compatibility escape hatch: only an explicitly configured fallback may
  // guess a count.  There is intentionally no implicit "four arguments" rule.
  if (defaultCallArgs != null) return range(defaultCallArgs);
  return [];
}
