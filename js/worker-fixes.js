'use strict';

/*
 * Compatibility hardening loaded after worker-legacy.js.  Keeping the large
 * worker body byte-for-byte intact makes this patch reviewable while replacing
 * only the three audited entry points.
 */

const __legacyRunSearch = runSearch;
const __legacyGuessFunctions = guessFunctions;

const __utf8Encoder = new TextEncoder();
const __utf8Decoder = new TextDecoder('utf-8', { fatal: false });
const __ASCII_A = 0x41, __ASCII_Z = 0x5a;
const __asciiLower = (b) => (b >= __ASCII_A && b <= __ASCII_Z ? b + 0x20 : b);
const __allAscii = (u8) => {
  for (let i = 0; i < u8.length; i++) if (u8[i] >= 0x80) return false;
  return true;
};

/* Issue #287: text search must search the bytes that are actually stored in
 * the binary.  ASCII keeps the legacy case-insensitive behaviour; non-ASCII is
 * exact UTF-8 so Japanese/emoji remain byte-accurate across chunk boundaries. */
runSearch = async function runSearchHardened(args) {
  if (!args || args.kind !== 'text') return __legacyRunSearch(args);
  const region = regions.get(args.regionId);
  if (!region) throw new Error('Unknown region.');
  const results = [];
  const total = Number(region.size);
  const startByte = Math.max(0, Math.min(total, Number(args.from || 0)));
  const query = String(args.query || '');
  if (!query) throw new Error('Enter text to search for.');

  const rawPat = __utf8Encoder.encode(query);
  if (!rawPat.length) throw new Error('Enter text to search for.');
  const asciiFold = __allAscii(rawPat);
  const pat = rawPat.slice();
  if (asciiFold) for (let i = 0; i < pat.length; i++) pat[i] = __asciiLower(pat[i]);
  const plen = pat.length;
  const cap = 1000;
  const blockSize = 512 * 1024;
  let pos = startByte, scanned = 0, capped = false;
  let carry = new Uint8Array(0);

  while (pos < total) {
    if (cancelled(args.requestId)) return { cancelled: true, results, scanned, capped: false };
    const want = Math.min(blockSize, total - pos);
    const blk = await readRange(region.fileOffset + BigInt(pos), want);
    if (!blk.length) break;
    const joined = carry.length ? concat(carry, blk) : blk;
    const base = pos - carry.length;
    const limit = joined.length - plen + 1;

    for (let i = 0; i < limit; i++) {
      let ok = true;
      for (let j = 0; j < plen; j++) {
        const got = asciiFold ? __asciiLower(joined[i + j]) : joined[i + j];
        if (got !== pat[j]) { ok = false; break; }
      }
      if (!ok) continue;
      const byteOff = base + i;
      const previewFrom = Math.max(0, i - 32);
      const previewTo = Math.min(joined.length, i + plen + 48);
      const preview = __utf8Decoder.decode(joined.subarray(previewFrom, previewTo))
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '·');
      results.push({
        row: Math.floor(byteOff / 4),
        addr: region.vmAddr + BigInt(byteOff),
        text: preview,
        byteOff,
      });
      if (results.length >= cap) { capped = true; break; }
    }

    pos += blk.length;
    scanned = pos - startByte;
    if (capped) break;
    carry = plen > 1
      ? joined.slice(Math.max(0, joined.length - Math.min(plen - 1, joined.length)))
      : new Uint8Array(0);
    self.postMessage({
      t: 'searchProgress', requestId: args.requestId, epoch: args.epoch,
      done: scanned, all: total - startByte, hits: results.length,
    });
    await yieldToQueue();
  }
  return { results, scanned, capped, cancelled: false };
};

function __clearPages(pageOf, pageAt) {
  pageOf.fill(null);
  pageAt.fill(-1);
}

function __controlBoundary(w) {
  return Words.isCallImm(w) || Words.isIndirectCall(w) || Words.isBranchImm(w) ||
    Words.isCondBranch(w) || Words.isRet(w) || Words.isBr(w);
}

function __writesLowReg(w) {
  const K = Words.KIND;
  const kind = Words.classifyWord(w);
  return !new Set([
    K.NOP, K.CONDBR, K.CMP, K.BRANCH, K.CALL, K.INDCALL,
    K.RET, K.STORE, K.SYS, K.TRAP,
  ]).has(kind);
}

/* Issue #289: ADRP provenance is local to an uninterrupted definition/use
 * chain.  Register redefinitions and CFG/call boundaries invalidate it. */
