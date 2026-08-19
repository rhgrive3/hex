'use strict';

/*
 * Cross-binary function-boundary hardening.
 *
 * worker-fixes.js aggregates structurally different metadata sources in one
 * `structured` Set. A raw u32 in __DATA_CONST,__const can therefore become
 * `structured` merely because imageBase+u32 lands in __text immediately after
 * an indirect branch. The same BR boundary then acts twice: once to promote
 * the raw word and again through `structured` as strong function evidence.
 *
 * Reconstruct provenance before hardened guessFunctions consumes that Set.
 * Exact metadata, field-relative metadata and validated Itanium vtables remain
 * independent evidence. Raw image-relative words are independent only when
 * their source layout itself looks like a table: at least two adjacent words
 * map into code, or the same code target occurs more than once in the section.
 * An isolated one-off raw word immediately after BR is not a second source.
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

async function __imageRelativeProvenance(region, slice, requestId) {
  const broad = new Set();
  const layoutBacked = new Set();
  const imageBase = slice?.info?.textVM;
  if (imageBase == null) return { broad, layoutBacked };
  const lo = region.vmAddr;
  const hi = region.vmAddr + region.size;
  const occurrences = new Map();

  for (const r of slice.regions || []) {
    if (r.segment !== '__DATA_CONST' || r.section !== '__const' || r.size <= 0n || r.size > 32n * 1024n * 1024n) continue;
    try {
      const buf = await readRange(r.fileOffset, Number(r.size));
      const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
      const count = Math.floor(buf.byteLength / 4);
      const words = new Array(count).fill(null);
      for (let i = 0; i < count; i++) {
        const target = imageBase + BigInt(dv.getUint32(i * 4, true));
        if (target < lo || target >= hi || (target & 3n)) continue;
        words[i] = target;
        broad.add(target);
        const key = target.toString();
        occurrences.set(key, (occurrences.get(key) || 0) + 1);
      }

      // Adjacent relative code offsets are table-layout evidence independent of
      // the target instruction's predecessor. Preserve the whole contiguous run.
      for (let i = 0; i < count;) {
        if (words[i] == null) { i++; continue; }
        let j = i + 1;
        while (j < count && words[j] != null) j++;
        if (j - i >= 2) for (let k = i; k < j; k++) layoutBacked.add(words[k]);
        i = j;
      }
    } catch { /* malformed/raw data is not evidence */ }
    if (cancelled(requestId)) return { broad, layoutBacked };
  }

  // A target repeated independently in the raw metadata is also source-layout
  // corroboration. This does not depend on the code bytes or oracle truth.
  for (const target of broad) {
    if ((occurrences.get(target.toString()) || 0) >= 2) layoutBacked.add(target);
  }
  return { broad, layoutBacked };
}

async function __independentStructuredCandidates(region, slice, ev, requestId) {
  const out = new Set();
  const imageBase = slice?.info?.textVM;
  if (imageBase == null) return out;
  const lo = region.vmAddr;
  const hi = region.vmAddr + region.size;

  // Field-relative Swift/runtime metadata is a distinct physical source from
  // image-relative raw u32s. Preserve it under the same boundary contract as
  // worker-fixes.js.
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

  // Reconstruct the validated Itanium-vtable rule. These pointers are backed
  // by the offset-to-top/typeinfo layout, not by the BR predecessor relation.
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

  const [imageRelative, independentStructured] = await Promise.all([
    __imageRelativeProvenance(region, slice, requestId),
    __independentStructuredCandidates(region, slice, ev, requestId),
  ]);
  if (cancelled(requestId)) return ev;

  let removedCircularImageRelative = 0;
  for (const target of imageRelative.broad) {
    if (!ev.structured.has(target)) continue;
    if (!ev.indirectTerminalStarts?.has?.(target)) continue;
    if (imageRelative.layoutBacked.has(target)) continue;
    if (independentStructured.has(target)) continue;
    if (__hasIndependentFunctionEvidence(ev, target)) continue;
    ev.structured.delete(target);
    removedCircularImageRelative++;
  }

  ev.provenanceStats = {
    ...(ev.provenanceStats || {}),
    broadImageRelativeCandidates: imageRelative.broad.size,
    layoutBackedImageRelativeCandidates: imageRelative.layoutBacked.size,
    independentStructuredCandidates: independentStructured.size,
    removedCircularImageRelative,
  };
  return ev;
};
