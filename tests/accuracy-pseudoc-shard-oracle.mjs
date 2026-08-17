function stride(list, n) {
  if (list.length <= n) return list.slice();
  const step = list.length / n;
  const out = [];
  for (let i = 0; i < n; i++) out.push(list[Math.floor(i * step)]);
  return out;
}

/**
 * Return the canonical deterministic pseudoc sample used by accuracy.mjs and
 * the persistent runner-local worker pool. Keeping this selection in one
 * helper prevents the parallel path from drifting from the serial contract.
 */
export function pseudocSamples(functionStarts) {
  const cands = [];
  for (let i = 0; i < functionStarts.length - 1; i++) {
    const a = functionStarts[i];
    const end = functionStarts[i + 1];
    if (end - a >= 64 && end - a <= 2048) cands.push([a, end]);
  }
  return stride(cands, 120);
}