findXrefs = async function findXrefsHardened({ regionId, target, limit, requestId, epoch }) {
  const region = regions.get(regionId);
  if (!region) throw new Error('Unknown region.');
  const want = BigInt(target);
  const cap = Math.min(Number(limit) || 2000, 2000);
  const total = Number(region.size);
  const out = [];
  const pageOf = new Array(32).fill(null);
  const pageAt = new Int32Array(32); pageAt.fill(-1);
  let index = 0, pos = 0;

  while (pos < total && out.length < cap) {
    if (cancelled(requestId)) return { results: out, cancelled: true, capped: false };
    const blk = await readRange(region.fileOffset + BigInt(pos), Math.min(1024 * 1024, total - pos));
    if (blk.length < 4) break;
    const words = Math.floor(blk.length / 4);
    const dv = new DataView(blk.buffer, blk.byteOffset, words * 4);
    for (let i = 0; i < words; i++, index++) {
      const w = dv.getUint32(i * 4, true);
      const byteOff = pos + i * 4;
      const pc = region.vmAddr + BigInt(byteOff);
      const direct = Words.wordTarget(w, pc);
      if (direct != null && direct === want) {
        out.push({ row: byteOff / 4, addr: pc, kind: 'branch' });
        if (out.length >= cap) break;
      }

      /* Never carry an address materialisation through another CFG path or a
       * call. This intentionally prefers a missed xref to an invented one. */
      if (__controlBoundary(w)) {
        __clearPages(pageOf, pageAt);
        continue;
      }

      const rel = Words.pcRelTarget(w, pc);
      if (rel) {
        pageOf[rel.reg] = rel.value;
        pageAt[rel.reg] = index;
        if (!rel.page && rel.value === want) {
          out.push({ row: byteOff / 4, addr: pc, kind: 'address' });
          if (out.length >= cap) break;
        }
        continue;
      }

      const pair = Words.pairedOffset(w);
      let propagated = -1;
      if (pair && pageOf[pair.rn] != null && index - pageAt[pair.rn] <= 8) {
        const full = pageOf[pair.rn] + pair.imm;
        if (full === want) {
          out.push({
            row: byteOff / 4, addr: pc,
            kind: pair.load ? 'load' : pair.store ? 'store' : 'address',
          });
          if (out.length >= cap) break;
        }
        if (!pair.load && !pair.store) {
          pageOf[pair.rd] = full;
          pageAt[pair.rd] = index;
          propagated = pair.rd;
        } else if (pair.load && pair.rd < 31) {
          pageOf[pair.rd] = null;
          pageAt[pair.rd] = -1;
        }
      }

      if (__writesLowReg(w)) {
        const d = w & 31;
        if (d < 31 && d !== propagated) {
          pageOf[d] = null;
          pageAt[d] = -1;
        }
      }
    }
    pos += words * 4;
    scanProgress(requestId, epoch, pos, total, out.length);
    await yieldToQueue();
  }
  return { results: out, cancelled: false, capped: out.length >= cap };
};

function __mappedDataAddress(slice, addr, codeRegion) {
  if (addr == null) return false;
  for (const r of (slice && slice.regions) || []) {
    if (r === codeRegion || r.zerofill || r.size <= 0n) continue;
    if (addr >= r.vmAddr && addr < r.vmAddr + r.size) return true;
  }
  return false;
}

function __addressBitmap(region) {
  const rows = Math.ceil(Number(region.size) / 4);
  const bits = new Uint8Array(Math.ceil(rows / 8));
  const indexOf = (addr) => {
    if (addr == null || addr < region.vmAddr) return -1;
    const delta = addr - region.vmAddr;
    if (delta >= region.size || (delta & 3n)) return -1;
    const index = Number(delta >> 2n);
    return Number.isSafeInteger(index) ? index : -1;
  };
  return {
    add(addr) {
      const index = indexOf(addr);
      if (index >= 0) bits[index >> 3] |= 1 << (index & 7);
    },
    has(addr) {
      const index = indexOf(addr);
      return index >= 0 && !!(bits[index >> 3] & (1 << (index & 7)));
    },
  };
}

