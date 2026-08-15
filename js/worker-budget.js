/* Shared hard limits for the classic analysis worker. */
(function installHexWorkerBudget(root) {
  const MiB = 1024 * 1024;
  root.HexWorkerBudget = Object.freeze({
    PROGRAM_INDEX_BYTES: 96 * MiB,
    /*
     * Function discovery already had a 400k output/data-candidate ceiling.
     * #555 added a shared cap for the previously-unbounded post-terminal and
     * branch-evidence collections. Give those two independently useful,
     * bounded cohorts one aggregate 800k pool instead of letting the existing
     * metadata candidates consume the entire new budget before code scanning.
     */
    FUNCTION_AUX_SLOTS: 800_000,
    SUPPLEMENTAL_READ_BYTES: 24 * MiB,
    SUPPLEMENTAL_RESIDENT_BYTES: 12 * MiB,
    SUPPLEMENTAL_REGIONS: 128,
    SUPPLEMENTAL_NAMES: 100_000,
    SUPPLEMENTAL_OPERATIONS: 2_000_000,
    SUPPLEMENTAL_WALL_MS: 4_000,
    functionAuxLimit(requested) {
      const n = Number.isFinite(Number(requested)) ? Math.max(0, Math.floor(Number(requested))) : 0;
      return Math.min(800_000, Math.max(32_768, n * 2));
    },
    withinProgramBudget(currentBytes, temporaryBytes) {
      return currentBytes >= 0 && temporaryBytes >= 0 && currentBytes + temporaryBytes <= 96 * MiB;
    },
  });
})(globalThis);
