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
  const data = new Set(), structured = new Set(), relativeCodeCandidates = new Set(), imageRelativeCodeCandidates = new Set();
  const exactMetadata = __addressBitmap(region);
  const directBranches = [];
  const unwind = __addressBitmap(region);
  const directCalls = __addressBitmap(region);
  const callSources = __addressBitmap(region);
  const conditionalSources = __addressBitmap(region);
  const returnSources = __addressBitmap(region);
  const indirectBranchSources = __addressBitmap(region);
  const prologues = __addressBitmap(region);
  const terminalStarts = __addressBitmap(region);
  const indirectTerminalStarts = __addressBitmap(region);
  const trapTerminalStarts = __addressBitmap(region);
  const conditionalTargets = __addressBitmap(region);
  const tailCalls = __addressBitmap(region);
  const indirectThunkStarts = __addressBitmap(region);
  const repeatedThunkStarts = __addressBitmap(region);
  const repeatedDirectTailStarts = __addressBitmap(region);
  const repeatedDirectTailGroups = [];
  const repeatedVectorFrameStarts = __addressBitmap(region);
  const exceptionLandingPads = __addressBitmap(region);
  const interiorFrameSetups = __addressBitmap(region);
  const denseAddressLeafStarts = __addressBitmap(region);
  const compactPrefixRecordStarts = new Set();
  const trapPeriodicGroups = [];
  const trapStrideGroups = [];
  const adrpReturnGroups = [];
  const tailCallCounts = new Map();
  const tailFrameCounts = new Map();
  const tailAddSpTargets = new Set(), tailFrameTargets = new Set();
  let ehFrameRanges = [];

  if (slice && imageBase != null) {
    // ABI-defined runtime metadata provides exact starts and complements the
    // structural boundary evidence below. Keep these independent collectors
    // authoritative when heuristic evidence is ambiguous.
    for (const a of await objcMethodImplementationStarts(slice, lo, hi, imageBase, requestId)) exactMetadata.add(a);
    for (const a of await initializerFunctionStarts(slice, lo, hi, imageBase, requestId)) exactMetadata.add(a);
    for (const a of await swiftReflectionFunctionStarts(slice, lo, hi, requestId)) exactMetadata.add(a);
    const unwindRegion = (slice.regions || []).find((r) => r.section === '__unwind_info' && r.size > 0n);
    let unwindLsdaEntries = [];
    if (unwindRegion && unwindRegion.size < 16n * 1024n * 1024n) {
      try {
        const buf = await readRange(unwindRegion.fileOffset, Number(unwindRegion.size));
        for (const a of MachO.parseUnwindStarts(buf, imageBase)) if (a >= lo && a < hi) unwind.add(a);
        unwindLsdaEntries = MachO.parseUnwindLsdaEntries(buf, imageBase);
      } catch { /* malformed unwind metadata is not evidence */ }
    }

    const exceptRegion = (slice.regions || []).find((r) => r.section === '__gcc_except_tab' && r.size > 0n);
    if (exceptRegion && unwindLsdaEntries.length && exceptRegion.size < 16n * 1024n * 1024n) {
      try {
        const buf = await readRange(exceptRegion.fileOffset, Number(exceptRegion.size));
        for (const a of MachO.parseLsdaLandingPads(buf, exceptRegion.vmAddr, unwindLsdaEntries, {
          pointerSize: slice.info?.is64 === false ? 4 : 8, textBase: imageBase,
        })) if (a >= lo && a < hi) exceptionLandingPads.add(a);
      } catch { /* malformed LSDA is not evidence */ }
    }

    // `.eh_frame` FDEs carry both an exact function start and its extent.
    // Starts reinforce compact-unwind metadata; extents let the hardened pass
    // reject heuristic "function starts" that are actually exception cleanup
    // / landing-pad code inside an existing FDE.
    const ehFrameRegion = (slice.regions || []).find((r) => r.section === '__eh_frame' && r.size > 0n);
    if (ehFrameRegion && ehFrameRegion.size < 16n * 1024n * 1024n) {
      try {
        const buf = await readRange(ehFrameRegion.fileOffset, Number(ehFrameRegion.size));
        ehFrameRanges = MachO.parseEhFrameRanges(buf, ehFrameRegion.vmAddr, {
          pointerSize: slice.info?.is64 === false ? 4 : 8, textBase: imageBase,
        }).filter((x) => x.end > lo && x.start < hi);
        for (const x of ehFrameRanges) if (x.start >= lo && x.start < hi) unwind.add(x.start);
      } catch { ehFrameRanges = []; /* malformed DWARF is not evidence */ }
    }

    // S_MOD_INIT_FUNC_OFFSETS stores 32-bit offsets from the image base to
    // initializer entry points. Unlike heuristic data pointers, these are
    // linker-defined function metadata and are safe exact seeds.
    for (const r of slice.regions || []) {
      if (r.section !== '__init_offsets' || r.size <= 0n || r.size > 16n * 1024n * 1024n) continue;
      try {
        const buf = await readRange(r.fileOffset, Number(r.size));
        const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
        for (let p = 0; p + 4 <= buf.byteLength; p += 4) {
          const target = imageBase + BigInt(dv.getUint32(p, true));
          if (target >= lo && target < hi && !(target & 3n)) { structured.add(target); exactMetadata.add(target); }
        }
      } catch { /* malformed initializer metadata is ignored */ }
    }

    for (const r of slice.regions || []) {
      if (r.section !== '__objc_methlist' || r.size <= 0n || r.size > 32n * 1024n * 1024n) continue;
      try {
        const buf = await readRange(r.fileOffset, Number(r.size));
        for (const a of MachO.parseObjcMethodStarts(buf, r.vmAddr, {
          regions: slice.regions || [], imageBase, architecture: slice.info?.architecture || 'arm64',
        })) {
          if (a >= lo && a < hi) { structured.add(a); exactMetadata.add(a); }
        }
      } catch { /* malformed Objective-C metadata is not evidence */ }
    }

    // Some Darwin metadata/vtable layouts store 32-bit offsets from the
    // image base rather than field-relative displacements. __DATA_CONST,__const
    // is immutable linker/runtime metadata, but arbitrary 32-bit words in it
    // are still only candidates. Promote them below only when the code stream
    // independently proves a fresh boundary after an indirect branch or trap.
    for (const r of slice.regions || []) {
      if (r.segment !== '__DATA_CONST' || r.section !== '__const' ||
          r.size <= 0n || r.size > 32n * 1024n * 1024n) continue;
      try {
        const buf = await readRange(r.fileOffset, Number(r.size));
        const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
        for (let p = 0; p + 4 <= buf.byteLength; p += 4) {
          const target = imageBase + BigInt(dv.getUint32(p, true));
          if (target >= lo && target < hi && !(target & 3n)) imageRelativeCodeCandidates.add(target);
        }
      } catch { /* malformed metadata is not evidence */ }
      if (cancelled(requestId)) break;
    }

    // Apple runtimes frequently store code references as signed 32-bit
    // offsets relative to the metadata field. Treat them as candidates only;
    // the code scan below must independently confirm an actual boundary.
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
          const delta = dv.getInt32(p, true);
          const target = r.vmAddr + BigInt(p) + BigInt(delta);
          if (target >= lo && target < hi && !(target & 3n)) relativeCodeCandidates.add(target);
        }
      } catch { /* malformed metadata is not evidence */ }
      if (cancelled(requestId)) break;
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

  let pos = 0, prevEnd = true, prevWord = null, prevPrevWord = null, prevThirdWord = null, prevFourthWord = null, prevFifthWord = null;
  const compactRecordWindow = [];
  const signed32 = (word) => word > 0x7fffffff ? word - 0x100000000 : word;
  const compactRecordField = (word) => {
    const value = signed32(word >>> 0);
    return value !== 0 && Math.abs(value) <= 0x10000 && (value & 3) === 0;
  };
  const compactRecordShape = (words, headLimit) => words.length === 4 &&
    words[0].w > 0 && words[0].w <= headLimit && (words[0].w & 3) === 0 &&
    words.slice(1).every((x) => compactRecordField(x.w));
  let lastAddressLeafStart = null;
  let lastIndirectBranch = null, betweenIndirectKinds = [];
  let lastDirectNextBranch = null, betweenDirectNextKinds = [];
  let lastDirectTailBranch = null, betweenDirectTailKinds = [];
  let directTailGroup = null;
  let directRepeatSig = null, directRepeatStarts = [];
  let repeatSig = null, repeatStarts = [];
  const flushRepeatedThunks = () => {
    if (repeatStarts.length >= 3) for (const a of repeatStarts) repeatedThunkStarts.add(a);
    repeatSig = null; repeatStarts = [];
  };
  const flushRepeatedDirectTails = () => {
    // Five same-shape straight-line leaf blocks in a row is strong compiler
    // layout evidence. Requiring repetition prevents ordinary CFG fallthrough
    // branches from becoming synthetic function starts.
    if (directRepeatStarts.length >= 5) for (const a of directRepeatStarts) repeatedDirectTailStarts.add(a);
    directRepeatSig = null; directRepeatStarts = [];
  };
  const flushDirectTailGroup = () => {
    if (directTailGroup && directTailGroup.starts.length >= 3) repeatedDirectTailGroups.push(directTailGroup);
    directTailGroup = null;
  };
  let trapRunStart = null, trapRunValues = [];
  let inlineUdfRunStart = null, inlineUdfValues = [];
  let adrpReturnRun = [];
  const vectorFrameCandidates = new Map();
  const vectorFrameToken = (word) => {
    const m = Words.memoryAccess(word);
    if (m) return `m:${m.load ? 'l' : 's'}:${m.pair ? 'p' : '-'}:${m.vector ? 'v' : '-'}:${m.base}:${m.reg}:${m.reg2 ?? '-'}:${m.mode || '-'}`;
    const fpSetup = ((word >>> 23) & 0x1ff) === 0x122 && ((word >>> 5) & 31) === 31 && (word & 31) === 29;
    return fpSetup ? 'fp' : `k:${Words.classifyWord(word)}`;
  };
  const recordVectorFrameCandidate = (start, before, words) => {
    if (start < lo || before == null || !Words.isBranchImm(before) || Words.isCallImm(before)) return;
    const first = Words.memoryAccess(words[0]);
    if (!first || !first.store || !first.pair || !first.vector || first.base !== 31 || first.mode !== 'pre') return;
    const sig = words.map(vectorFrameToken).join('|');
    let list = vectorFrameCandidates.get(sig);
    if (!list) vectorFrameCandidates.set(sig, list = []);
    list.push(start);
  };
  const flushAdrpReturnRun = () => {
    if (adrpReturnRun.length >= 2) adrpReturnGroups.push(adrpReturnRun);
    adrpReturnRun = [];
  };
  const flushInlineUdfRun = () => {
    /* Clang/Swift sometimes place fixed-width 16-byte descriptor records in
       executable islands immediately beside their generated entry points.
       AArch64 decodes the small descriptor fields as UDF immediates.  Do not
       key off any descriptor value: infer the 4-word record layout from a
       homogeneous UDF run and require a small, low-entropy header column. */
    if (inlineUdfRunStart != null && inlineUdfValues.length >= 8 &&
        inlineUdfValues.length <= 256 && (inlineUdfValues.length % 4) === 0 &&
        trapPeriodicGroups.length < 1024) {
      const headers = [];
      for (let i = 0; i < inlineUdfValues.length; i += 4) headers.push(inlineUdfValues[i]);
      const distinct = new Set(headers);
      if (headers.every((value) => value > 0 && value <= 0x40) && distinct.size <= 3) {
        trapPeriodicGroups.push(headers.map((_, i) => inlineUdfRunStart + BigInt(i * 16)));
      }
    }
    inlineUdfRunStart = null; inlineUdfValues = [];
  };
  const flushTrapRun = () => {
    if (trapRunStart != null && trapRunValues.length >= 12 && trapRunValues.length <= 4096 && trapPeriodicGroups.length < 1024) {
      // Some compiler/linker generated trap-stub tables are self-describing:
      // the first trap payload is the fixed record width in bytes.  Record
      // this inferred layout only when it spans at least four records and
      // every record head carries a small aligned trap payload as an
      // independent sanity check.  Acceptance still requires a known function
      // anchor in the hardened pass below.
      const stride = trapRunValues[0] >>> 0;
      if (stride >= 12 && stride <= 128 && (stride & 3) === 0) {
        const step = stride >>> 2;
        const group = [];
        let sane = true;
        for (let i = 0; i < trapRunValues.length; i += step) {
          const v = trapRunValues[i] >>> 0;
          if (v < 4 || v > 256 || (v & 3) !== 0) { sane = false; break; }
          group.push(trapRunStart + BigInt(i * 4));
        }
        if (sane && group.length >= 4) trapStrideGroups.push(group);
      }
      const positions = new Map();
      for (let i = 0; i < trapRunValues.length; i++) {
        const v = trapRunValues[i];
        let list = positions.get(v);
        if (!list) positions.set(v, list = []);
        list.push(i);
      }
      for (const list of positions.values()) {
        if (list.length < 4) continue;
        for (let i = 0; i + 3 < list.length && trapPeriodicGroups.length < 1024; i++) {
          const gap = list[i + 1] - list[i];
          if (gap < 3 || gap > 16) continue;
          let j = i + 2;
          while (j < list.length && list[j] - list[j - 1] === gap) j++;
          if (j - i >= 4) {
            trapPeriodicGroups.push(list.slice(i, j).map((k) => trapRunStart + BigInt(k * 4)));
            i = j - 2;
          }
        }
      }
    }
    trapRunStart = null; trapRunValues = [];
  };
  while (pos < Number(region.size)) {
    if (cancelled(requestId)) break;
    const blk = await readRange(region.fileOffset + BigInt(pos), Math.min(1024 * 1024, Number(region.size) - pos));
    if (blk.length < 4) break;
    const n = Math.floor(blk.length / 4);
    const dv = new DataView(blk.buffer, blk.byteOffset, n * 4);
    for (let i = 0; i < n; i++) {
      const w = dv.getUint32(i * 4, true);
      const pc = region.vmAddr + BigInt(pos + i * 4);
      compactRecordWindow.push({ pc, w });
      if (compactRecordWindow.length > 8) compactRecordWindow.shift();
      if (compactRecordWindow.length === 8) {
        const previousRecord = compactRecordWindow.slice(0, 4);
        const currentRecord = compactRecordWindow.slice(4);
        // Swift/Clang executable descriptor islands can use a compact 16-byte
        // record immediately before a generated entry point.  The trailing
        // fields are signed relative offsets, so one may decode as a normal
        // instruction instead of UDF.  Recognize the ABI-like record shape,
        // but defer promotion until the following entry is independently
        // accepted by the hardened pass.
        if (compactRecordShape(previousRecord, 0x100) &&
            compactRecordShape(currentRecord, 24)) {
          compactPrefixRecordStarts.add(currentRecord[0].pc);
        }
      }
      if (Words.looksLikePrologue(w)) prologues.add(pc);
      if (Words.isRet(w) && prevWord != null && prevPrevWord != null &&
          Words.classifyWord(prevPrevWord) === Words.KIND.ADRP && Words.classifyWord(prevWord) === Words.KIND.ARITH) {
        const start = pc - 8n;
        const baseReg = prevPrevWord & 31;
        const addRd = prevWord & 31, addRn = (prevWord >>> 5) & 31;
        if (baseReg === 0 && addRd === 0 && addRn === 0) {
          if (lastAddressLeafStart === start - 12n) {
            denseAddressLeafStarts.add(lastAddressLeafStart);
            denseAddressLeafStarts.add(start);
          }
          lastAddressLeafStart = start;
        } else {
          lastAddressLeafStart = null;
        }
      }
      if (prevWord != null) {
        const pm = Words.memoryAccess(prevWord);
        const fpSetup = ((w >>> 23) & 0x1ff) === 0x122 && ((w >>> 5) & 31) === 31 && (w & 31) === 29;
        const savedFpLr = pm && pm.store && pm.pair && !pm.vector && pm.base === 31 &&
          ((pm.reg === 29 && pm.reg2 === 30) || (pm.reg === 30 && pm.reg2 === 29));
        if (fpSetup && savedFpLr) {
          interiorFrameSetups.add(pc);
          // Large compiler-generated helpers sometimes start by spilling a
          // SIMD callee-saved pair before the ordinary FP/LR frame record. A
          // single vector spill is too common to be a boundary signal, so
          // learn only repeated, same-shape prologues that follow an
          // unconditional terminator. Immediates are deliberately omitted
          // from the shape; register/dataflow structure is retained.
          if (prevPrevWord != null && prevThirdWord != null)
            recordVectorFrameCandidate(pc - 8n, prevThirdWord, [prevPrevWord, prevWord, w]);
          if (prevThirdWord != null && prevFourthWord != null)
            recordVectorFrameCandidate(pc - 12n, prevFourthWord, [prevThirdWord, prevPrevWord, prevWord, w]);
          if (prevFourthWord != null && prevFifthWord != null)
            recordVectorFrameCandidate(pc - 16n, prevFifthWord, [prevFourthWord, prevThirdWord, prevPrevWord, prevWord, w]);
        }
      }
      if (prevEnd) terminalStarts.add(pc);
      if (prevWord != null && Words.isBr(prevWord)) indirectTerminalStarts.add(pc);
      if (prevWord != null && Words.classifyWord(prevWord) === Words.KIND.TRAP) trapTerminalStarts.add(pc);
      if (Words.isCallImm(w)) {
        callSources.add(pc);
        const t = Words.branchImm26(w, pc);
        if (t != null && t >= lo && t < hi) directCalls.add(t);
      }
      if (Words.isCondBranch(w)) {
        conditionalSources.add(pc);
        const t = Words.condBranchTarget(w, pc);
        if (t != null && t >= lo && t < hi) conditionalTargets.add(t);
      }
      if (Words.isRet(w)) returnSources.add(pc);
      if (Words.isBr(w)) indirectBranchSources.add(pc);
      if (Words.isBranchImm(w)) {
        const t = Words.branchImm26(w, pc);
        if (t != null && t >= lo && t < hi && directBranches.length < 400000) {
          directBranches.push(Number(pc - lo), Number(t - lo));
        }
      }
      // Repeated `adrp; add; ret` leaf blocks can be either genuine
      // address-returning functions or labels inside a larger compiler-emitted
      // code island. Record their resolved targets so the hardened pass can
      // distinguish independently seeded function tables from duplicated
      // in-function islands without relying on addresses or immediates.
      if (prevPrevWord != null && prevWord != null && Words.isRet(w)) {
        const rel = Words.pcRelTarget(prevPrevWord, pc - 8n);
        const off = Words.pairedOffset(prevWord);
        if (rel && off && !off.load && rel.reg === off.rn) {
          const start = pc - 8n;
          const item = { start, target: rel.value + off.imm };
          if (adrpReturnRun.length && start !== adrpReturnRun[adrpReturnRun.length - 1].start + 12n) flushAdrpReturnRun();
          adrpReturnRun.push(item);
        } else {
          flushAdrpReturnRun();
        }
      } else if (adrpReturnRun.length && (prevPrevWord == null || prevWord == null || pc > adrpReturnRun[adrpReturnRun.length - 1].start + 20n)) {
        flushAdrpReturnRun();
      }

      if (prevWord != null && Words.isBranchImm(w)) {
        const t = Words.branchImm26(w, pc);
        const pairRestoresFrame = (x) => {
          if (x == null) return false;
          const m = Words.memoryAccess(x);
          return !!(m && m.load && m.pair && m.base === 31 &&
            ((m.reg === 29 && m.reg2 === 30) || (m.reg === 30 && m.reg2 === 29)));
        };
        const addRestoresSp = (x) => x != null && ((x >>> 23) & 0x1ff) === 0x122 &&
          ((x >>> 5) & 31) === 31 && (x & 31) === 31;
        if (t != null && t >= lo && t < hi) {
          if (pairRestoresFrame(prevWord)) tailCallCounts.set(t, (tailCallCounts.get(t) || 0) + 1);
          // Tail calls commonly restore several callee-saved pairs before the
          // final branch, so FP/LR need not be the immediately preceding ldp.
          if (pairRestoresFrame(prevWord) || pairRestoresFrame(prevPrevWord) || pairRestoresFrame(prevThirdWord)) {
            tailFrameTargets.add(t);
            tailFrameCounts.set(t, (tailFrameCounts.get(t) || 0) + 1);
          }
          // A final `add sp, sp, #imm ; b target` is a stack-teardown tail
          // call. It is promoted only after the target is independently seen
          // at another terminal/prologue boundary below.
          if (addRestoresSp(prevWord)) tailAddSpTargets.add(t);
        }
      }

      // Common virtual-dispatch thunk: load the dispatch object through an
      // x0 pre-index access, load a method pointer from it, then `br` to that
      // pointer. The indirect branch has no fallthrough; the following word
      // is therefore a fresh code island/function candidate rather than part
      // of the thunk. Register chaining prevents treating jump-table `br`s as
      // this pattern.
      if (prevPrevWord != null && prevWord != null && Words.isBr(w)) {
        const a = Words.memoryAccess(prevPrevWord);
        const b = Words.memoryAccess(prevWord);
        const brReg = (w >>> 5) & 31;
        if (a && b && a.load && b.load && a.base === 0 && a.mode === 'pre' &&
            b.base === a.reg && b.reg === brReg && pc + 4n < hi) {
          indirectThunkStarts.add(pc + 4n);
        }
        // Masked dispatch tail used by pointer-auth/vtable style thunks:
        //   ldr rBase, [...] ; and rBase, rBase, rMask
        //   ldr rTarget, [rBase, ...] ; br rTarget
        // The register chain makes this distinct from a generic computed
        // switch branch, and the indirect branch terminates the thunk.
        if (prevThirdWord != null) {
          const baseLoad = Words.memoryAccess(prevThirdWord);
          const targetLoad = Words.memoryAccess(prevWord);
          const logicReg = prevPrevWord & 31;
          const logicRn = (prevPrevWord >>> 5) & 31;
          if (baseLoad && targetLoad && baseLoad.load && targetLoad.load &&
              Words.classifyWord(prevPrevWord) === Words.KIND.LOGIC &&
              baseLoad.reg === logicReg && logicRn === logicReg &&
              targetLoad.base === logicReg && targetLoad.reg === brReg && pc + 4n < hi) {
            indirectThunkStarts.add(pc + 4n);
          }
        }
      }
      // Repeated short indirect-branch thunks are a common compiler ABI
      // layout (vtable/witness forwarding tables). Detect the repetition
      // structurally instead of hard-coding any one instruction sequence.
      // Three adjacent same-shape thunks are required before contributing
      // boundaries, which avoids treating an ordinary switch CFG as a table
      // of functions.
      const currentKind = Words.classifyWord(w);

      // Learn repeated direct-tail thunk tables from layout rather than fixed
      // opcodes. Promotion happens later only when a majority of both entry
      // boundaries and destinations are already independently known.
      if (lastDirectTailBranch != null && betweenDirectTailKinds.length <= 8) betweenDirectTailKinds.push(currentKind);
      if (Words.isBranchImm(w)) {
        if (lastDirectTailBranch != null) {
          const gap = pc - lastDirectTailBranch;
          const body = betweenDirectTailKinds;
          const internalControl = body.slice(0, -1).some((k) =>
            k === Words.KIND.BRANCH || k === Words.KIND.CONDBR || k === Words.KIND.CALL ||
            k === Words.KIND.INDCALL || k === Words.KIND.RET);
          if (gap >= 8n && gap <= 32n && body.length >= 2 && body.length <= 8 && !internalControl &&
              body[body.length - 1] === Words.KIND.BRANCH) {
            const sig = gap.toString() + ':' + body.join(',');
            if (directTailGroup && directTailGroup.sig === sig && directTailGroup.last === lastDirectTailBranch) {
              directTailGroup.starts.push(pc + 4n);
              directTailGroup.branches.push(pc);
              directTailGroup.last = pc;
            } else {
              flushDirectTailGroup();
              directTailGroup = { sig, last: pc, starts: [lastDirectTailBranch + 4n, pc + 4n], branches: [lastDirectTailBranch, pc] };
            }
          } else flushDirectTailGroup();
        }
        lastDirectTailBranch = pc;
        betweenDirectTailKinds = [];
      } else if (lastDirectTailBranch != null && betweenDirectTailKinds.length > 8) {
        flushDirectTailGroup();
        lastDirectTailBranch = null;
        betweenDirectTailKinds = [];
      }
      // Some compiler-generated leaf helpers are emitted as repeated, fixed-
      // shape straight-line blocks whose final `b` targets the very next word.
      // A single `b .+4` proves nothing, but five adjacent blocks with the same
      // shape and no other control-flow instruction form a robust table-like
      // function layout. Learn both the width and shape from the binary.
      if (lastDirectNextBranch != null && betweenDirectNextKinds.length <= 8) betweenDirectNextKinds.push(currentKind);
      if (Words.isBranchImm(w)) {
        const nextTarget = Words.branchImm26(w, pc);
        if (nextTarget === pc + 4n) {
          if (lastDirectNextBranch != null && betweenDirectNextKinds.length >= 2 && betweenDirectNextKinds.length <= 8) {
            const controlCount = betweenDirectNextKinds.reduce((n, k) => n + Number(
              k === Words.KIND.BRANCH || k === Words.KIND.CONDBR || k === Words.KIND.CALL ||
              k === Words.KIND.INDCALL || k === Words.KIND.RET), 0);
            if (controlCount === 1 && betweenDirectNextKinds[betweenDirectNextKinds.length - 1] === Words.KIND.BRANCH) {
              const sig = betweenDirectNextKinds.length + ':' + betweenDirectNextKinds.join(',');
              if (sig === directRepeatSig) directRepeatStarts.push(pc + 4n);
              else {
                flushRepeatedDirectTails();
                directRepeatSig = sig;
                directRepeatStarts = [lastDirectNextBranch + 4n, pc + 4n];
              }
            } else {
              flushRepeatedDirectTails();
            }
          } else {
            flushRepeatedDirectTails();
          }
          lastDirectNextBranch = pc;
          betweenDirectNextKinds = [];
        }
      }
      if (lastDirectNextBranch != null && betweenDirectNextKinds.length > 8) {
        flushRepeatedDirectTails();
        lastDirectNextBranch = null;
        betweenDirectNextKinds = [];
      }
      const smallUdf = w !== 0 && (w >>> 16) === 0;
      if (smallUdf) {
        if (inlineUdfRunStart == null) inlineUdfRunStart = pc;
        if (inlineUdfValues.length < 257) inlineUdfValues.push(w);
      } else {
        flushInlineUdfRun();
      }
      if (currentKind === Words.KIND.TRAP) {
        if (trapRunStart == null) trapRunStart = pc;
        if (trapRunValues.length < 4097) trapRunValues.push(w);
      } else {
        flushTrapRun();
        flushAdrpReturnRun();
      }
      if (lastIndirectBranch != null && betweenIndirectKinds.length <= 12) betweenIndirectKinds.push(currentKind);
      if (Words.isBr(w)) {
        if (lastIndirectBranch != null && betweenIndirectKinds.length > 0 && betweenIndirectKinds.length <= 12) {
          const start = lastIndirectBranch + 4n;
          const sig = betweenIndirectKinds.join(',');
          if (sig === repeatSig) repeatStarts.push(start);
          else { flushRepeatedThunks(); repeatSig = sig; repeatStarts = [start]; }
        } else {
          flushRepeatedThunks();
        }
        lastIndirectBranch = pc;
        betweenIndirectKinds = [];
      } else if (lastIndirectBranch != null && betweenIndirectKinds.length > 12) {
        flushRepeatedThunks();
        lastIndirectBranch = null;
        betweenIndirectKinds = [];
      }

      // A direct branch to the immediately following instruction is CFG-
      // equivalent to fallthrough; it must not manufacture a function boundary.
      const directNext = Words.isBranchImm(w) && Words.branchImm26(w, pc) === pc + 4n;
      prevEnd = !directNext && Words.looksLikeEnd(w);
      prevFifthWord = prevFourthWord;
      prevFourthWord = prevThirdWord;
      prevThirdWord = prevPrevWord;
      prevPrevWord = prevWord;
      prevWord = w;
    }
    pos += n * 4;
    await yieldToQueue();
  }
  flushRepeatedThunks();
  flushRepeatedDirectTails();
  flushDirectTailGroup();
  flushInlineUdfRun();
  flushTrapRun();
  // A repeated structural frame shape within one small code neighbourhood is
  // strong compiler-layout evidence. Require a matching peer within 4 KiB;
  // isolated vector spills remain ordinary intra-function instructions.
  for (const starts of vectorFrameCandidates.values()) {
    starts.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (let i = 0; i < starts.length; i++) {
      if ((i > 0 && starts[i] - starts[i - 1] <= 4096n) ||
          (i + 1 < starts.length && starts[i + 1] - starts[i] <= 4096n)) {
        repeatedVectorFrameStarts.add(starts[i]);
      }
    }
  }
  for (const [target, count] of tailCallCounts) {
    if (count >= 2 || prologues.has(target) || terminalStarts.has(target)) tailCalls.add(target);
  }
  for (const target of tailAddSpTargets) {
    if (prologues.has(target) || terminalStarts.has(target)) tailCalls.add(target);
  }
  for (const target of tailFrameTargets) {
    if (prologues.has(target)) tailCalls.add(target);
  }
  for (const [target, count] of tailFrameCounts) {
    if (count >= 2) tailCalls.add(target);
  }
  // Require an independent target-boundary signal before treating an
  // epilogue branch as a function-to-function tail call. This distinguishes
  // real tail calls from ordinary intra-function CFG branches.
  for (const target of relativeCodeCandidates) {
    if (terminalStarts.has(target) || indirectTerminalStarts.has(target) || prologues.has(target) || directCalls.has(target) || unwind.has(target)) {
      structured.add(target);
    }
  }
  for (const target of imageRelativeCodeCandidates) {
    if (indirectTerminalStarts.has(target) || trapTerminalStarts.has(target)) structured.add(target);
  }
  return { data, structured, exactMetadata, directBranches, compactPrefixRecordStarts, trapPeriodicGroups, trapStrideGroups, adrpReturnGroups, ehFrameRanges, exceptionLandingPads, interiorFrameSetups, denseAddressLeafStarts, unwind, directCalls, callSources, conditionalSources, returnSources, indirectBranchSources, prologues, terminalStarts, indirectTerminalStarts, conditionalTargets, tailCalls, indirectThunkStarts, repeatedThunkStarts, repeatedDirectTailStarts, repeatedDirectTailGroups, repeatedVectorFrameStarts };
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