async function __functionEvidence(region, slice, requestId) {
  const lo = region.vmAddr, hi = region.vmAddr + region.size;
  const imageBase = slice && slice.info ? slice.info.textVM : null;
  const data = new Set(), structured = new Set();
  const unwind = __addressBitmap(region);
  const directCalls = __addressBitmap(region);
  const prologues = __addressBitmap(region);
  const terminalStarts = __addressBitmap(region);
  const indirectTailStarts = __addressBitmap(region);
  const metadataFunctions = __addressBitmap(region);
  const conditionalTargets = __addressBitmap(region);

  if (slice && imageBase != null) {
    for (const a of await objcMethodImplementationStarts(slice, lo, hi, imageBase, requestId)) metadataFunctions.add(a);
    for (const a of await initializerFunctionStarts(slice, lo, hi, imageBase, requestId)) metadataFunctions.add(a);
    for (const a of await swiftReflectionFunctionStarts(slice, lo, hi, requestId)) metadataFunctions.add(a);

    const unwindRegion = (slice.regions || []).find((r) => r.section === '__unwind_info' && r.size > 0n);
    if (unwindRegion && unwindRegion.size < 16n * 1024n * 1024n) {
      try {
        const buf = await readRange(unwindRegion.fileOffset, Number(unwindRegion.size));
        for (const a of MachO.parseUnwindStarts(buf, imageBase)) if (a >= lo && a < hi) unwind.add(a);
      } catch { /* malformed unwind metadata is not evidence */ }
    }

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
          const t = ptr[i];
          if (t != null && t >= lo && t < hi && !(t & 3n)) data.add(t);
        }

        /* Itanium ABI vtable: [offset-to-top][typeinfo][method...].  Requiring
         * the header plus a mapped non-code typeinfo pointer distinguishes a
         * vtable from an arbitrary switch/state table of code labels. */
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
          if (j > i) for (let k = i; k < j; k++) structured.add(ptr[k]);
          i = Math.max(i, j - 1);
        }
      } catch { /* unreadable metadata is ignored */ }
      if (cancelled(requestId)) break;
    }
  }

  let pos = 0, prevEnd = true, prevIndirectBr = false, pendingIndirectTail = null;
  const indirectTailNext = new Set([
    Words.KIND.STORE, Words.KIND.ADRP, Words.KIND.ARITH,
    Words.KIND.RET, Words.KIND.CMP, Words.KIND.MOVREG,
  ]);
  while (pos < Number(region.size)) {
    if (cancelled(requestId)) break;
    const blk = await readRange(region.fileOffset + BigInt(pos), Math.min(1024 * 1024, Number(region.size) - pos));
    if (blk.length < 4) break;
    const n = Math.floor(blk.length / 4);
    const dv = new DataView(blk.buffer, blk.byteOffset, n * 4);
    for (let i = 0; i < n; i++) {
      const w = dv.getUint32(i * 4, true);
      const pc = region.vmAddr + BigInt(pos + i * 4);
      const kind = Words.classifyWord(w);
      if (pendingIndirectTail != null) {
        if (indirectTailNext.has(kind)) indirectTailStarts.add(pendingIndirectTail);
        pendingIndirectTail = null;
      }
      if (prevIndirectBr && Words.isBranchImm(w)) pendingIndirectTail = pc;
      if (Words.looksLikePrologue(w)) prologues.add(pc);
      if (prevEnd) terminalStarts.add(pc);
      if (Words.isCondBranch(w)) {
        const t = Words.condBranchTarget(w, pc);
        if (t != null && t >= lo && t < hi) conditionalTargets.add(t);
      }
      if (Words.isCallImm(w)) {
        const t = Words.branchImm26(w, pc);
        if (t != null && t >= lo && t < hi) directCalls.add(t);
      }
      prevEnd = Words.looksLikeEnd(w) || kind === Words.KIND.TRAP;
      prevIndirectBr = Words.isBr(w);
    }
    pos += n * 4;
    await yieldToQueue();
  }
  return { data, structured, unwind, directCalls, prologues, terminalStarts, indirectTailStarts, metadataFunctions, conditionalTargets };
}

const __FUNCTION_DIRECT_BYTES = 24n * 1024n * 1024n;
const __FUNCTION_CHUNK_BYTES = 8n * 1024n * 1024n;
const __FUNCTION_CHUNK_OVERLAP = 1n * 1024n * 1024n;

function __minBigInt(a, b) { return a < b ? a : b; }

/*
 * #555 bounds the legacy candidate collections to protect iPad-class devices.
 * A single shared pool is intentionally fail-closed for adversarial dense code,
 * but a normal 25–40 MiB __text can contain enough legitimate ret/branch
 * boundaries to consume that pool even though each local neighbourhood is
 * ordinary compiler output.  Process large code regions in overlapping 8 MiB
 * windows so the same bounded algorithm can release its temporary JS objects
 * between windows.  Only the non-overlap core contributes results, preserving
 * one global 400k output cap without raising the per-window memory ceiling.
 */
