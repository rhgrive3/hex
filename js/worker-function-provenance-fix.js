'use strict';

/*
 * Cross-binary function-boundary hardening.
 *
 * worker-fixes.js collects several structurally different metadata sources in
 * one `structured` Set. In particular, every raw u32 in __DATA_CONST,__const
 * that happens to decode as imageBase+offset inside __text is promoted to
 * `structured` when the target is immediately after an indirect branch. The
 * same BR boundary then becomes both the reason for promotion and the reason
 * `structured` is accepted as strong evidence.
 *
 * Restore the provenance that the aggregate Set loses. We recompute only the
 * broad image-relative cohort and the two non-exact structured sources that
 * can overlap it (field-relative metadata and validated Itanium vtables). A
 * target is removed only when its sole structured provenance is the circular
 * raw-u32 + immediately-after-BR route.
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
    if (r.segment !== '__DATA_CONST' || r.section !== '__const' || r.size <= 0n || r.size > 32n * 1024n * 1024n) continue;
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

async function __independentStructuredCandidates(region, slice, ev, requestId) {
  const out = new Set();
  const imageBase = slice?.info?.textVM;
  if (imageBase == null) return out;
  const lo = region.vmAddr;
  const hi = region.vmAddr + region.size;

  // Field-relative Swift/runtime metadata is a distinct physical source from
  // image-relative raw u32s. Preserve it only under the same boundary contract
  // used by worker-fixes.js.
  for (const r of slice.regions || []) {
    if (r.size <= 0n || r.size > 32n * 1024n * 1024n) continue;
    const sec = r.section || '';
    const relativeMetadata = sec === '__constg_swiftt' || sec.startsWith('__swift5_') ||
      (sec === '__const' && (r.segment === '__TEXT' || r.segment === '__DATA_CONST'));
    if (!relativeMetadata) continue;
    try {
      const buf = await readRange(r.fileOffset, Number(r.size));
      const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
      for (let p = 0; p + 4 <= buf.byteLength; p += 4) {
        const target = r.vmAddr + BigInt(p) + BigInt(dv.getInt32(p, true));
        if (target < lo || target >= hi || (target & 3n)) continue;
        if (ev.terminalStarts?.has?.(target) || ev.indirectTerminalStarts?.has?.(target) ||
            ev.prologues?.has?.(target) || ev.directCalls?.has?.(target) || ev.unwind?.has?.(target)) {
          out.add(target);
        }
      }
    } catch { /* malformed metadata is not evidence */ }
    if (cancelled(requestId)) return out;
  }

  // Reconstruct the exact validated-vtable rule from worker-fixes.js. These
  // entries are structured because of the Itanium header/typeinfo layout, not
  // because they happen to be after BR, so overlap with the broad-u32 cohort
  // must not erase them.
  for (const r of slice.regions || []) {
    if (r.size <= 0n || r.size > 32n * 1024n * 1024n) continue;
    if (!/^__(const|data|objc_const|cfstring)$/.test(r.section || '')) continue;
    try {
      const buf = await readRange(r.fileOffset, Number(r.size));
      const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
      const q = Math.floor(buf.byteLength / 8);
      const raw = new Array(q);
      const ptr = new Array(q);
      for (let i = 0; i < q; i++) {
        raw[i] = dv.getBigUint64(i * 8, true);
        ptr[i] = sanitizeStubPointer(raw[i], imageBase);
      }
      for (let i = 2; i < q; i++) {
        const first = ptr[i];
        if (first == null || first < lo || first >= hi || (first & 3n)) continue;
        const off = BigInt.asIntN(64, raw[i - 2]);
        const ti = ptr[i - 1];
        if (off < -0x100000n || off > 0x100000n || !__mappedDataAddress(slice, ti, region)) continue;
        let j = i;
        while (j < q) {
          const t = ptr[j];
          if (t == null || t < lo || t >= hi || (t & 3n)) break;
          j++;
        }
        for (let k = i; k < j; k++) out.add(ptr[k]);
        i = Math.max(i, j - 1);
      }
    } catch { /* unreadable metadata is not evidence */ }
    if (cancelled(requestId)) return out;
  }

  return out;
}

__functionEvidence = async function functionEvidenceWithProvenance(region, slice, requestId) {
  const ev = await __functionEvidenceBeforeImageRelativeHardening(region, slice, requestId);
  if (!ev?.structured || cancelled(requestId)) return ev;

  const [broad, independentStructured] = await Promise.all([
    __broadImageRelativeCandidates(region, slice, requestId),
    __independentStructuredCandidates(region, slice, ev, requestId),
  ]);
  if (cancelled(requestId)) return ev;

  let removedCircularImageRelative = 0;
  for (const target of broad) {
    if (!ev.structured.has(target)) continue;
    if (!ev.indirectTerminalStarts?.has?.(target)) continue;
    if (independentStructured.has(target)) continue;
    if (__hasIndependentFunctionEvidence(ev, target)) continue;
    ev.structured.delete(target);
    removedCircularImageRelative++;
  }

  ev.provenanceStats = {
    ...(ev.provenanceStats || {}),
    broadImageRelativeCandidates: broad.size,
    independentStructuredCandidates: independentStructured.size,
    removedCircularImageRelative,
  };
  return ev;
};