function __strictlyInsideFunctionRange(ranges, addr) {
  let lo = 0, hi = ranges.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ranges[mid].start < addr) lo = mid + 1;
    else hi = mid;
  }
  // Only a range whose start is strictly before addr can contain it. Adjacent
  // FDEs are valid, so equality with the next start is never considered inside.
  for (let i = lo - 1; i >= 0 && i >= lo - 3; i--) {
    const r = ranges[i];
    if (addr > r.start && addr < r.end) return true;
  }
  return false;
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

  const kept = new Set();
  let filteredDataCandidates = 0;
  for (const a of result.starts) {
    const exact = ev.unwind.has(a) || ev.directCalls.has(a) || ev.exactMetadata.has(a);
    const strong = exact || ev.structured.has(a) || ev.tailCalls.has(a);
    if (!strong && (ev.interiorFrameSetups.has(a) || ev.denseAddressLeafStarts.has(a))) {
      if (ev.data.has(a)) filteredDataCandidates++;
      continue;
    }
    if (!exact && (ev.exceptionLandingPads.has(a) || __strictlyInsideFunctionRange(ev.ehFrameRanges, a))) {
      if (ev.data.has(a)) filteredDataCandidates++;
      continue;
    }
    // A conditional branch target is ordinarily a Basic Block inside the same
    // function, not a new function entry. Preserve only independent metadata
    // or call evidence when those two roles intentionally coincide.
    if (ev.conditionalTargets.has(a) && !strong) {
      if (ev.data.has(a)) filteredDataCandidates++;
      continue;
    }
    // AArch64 prologues are often multi-instruction sequences (PAC/BTI,
    // stack save, stack allocation). A candidate at the second consecutive
    // prologue instruction is inside the already-started function, not a new
    // entry. Independent metadata/call evidence still wins.
    if (!strong && ev.prologues.has(a) && ev.prologues.has(a - 4n)) {
      if (ev.data.has(a)) filteredDataCandidates++;
      continue;
    }
    if (!ev.data.has(a)) { kept.add(a); continue; }
    const confirmed = strong || ev.prologues.has(a) || ev.terminalStarts.has(a);
    if (confirmed) kept.add(a);
    else filteredDataCandidates++;
  }
  // Runtime-defined Objective-C method lists are exact function-start metadata
  // even when their relative IMPs never appear as raw data pointers.
  for (const a of ev.structured) {
    if (a < region.vmAddr || a >= region.vmAddr + region.size) continue;
    if (!ev.exactMetadata.has(a) && (ev.exceptionLandingPads.has(a) || __strictlyInsideFunctionRange(ev.ehFrameRanges, a))) continue;
    kept.add(a);
  }
  // Two or more independent epilogues restoring FP/LR and branching to the
  // same address are strong evidence of a shared tail-called function entry.
  for (let off = 0n; off < region.size; off += 4n) {
    const a = region.vmAddr + off;
    if (ev.tailCalls.has(a) || ev.indirectThunkStarts.has(a) || ev.repeatedThunkStarts.has(a) || ev.repeatedDirectTailStarts.has(a) || ev.repeatedVectorFrameStarts.has(a)) kept.add(a);
  }
  // Fill holes in repeated direct-tail thunk tables only when the table is
  // already independently anchored. This recovers prologue-less thunks while
  // refusing unanchored local CFG labels.
  {
    const branchTargetBySource = new Map();
    for (let e = 0; e + 1 < ev.directBranches.length; e += 2) {
      const src = region.vmAddr + BigInt(ev.directBranches[e]);
      if (ev.callSources.has(src)) continue;
      branchTargetBySource.set(src, region.vmAddr + BigInt(ev.directBranches[e + 1]));
    }
    for (const group of ev.repeatedDirectTailGroups || []) {
      const starts = group.starts.filter((a) => a >= region.vmAddr && a < region.vmAddr + region.size);
      if (starts.length < 3) continue;
      let knownStarts = 0;
      for (const a of starts) if (kept.has(a)) knownStarts++;
      if (knownStarts * 2 < starts.length) continue;
      let knownTargets = 0, totalTargets = 0;
      for (const src of group.branches) {
        const target = branchTargetBySource.get(src);
        if (target == null) continue;
        totalTargets++;
        if (kept.has(target)) knownTargets++;
      }
      if (!totalTargets || knownTargets * 2 < totalTargets) continue;
      for (const a of starts) {
        if (ev.exceptionLandingPads.has(a) || __strictlyInsideFunctionRange(ev.ehFrameRanges, a)) continue;
        kept.add(a);
      }
    }
  }

  // Reject post-return switch/case veneer islands before using terminal
  // boundaries as positive evidence.  Compilers may place several tiny case
  // veneers after a function return; each veneer tail-branches backward to the
  // same local continuation.  That layout looks like a table of leaf functions
  // unless the shared backward target is treated as negative evidence.
  {
    const branchTargetBySource = new Map();
    for (let e = 0; e + 1 < ev.directBranches.length; e += 2) {
      const src = region.vmAddr + BigInt(ev.directBranches[e]);
      if (ev.callSources.has(src)) continue;
      branchTargetBySource.set(src, region.vmAddr + BigInt(ev.directBranches[e + 1]));
    }
    const passStarts = Array.from(kept).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (let i = 1; i < passStarts.length; i++) {
      const start = passStarts[i];
      if (!ev.returnSources.has(start - 4n)) continue;
      if (ev.unwind.has(start) || ev.directCalls.has(start) || ev.exactMetadata.has(start) || ev.structured.has(start)) continue;
      const previous = passStarts[i - 1];
      let cur = start, commonTarget = null, blocks = 0, valid = true;
      while (blocks < 12 && cur < region.vmAddr + region.size) {
        let end = null;
        for (let q = cur; q < cur + 24n && q < region.vmAddr + region.size; q += 4n) {
          if (ev.callSources.has(q) || ev.conditionalSources.has(q) || ev.returnSources.has(q) || ev.indirectBranchSources.has(q)) { valid = false; break; }
          const target = branchTargetBySource.get(q);
          if (target == null) continue;
          if (target >= start || target < previous || start - target > 256n) { valid = false; break; }
          if (commonTarget == null) commonTarget = target;
          else if (commonTarget !== target) { valid = false; break; }
          end = q + 4n;
          break;
        }
        if (!valid || end == null) break;
        blocks++;
        cur = end;
      }
      if (valid && blocks >= 4 && commonTarget != null) kept.delete(start);
    }
  }

  // Propagate function identity through short, independently proven tail
  // wrappers.  If an exact function is <=32 bytes and its final instruction
  // is an unconditional B immediately before the next known boundary, its
  // branch target is a function entry.  This is ABI/control-flow evidence,
  // not a target-address or binary-specific signature.
  let tailChanged = true, tailPasses = 0;
  while (tailChanged && tailPasses++ < 8) {
    tailChanged = false;
    const passStarts = Array.from(kept).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    let si = 0;
    for (let e = 0; e + 1 < ev.directBranches.length; e += 2) {
      const src = region.vmAddr + BigInt(ev.directBranches[e]);
      const target = region.vmAddr + BigInt(ev.directBranches[e + 1]);
      const next = src + 4n;
      if (kept.has(target) || !kept.has(next)) continue;
      while (si + 1 < passStarts.length && passStarts[si + 1] < next) si++;
      if (si + 1 >= passStarts.length || passStarts[si + 1] !== next) continue;
      const start = passStarts[si];
      if (src < start || src - start + 4n > 32n) continue;
      if (!(ev.unwind.has(start) || ev.directCalls.has(start) || ev.exactMetadata.has(start))) continue;
      kept.add(target); tailChanged = true;
    }
  }

  // Split a compact interval into repeated terminal-delimited tail thunks
  // only when the *entire* interval is covered by short straight-line blocks.
  // Every block must end in an outward unconditional branch, indirect branch,
  // or return; calls and conditional branches invalidate the interval.  This
  // learns compiler-generated thunk tables from control-flow structure rather
  // than from fixed opcodes, addresses, or binary-specific constants.
  {
    const branchTargetBySource = new Map();
    for (let e = 0; e + 1 < ev.directBranches.length; e += 2) {
      const src = region.vmAddr + BigInt(ev.directBranches[e]);
      if (ev.callSources.has(src)) continue;
      branchTargetBySource.set(src, region.vmAddr + BigInt(ev.directBranches[e + 1]));
    }
    const passStarts = Array.from(kept).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const inferred = [];
    for (let i = 0; i + 1 < passStarts.length; i++) {
      const lo = passStarts[i], hi = passStarts[i + 1];
      if (hi - lo < 12n || hi - lo > 1024n) continue;
      let cur = lo, valid = true;
      const blocks = [lo];
      while (cur < hi && blocks.length <= 64) {
        let end = null;
        for (let q = cur; q < cur + 28n && q < hi; q += 4n) {
          if (ev.callSources.has(q) || ev.conditionalSources.has(q)) { valid = false; break; }
          const target = branchTargetBySource.get(q);
          if (target != null) {
            if (target >= lo && target < hi) { valid = false; break; }
            end = q + 4n;
            break;
          }
          if (ev.indirectBranchSources.has(q) || ev.returnSources.has(q)) { end = q + 4n; break; }
        }
        if (!valid || end == null || end <= cur || end > hi) { valid = false; break; }
        cur = end;
        if (cur < hi) blocks.push(cur);
      }
      if (!valid || cur !== hi || blocks.length < 3) continue;
      for (let j = 1; j < blocks.length; j++) {
        const a = blocks[j];
        if (ev.exceptionLandingPads.has(a) || __strictlyInsideFunctionRange(ev.ehFrameRanges, a)) continue;
        inferred.push(a);
      }
    }
    for (const a of inferred) kept.add(a);
  }

  // Recover terminal-separated entries reached by an unconditional branch
  // from outside the currently inferred function interval.  This is the
  // layout form produced by tail-called helpers that intentionally omit a
  // conventional prologue.  Requiring both a terminal predecessor and an
  // incoming edge from outside the interval avoids promoting ordinary local
  // basic-block labels.
  let externalTailChanged = true, externalTailPasses = 0;
  while (externalTailChanged && externalTailPasses++ < 4) {
    externalTailChanged = false;
    const passStarts = Array.from(kept).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const bounds = (target) => {
      let lo = 0, hi = passStarts.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (passStarts[mid] < target) lo = mid + 1;
        else hi = mid;
      }
      return {
        prev: lo > 0 ? passStarts[lo - 1] : region.vmAddr,
        next: lo < passStarts.length ? passStarts[lo] : region.vmAddr + region.size,
      };
    };
    for (let e = 0; e + 1 < ev.directBranches.length; e += 2) {
      const src = region.vmAddr + BigInt(ev.directBranches[e]);
      const target = region.vmAddr + BigInt(ev.directBranches[e + 1]);
      if (kept.has(target) || !ev.terminalStarts.has(target)) continue;
      if (ev.exceptionLandingPads.has(target) || __strictlyInsideFunctionRange(ev.ehFrameRanges, target)) continue;
      const { prev, next } = bounds(target);
      if (src >= prev && src < next) continue;
      kept.add(target);
      externalTailChanged = true;
    }
  }

  // A run of tiny `adrp; add; ret` address getters is ambiguous without
  // entry metadata: the same three instructions also occur at case labels
  // inside larger functions. Duplicated target-vectors are strong evidence of
  // copied/inlined code islands, while a long unreferenced run has no external
  // entry evidence at all. Suppress only those two conservative cases. Exact
  // unwind/call/runtime metadata always wins.
  const adrpRunByTargets = new Map();
  for (const group of ev.adrpReturnGroups || []) {
    const sig = group.map((x) => x.target.toString(16)).join(',');
    let list = adrpRunByTargets.get(sig);
    if (!list) adrpRunByTargets.set(sig, list = []);
    list.push(group);
  }
  for (const groups of adrpRunByTargets.values()) {
    const duplicated = groups.length > 1;
    for (const group of groups) {
      const exactSeed = group.some(({ start }) =>
        ev.unwind.has(start) || ev.directCalls.has(start) || ev.exactMetadata.has(start));
      if (exactSeed || (!duplicated && group.length < 10)) continue;
      for (const { start } of group) kept.delete(start);
    }
  }

  // Recover compact 16-byte compiler descriptor records that sit directly
  // before an independently accepted generated entry.  Both the current and
  // preceding records must have a small aligned ABI-like shape; this prevents
  // arbitrary executable data from becoming function starts.
  for (const a of ev.compactPrefixRecordStarts || []) {
    if (kept.has(a + 16n)) kept.add(a);
  }

  // Recover self-described fixed-width trap-stub tables.  The width is
  // learned from the run itself; a previously accepted entry fixes the phase
  // so a periodic value in the middle of a record cannot create false starts.
  for (const group of ev.trapStrideGroups || []) {
    if (!group.some((a) => kept.has(a))) continue;
    for (const a of group) kept.add(a);
  }

  // Recover periodic trap-stub tables only when one member of the same
  // inferred period is already a proven/accepted function start. The period
  // and marker value are learned from the run itself; no binary-specific UDF
  // immediate is baked into the recognizer.
  for (const group of ev.trapPeriodicGroups) {
    // A long, exactly periodic marker sequence inside a trap-only island is
    // itself strong layout evidence. Shorter sequences still need one already
    // proven member so random embedded data cannot manufacture boundaries.
    if (group.length < 6 && !group.some((a) => kept.has(a))) continue;
    for (const a of group) kept.add(a);
  }

  const ordered = Array.from(kept).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const starts = new BigUint64Array(ordered.length);
  for (let i = 0; i < ordered.length; i++) starts[i] = ordered[i];
  return {
    ...result,
    starts,
    filteredDataCandidates,
    dataPointerRequiresConfirmation: true,
    __transfer: [starts.buffer],
  };
};