async function __budgetedLegacyGuessFunctions(args) {
  const region = regions.get(args.regionId);
  if (!region || region.size <= __FUNCTION_DIRECT_BYTES) return __legacyGuessFunctions(args);
  const slice = slices.find((s) => (s.regions || []).some((r) => r.id === args.regionId));
  if (!slice) return __legacyGuessFunctions(args);

  const cap = Math.min(Number(args.limit) || 400_000, 400_000);
  const originalRegions = slice.regions;
  const merged = new Set();
  let incomplete = false;
  let truncationReason = null;

  try {
    for (let coreStart = 0n; coreStart < region.size && merged.size < cap; coreStart += __FUNCTION_CHUNK_BYTES) {
      if (cancelled(args.requestId)) return { starts: new BigUint64Array(0), cancelled: true };
      const coreEnd = __minBigInt(region.size, coreStart + __FUNCTION_CHUNK_BYTES);
      const scanStart = coreStart > __FUNCTION_CHUNK_OVERLAP ? coreStart - __FUNCTION_CHUNK_OVERLAP : 0n;
      const scanEnd = __minBigInt(region.size, coreEnd + __FUNCTION_CHUNK_OVERLAP);
      const temp = {
        ...region,
        id: region.id + ':fn:' + coreStart.toString(16),
        fileOffset: region.fileOffset + scanStart,
        vmAddr: region.vmAddr + scanStart,
        size: scanEnd - scanStart,
      };
      regions.set(temp.id, temp);
      slice.regions = [...originalRegions, temp];
      let part;
      try {
        part = await __legacyGuessFunctions({ ...args, regionId: temp.id, limit: cap });
      } finally {
        regions.delete(temp.id);
        slice.regions = originalRegions;
      }
      if (!part || part.cancelled) return part || { starts: new BigUint64Array(0), cancelled: true };

      const lo = region.vmAddr + coreStart;
      const hi = region.vmAddr + coreEnd;
      for (const addr of part.starts || []) {
        if (addr >= lo && addr < hi) merged.add(addr);
        if (merged.size >= cap) break;
      }
      if (part.complete === false || part.capped) {
        incomplete = true;
        truncationReason ||= part.truncationReason || part.completeness?.reason || 'candidate-memory-budget';
      }
      await yieldToQueue();
    }
  } finally {
    slice.regions = originalRegions;
  }

  const list = Array.from(merged).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const starts = new BigUint64Array(list.length);
  for (let i = 0; i < list.length; i++) starts[i] = list[i];
  const outputCapped = merged.size >= cap;
  const capped = outputCapped || incomplete;
  const reason = outputCapped ? 'function-start-cap-reached' : truncationReason;
  return {
    starts,
    cancelled: false,
    capped,
    truncated: capped,
    complete: !capped,
    cap,
    truncationReason: reason,
    completeness: {
      complete: !capped,
      reason,
      discovered: list.length,
      cap,
      chunked: true,
      addressRange: { regionId: args.regionId, vmAddr: region.vmAddr, size: region.size, complete: !capped },
    },
    __transfer: [starts.buffer],
  };
}

/* Issue #288: a raw pointer into __text is candidate evidence, never proof of a
 * function boundary. Keep metadata-derived starts only when a second,
 * independent signal confirms them. A terminal boundary remains independent
 * evidence even when another branch also targets the same entry; branch-target
 * status must not negate stronger evidence. */
guessFunctions = async function guessFunctionsHardened(args) {
  const result = await __budgetedLegacyGuessFunctions(args);
  if (!result || result.cancelled || !result.starts || !result.starts.length) return result;
  const region = regions.get(args.regionId);
  const slice = slices.find((s) => (s.regions || []).some((r) => r.id === args.regionId));
  if (!region) return result;
  const ev = await __functionEvidence(region, slice, args.requestId);
  if (cancelled(args.requestId)) return { starts: new BigUint64Array(0), cancelled: true };

  const kept = [];
  let filteredDataCandidates = 0;
  for (const a of result.starts) {
    const exact = ev.unwind.has(a) || ev.directCalls.has(a) || ev.structured.has(a) || ev.metadataFunctions.has(a);
    /* A conditional branch stays inside its current function by construction.
       Treat a conditional target as an internal basic block unless independent
       metadata/call evidence proves that the same address is also a public
       function entry.  This removes cold/outlined blocks that happen to begin
       with a normal-looking prologue after an early return. */
    if (ev.conditionalTargets.has(a) && !exact) { filteredDataCandidates++; continue; }
    if (!ev.data.has(a)) { kept.push(a); continue; }
    const confirmed = exact || ev.prologues.has(a) || ev.terminalStarts.has(a) || ev.indirectTailStarts.has(a);
    if (confirmed) kept.push(a);
    else filteredDataCandidates++;
  }
  const starts = new BigUint64Array(kept.length);
  for (let i = 0; i < kept.length; i++) starts[i] = kept[i];
  return {
    ...result,
    starts,
    filteredDataCandidates,
    dataPointerRequiresConfirmation: true,
    __transfer: [starts.buffer],
  };
};
