'use strict';

// Analysis-only A/B probe.  Never merge this file to production.
// Test the hypothesis that the post-indirect-BR ADRP->LOAD->LOAD
// global-dispatch prefix promotes switch/state-machine interiors as functions.
const __guessFunctionsBeforeAnalysisFilter = guessFunctions;

guessFunctions = async function guessFunctionsWithoutGlobalDispatchFallthrough(args) {
  const result = await __guessFunctionsBeforeAnalysisFilter(args);
  if (!result || result.cancelled || !result.starts?.length) return result;
  const region = regions.get(args.regionId);
  if (!region) return result;

  const kept = [];
  let filteredGlobalDispatchAfterBr = 0;
  for (const a0 of result.starts) {
    const a = BigInt(a0);
    let drop = false;
    const rel = a - region.vmAddr;
    if (rel >= 4n && rel + 12n <= region.size) {
      const raw = await readRange(region.fileOffset + rel - 4n, 16);
      if (raw.length >= 16) {
        const dv = new DataView(raw.buffer, raw.byteOffset, 16);
        const prev = dv.getUint32(0, true);
        const w0 = dv.getUint32(4, true);
        const w1 = dv.getUint32(8, true);
        const w2 = dv.getUint32(12, true);
        if (Words.isBr(prev) && Words.classifyWord(w0) === Words.KIND.ADRP &&
            Words.classifyWord(w1) === Words.KIND.LOAD && Words.classifyWord(w2) === Words.KIND.LOAD) {
          const d = w0 & 31;
          const g1 = Words.memoryAccess(w1);
          const g2 = Words.memoryAccess(w2);
          if (g1 && g1.load && g1.base === d && g1.reg === d &&
              g2 && g2.load && (!g2.indexed || g2.reg !== g2.base)) {
            drop = true;
            filteredGlobalDispatchAfterBr++;
          }
        }
      }
    }
    if (!drop) kept.push(a);
  }

  const starts = new BigUint64Array(kept.length);
  for (let i = 0; i < kept.length; i++) starts[i] = kept[i];
  return {
    ...result,
    starts,
    analysisFilteredGlobalDispatchAfterBr: filteredGlobalDispatchAfterBr,
    __transfer: [starts.buffer],
  };
};
