'use strict';

// Analysis-only instrumentation for PR #999. Do not merge.
// Adds a compact evidence bitmask aligned with the hardened guessFunctions
// output so the oracle-side probe can classify false positives by the exact
// evidence that allowed them to survive.
const __guessFunctionsBeforeEvidenceProbe = guessFunctions;

guessFunctions = async function guessFunctionsWithEvidenceProbe(args) {
  const result = await __guessFunctionsBeforeEvidenceProbe(args);
  if (!result || result.cancelled || !result.starts?.length) return result;
  const region = regions.get(args.regionId);
  const slice = slices.find((s) => (s.regions || []).some((r) => r.id === args.regionId));
  if (!region) return result;
  const ev = await __functionEvidence(region, slice, args.requestId);
  if (cancelled(args.requestId)) return { starts: new BigUint64Array(0), cancelled: true, __transfer: [] };

  const masks = new Uint16Array(result.starts.length);
  for (let i = 0; i < result.starts.length; i++) {
    const a = result.starts[i];
    let m = 0;
    if (ev.data.has(a)) m |= 1 << 0;
    if (ev.structured.has(a)) m |= 1 << 1;
    if (ev.exactMetadata.has(a)) m |= 1 << 2;
    if (ev.unwind.has(a)) m |= 1 << 3;
    if (ev.directCalls.has(a)) m |= 1 << 4;
    if (ev.prologues.has(a)) m |= 1 << 5;
    if (ev.terminalStarts.has(a)) m |= 1 << 6;
    if (ev.indirectTerminalStarts.has(a)) m |= 1 << 7;
    if (ev.conditionalTargets.has(a)) m |= 1 << 8;
    if (ev.tailCalls.has(a)) m |= 1 << 9;
    if (ev.exceptionLandingPads.has(a)) m |= 1 << 10;
    if (ev.interiorFrameSetups.has(a)) m |= 1 << 11;
    if (ev.denseAddressLeafStarts.has(a)) m |= 1 << 12;
    if (ev.trapTerminalStarts.has(a)) m |= 1 << 13;
    if (ev.indirectThunkStarts.has(a)) m |= 1 << 14;
    if (ev.repeatedThunkStarts.has(a) || ev.repeatedDirectTailStarts.has(a)) m |= 1 << 15;
    masks[i] = m;
  }
  return {
    ...result,
    analysisEvidenceMasks: masks,
    __transfer: [result.starts.buffer, masks.buffer],
  };
};
