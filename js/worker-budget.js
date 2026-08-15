/* Shared hard limits for the classic analysis worker. */
(function installHexWorkerBudget(root) {
  const MiB = 1024 * 1024;
  root.HexWorkerBudget = Object.freeze({
    PROGRAM_INDEX_BYTES: 96 * MiB,
    FUNCTION_AUX_SLOTS: 400_000,
    functionAuxLimit(requested) {
      const n = Number.isFinite(Number(requested)) ? Math.max(0, Math.floor(Number(requested))) : 0;
      return Math.min(400_000, Math.max(16_384, n));
    },
    withinProgramBudget(currentBytes, temporaryBytes) {
      return currentBytes >= 0 && temporaryBytes >= 0 && currentBytes + temporaryBytes <= 96 * MiB;
    },
  });
})(globalThis);
