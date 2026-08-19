'use strict';

/*
 * Cross-binary function-boundary hardening.
 *
 * worker-fixes.js collects several structurally different metadata sources in
 * one `structured` Set.  In particular, every raw u32 in __DATA_CONST,__const
 * that happens to decode as imageBase+offset inside __text is promoted to
 * `structured` when the target is immediately after an indirect branch.  The
 * same BR boundary then becomes both the reason for promotion and the reason
 * `structured` is accepted as strong evidence.
 *
 * Keep the existing collectors byte-for-byte intact and restore provenance in
 * this late wrapper: recompute only the broad raw-u32 cohort and remove its
 * circular `structured` promotion unless a separately-derived signal confirms
 * the target.  Exact ObjC/initializer/Swift metadata and non-broad structured
 * sources are untouched.
 */
const __functionEvidenceBeforeImageRelativeHardening = __functionEvidence;

function __hasIndependentFunctionEvidence(ev, target) {
  return ev.exactMetadata?.has?.(target) ||
    ev.unwind?.has?.(target) ||
    ev.directCalls?.has?.(target) ||
    ev.prologues?.has?.(target) ||
    ev.tailCalls?.has?.(target) ||
    ev.indirectThunkStarts?.has?.(target) ||
    ev.repeatedThunkStarts?.has?.(target) ||
    ev.repeatedDirectTailStarts?.has?.(target) ||
    ev.exceptionLandingPads?.has?.(target) ||
    ev.denseAddressLeafStarts?.has?.(target);
}

async function __broadImageRelativeCandidates(region, slice, requestId) {
  const out = new Set();
  const imageBase = slice?.info?.textVM;
  if (imageBase == null) return out;
  const lo = region.vmAddr;
  const hi = region.vmAddr + region.size;

  for (const r of slice.regions || []) {
    if (r.segment !== '__DATA_CONST' || r.section !== '__const' || r.size <= 0n || r.size > 64n * 1024n * 1024n) continue;
    try {
      const buf = await readRange(r.fileOffset, Number(r.size));
      const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
      for (let p = 0; p + 4 <= buf.byteLength; p += 4) {
        const target = imageBase + BigInt(dv.getUint32(p, true));
        if (target >= lo && target < hi && !(target & 3n)) out.add(target);
      }
    } catch { /* malformed/raw data is not evidence */ }
    if (cancelled(requestId)) break;
  }
  return out;
}

__functionEvidence = async function functionEvidenceWithProvenance(region, slice, requestId) {
  const ev = await __functionEvidenceBeforeImageRelativeHardening(region, slice, requestId);
  if (!ev?.structured || cancelled(requestId)) return ev;

  const broad = await __broadImageRelativeCandidates(region, slice, requestId);
  if (cancelled(requestId)) return ev;

  let removedCircularImageRelative = 0;
  for (const target of broad) {
    if (!ev.structured.has(target)) continue;
    // Only the observed circular route is removed here. A broad word that was
    // independently validated remains strong, and other structured provenance
    // is never inferred from membership in this raw cohort alone.
    if (!ev.indirectTerminalStarts?.has?.(target)) continue;
    if (__hasIndependentFunctionEvidence(ev, target)) continue;
    ev.structured.delete(target);
    removedCircularImageRelative++;
  }

  ev.provenanceStats = {
    ...(ev.provenanceStats || {}),
    broadImageRelativeCandidates: broad.size,
    removedCircularImageRelative,
  };
  return ev;
};
