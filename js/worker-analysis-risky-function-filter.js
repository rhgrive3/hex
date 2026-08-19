'use strict';

// Analysis-only A/B for PR #999. Do not merge this wrapper.
// The production fix belongs inside __functionEvidence/guessFunctionsHardened:
// an image-relative metadata candidate plus "immediately after BR" must not be
// counted twice as independent evidence. This post-filter models the intended
// acceptance rule without perturbing production code during diagnosis.
const __guessFunctionsBeforeRiskFilter = guessFunctions;

guessFunctions = async function guessFunctionsRiskFiltered(args) {
  const result = await __guessFunctionsBeforeRiskFilter(args);
  if (!result || result.cancelled || !result.starts?.length || !result.analysisEvidenceMasks) return result;
  const masks = result.analysisEvidenceMasks;
  const keep = new Uint8Array(result.starts.length);
  let n = 0, filtered = 0;
  for (let i = 0; i < result.starts.length; i++) {
    const m = masks[i];
    const data = !!(m & (1 << 0));
    const structured = !!(m & (1 << 1));
    const exactMetadata = !!(m & (1 << 2));
    const unwind = !!(m & (1 << 3));
    const directCall = !!(m & (1 << 4));
    const prologue = !!(m & (1 << 5));
    const indirectTerminal = !!(m & (1 << 7));
    const tailCall = !!(m & (1 << 9));
    const indirectThunk = !!(m & (1 << 14));
    const repeatedThunk = !!(m & (1 << 15));
    const riskyCircularEvidence = data && structured && indirectTerminal;
    const independent = exactMetadata || unwind || directCall || prologue || tailCall || indirectThunk || repeatedThunk;
    if (riskyCircularEvidence && !independent) { filtered++; continue; }
    keep[i] = 1; n++;
  }
  if (!filtered) return { ...result, analysisRiskFiltered: 0 };
  const starts = new BigUint64Array(n);
  const outMasks = new Uint16Array(n);
  for (let i = 0, j = 0; i < result.starts.length; i++) {
    if (!keep[i]) continue;
    starts[j] = result.starts[i];
    outMasks[j] = masks[i];
    j++;
  }
  return {
    ...result,
    starts,
    analysisEvidenceMasks: outMasks,
    analysisRiskFiltered: filtered,
    __transfer: [starts.buffer, outMasks.buffer],
  };
};
