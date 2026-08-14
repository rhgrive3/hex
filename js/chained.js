/*
 * Modern dyld chained-fixup support for the analysis worker.
 *
 * Xcode can leave LC_DYSYMTAB present while making its indirect entries useless
 * (for example, all __stubs entries can point at unnamed nlist records). The
 * runtime truth then lives in LC_DYLD_CHAINED_FIXUPS: each GOT slot contains a
 * bind ordinal and the fixups payload maps that ordinal to the imported symbol.
 *
 * This file is loaded *after* worker.js. It wraps analyzeSlice without changing
 * the worker protocol, so the UI, Node harness and all downstream consumers see
 * the recovered names through the existing SymbolIndex result.
 */
(function (global) {
  'use strict';

  if (typeof analyzeSlice !== 'function' || typeof readRange !== 'function') return;

  const LC_DYLD_CHAINED_FIXUPS = 0x80000034;
  const HEADER_LIMIT = 4 * 1024 * 1024;
  const FIXUPS_LIMIT = 64 * 1024 * 1024;
  const SEGMENT_LIMIT = 64 * 1024 * 1024;
  const IMPORT_LIMIT = 400_000;
  const CHAIN_GUARD = 2_000_000;
  const START_NONE = 0xffff;
  const START_MULTI = 0x8000;
  const START_LAST = 0x8000;

  const originalAnalyzeSlice = analyzeSlice;

  analyzeSlice = async function analyzeSliceWithChainedFixups(args) {
    const base = await originalAnalyzeSlice(args);
    const slice = slices && slices[args && args.sliceIndex];
    if (!slice || !slice.info || !slice.info.is64) return base;

    let extra = [];
    try { extra = await chainedSymbolEntries(slice); }
    catch { extra = []; }
    if (!extra.length) return base;

    const merged = mergeSymbolResult(base, extra);

    /* Keep stripped-boundary recovery in sync with the newly recovered imports. */
    const NORETURN_NAME = /(?:^|_)(?:stack_chk_fail|objc_exception_throw|abort|assert_rtn|cxa_throw|terminate|swift_.*(?:fatal|trap)|fatalError)(?:$|@)/i;
    if (!slice.noreturnTargets) slice.noreturnTargets = new Set();
    for (let i = 0; i < merged.addrs.length; i++) {
      if (NORETURN_NAME.test(merged._names[i] || '')) slice.noreturnTargets.add(merged.addrs[i]);
    }

    return {
      addrs: merged.addrs,
      kinds: merged.kinds,
      flags: merged.flags,
      names: merged._names.join('\n'),
      funcs: base.funcs,
      symbolCount: merged.addrs.length,
      funcCount: base.funcCount,
      functionStartsExact: !!base.functionStartsExact,
      capped: !!base.capped || merged.capped,
      __transfer: [merged.addrs.buffer, merged.kinds.buffer, merged.flags.buffer,
        ...(base.funcs && base.funcs.buffer ? [base.funcs.buffer] : [])],
    };
  };

  async function chainedSymbolEntries(slice) {
    const cmd = await findFixupsCommand(slice);
    if (!cmd || cmd.datasize <= 0 || cmd.datasize > FIXUPS_LIMIT) return [];

    const raw = await readRange(slice.offset + BigInt(cmd.dataoff), cmd.datasize);
    if (!raw || raw.length < 28) return [];
    const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);

    const fixupsVersion = u32(dv, 0);
    const startsOff = u32(dv, 4);
    const importsOff = u32(dv, 8);
    const symbolsOff = u32(dv, 12);
    const importsCount = u32(dv, 16);
    const importsFormat = u32(dv, 20);
    const symbolsFormat = u32(dv, 24);
    if (fixupsVersion !== 0 || importsCount > IMPORT_LIMIT) return [];
    if (!inRange(raw, startsOff, 4) || !inRange(raw, importsOff, 0) || !inRange(raw, symbolsOff, 0)) return [];

    const symbolPool = await loadSymbolPool(raw, symbolsOff, symbolsFormat);
    if (!symbolPool) return [];
    const imports = parseImports(raw, importsOff, importsCount, importsFormat, symbolPool);
    if (!imports || !imports.length) return [];

    const binds = await buildBindMap(slice, raw, startsOff, imports);
    if (!binds.size) return [];

    const entries = [];
    const pointerSections = pointerSectionRanges(slice.info);
    for (const [addr, name] of binds) {
      if (inAnyRange(addr, pointerSections)) entries.push({ addr, name, kind: 2, ext: 0, chained: true });
    }

    for (const s of await resolveStubs(slice, binds)) entries.push(s);
    return entries;
  }

  async function findFixupsCommand(slice) {
    const head = await readRange(slice.offset, 32);
    if (!head || head.length < 32) return null;
    const hdv = new DataView(head.buffer, head.byteOffset, head.byteLength);
    const is64 = hdv.getUint32(0, true) === 0xfeedfacf;
    if (!is64) return null;
    const ncmds = hdv.getUint32(16, true);
    const sizeofcmds = hdv.getUint32(20, true);
    if (ncmds > 10000 || sizeofcmds > HEADER_LIMIT) return null;
    const need = Math.min(32 + sizeofcmds, HEADER_LIMIT, Number(slice.size));
    const hdr = await readRange(slice.offset, need);
    if (!hdr || hdr.length < 32) return null;
    const dv = new DataView(hdr.buffer, hdr.byteOffset, hdr.byteLength);
    let off = 32;
    const end = Math.min(hdr.length, 32 + sizeofcmds);
    for (let i = 0; i < ncmds; i++) {
      if (off + 8 > end) break;
      const cmd = dv.getUint32(off, true);
      const cmdsize = dv.getUint32(off + 4, true);
      if (cmdsize < 8 || off + cmdsize > end) break;
      if (cmd === LC_DYLD_CHAINED_FIXUPS && cmdsize >= 16) {
        const dataoff = dv.getUint32(off + 8, true);
        const datasize = dv.getUint32(off + 12, true);
        if (BigInt(dataoff) + BigInt(datasize) > slice.size) return null;
        return { dataoff, datasize };
      }
      off += cmdsize;
    }
    return null;
  }

  async function loadSymbolPool(raw, symbolsOff, symbolsFormat) {
    if (symbolsOff > raw.length) return null;
    const packed = raw.subarray(symbolsOff);
    if (symbolsFormat === 0) return packed;
    /* DYLD_CHAINED_SYMBOLS_ZLIB. Safari/modern Node expose DecompressionStream. */
    if (symbolsFormat === 1 && typeof DecompressionStream === 'function' && typeof Response === 'function') {
      try {
        const stream = new Blob([packed]).stream().pipeThrough(new DecompressionStream('deflate'));
        return new Uint8Array(await new Response(stream).arrayBuffer());
      } catch { return null; }
    }
    return null;
  }

  function parseImports(raw, importsOff, count, format, pool) {
    const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    const out = new Array(count);
    let stride;
    if (format === 1) stride = 4;
    else if (format === 2) stride = 8;
    else if (format === 3) stride = 16;
    else return null;
    if (!inRange(raw, importsOff, count * stride)) return null;

    for (let i = 0; i < count; i++) {
      const p = importsOff + i * stride;
      let nameOff;
      if (format === 1 || format === 2) {
        const v = dv.getUint32(p, true);
        nameOff = v >>> 9;
      } else {
        const v = dv.getBigUint64(p, true);
        nameOff = Number((v >> 32n) & 0xffffffffn);
      }
      out[i] = poolCString(pool, nameOff);
    }
    return out;
  }

  async function buildBindMap(slice, raw, startsOff, imports) {
    const out = new Map();
    const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    if (!inRange(raw, startsOff, 4)) return out;
    const segCount = dv.getUint32(startsOff, true);
    if (segCount > 4096 || !inRange(raw, startsOff + 4, segCount * 4)) return out;
    const segments = (slice.info && slice.info.segments) || [];
    const loaded = new Map();
    let walked = 0;

    for (let si = 0; si < segCount && si < segments.length; si++) {
      const rel = dv.getUint32(startsOff + 4 + si * 4, true);
      if (!rel) continue;
      const p = startsOff + rel;
      if (!inRange(raw, p, 22)) continue;
      const pageSize = dv.getUint16(p + 4, true);
      const pointerFormat = dv.getUint16(p + 6, true);
      const pageCount = dv.getUint16(p + 20, true);
      const pageStarts = p + 22;
      if (!pageSize || pageCount > 65535 || !inRange(raw, pageStarts, pageCount * 2)) continue;

      const segment = segments[si];
      if (!segment || segment.filesize <= 0n || segment.filesize > BigInt(SEGMENT_LIMIT)) continue;
      let buf = loaded.get(si);
      if (!buf) {
        buf = await readRange(slice.offset + segment.fileoff, Number(segment.filesize));
        loaded.set(si, buf);
      }
      if (!buf || buf.length < 4) continue;
      const sdv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
      const extrasBase = pageStarts + pageCount * 2;

      for (let pi = 0; pi < pageCount; pi++) {
        const start = dv.getUint16(pageStarts + pi * 2, true);
        if (start === START_NONE) continue;
        const starts = [];
        if (start & START_MULTI) {
          let ei = start & 0x7fff;
          for (let guard = 0; guard < 65536; guard++, ei++) {
            const ep = extrasBase + ei * 2;
            if (!inRange(raw, ep, 2)) break;
            const v = dv.getUint16(ep, true);
            starts.push(v & 0x7fff);
            if (v & START_LAST) break;
          }
        } else {
          starts.push(start);
        }

        for (const withinPage of starts) {
          let segOff = pi * pageSize + withinPage;
          for (let guard = 0; guard < 1_000_000 && walked < CHAIN_GUARD; guard++, walked++) {
            const dec = decodePointer(sdv, segOff, pointerFormat);
            if (!dec) break;
            const addr = segment.vmaddr + BigInt(segOff);
            if (dec.bind && dec.ordinal < imports.length) {
              const name = imports[dec.ordinal];
              if (name) out.set(addr, name);
            }
            if (!dec.next) break;
            const advance = dec.next * dec.stride;
            if (advance <= 0) break;
            segOff += advance;
            if (segOff < 0 || segOff + dec.width > buf.length) break;
          }
        }
      }
    }
    return out;
  }

  function decodePointer(dv, off, format) {
    if (off < 0) return null;
    if (format === 2 || format === 6) {
      if (off + 8 > dv.byteLength) return null;
      const v = dv.getBigUint64(off, true);
      return {
        bind: ((v >> 63n) & 1n) !== 0n,
        ordinal: Number(v & 0xffffffn),
        next: Number((v >> 51n) & 0xfffn),
        stride: 4,
        width: 8,
      };
    }

    if (format === 1 || format === 7 || format === 9 || format === 10 || format === 12) {
      if (off + 8 > dv.byteLength) return null;
      const v = dv.getBigUint64(off, true);
      const ordinalBits = format === 12 ? 24n : 16n;
      const mask = (1n << ordinalBits) - 1n;
      return {
        bind: ((v >> 62n) & 1n) !== 0n,
        ordinal: Number(v & mask),
        next: Number((v >> 51n) & 0x7ffn),
        stride: 8,
        width: 8,
      };
    }

    if (format === 3) {
      if (off + 4 > dv.byteLength) return null;
      const v = dv.getUint32(off, true);
      return {
        bind: !!(v >>> 31),
        ordinal: v & 0xfffff,
        next: (v >>> 26) & 0x1f,
        stride: 4,
        width: 4,
      };
    }
    return null;
  }

  function pointerSectionRanges(info) {
    const out = [];
    for (const seg of (info && info.segments) || []) {
      for (const sec of seg.sections || []) {
        const n = sec.name || '';
        if (sec.pointers || /^__(?:auth_)?got$/.test(n) || /symbol_ptr$/.test(n)) {
          out.push([sec.addr, sec.addr + sec.size]);
        }
      }
    }
    return out;
  }

  async function resolveStubs(slice, binds) {
    const out = [];
    const info = slice.info;
    for (const seg of info.segments || []) {
      for (const sec of seg.sections || []) {
        if (!sec.stubs || sec.size <= 0n) continue;
        const entSize = sec.reserved2 || 12;
        if (entSize < 4 || entSize > 256 || sec.size > BigInt(32 * 1024 * 1024)) continue;
        const buf = await readRange(slice.offset + sec.offset, Number(sec.size));
        if (!buf || buf.length < entSize) continue;
        const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
        const count = Math.floor(buf.length / entSize);
        for (let i = 0; i < count; i++) {
          const startOff = i * entSize;
          const startPc = sec.addr + BigInt(startOff);
          const pageOf = new Array(32).fill(null);
          let loadedAddr = null;
          let loadedReg = -1;
          const words = Math.floor(entSize / 4);
          for (let j = 0; j < words; j++) {
            const w = dv.getUint32(startOff + j * 4, true);
            const pc = startPc + BigInt(j * 4);
            const rel = Words.pcRelTarget(w, pc);
            if (rel) {
              pageOf[rel.reg] = rel.value;
              continue;
            }
            const pair = Words.pairedOffset(w);
            if (pair && pageOf[pair.rn] != null) {
              const full = pageOf[pair.rn] + pair.imm;
              if (pair.load) {
                loadedAddr = full;
                loadedReg = pair.rd;
              } else if (!pair.store) {
                pageOf[pair.rd] = full;
              }
              continue;
            }
            const kind = Words.classifyWord(w);
            if (loadedAddr != null && kind === Words.KIND.BRANCH && !Words.isBranchImm(w)) {
              const branchReg = (w >>> 5) & 0x1f;
              if (branchReg === loadedReg) break;
            }
          }
          if (loadedAddr != null) {
            const name = binds.get(loadedAddr);
            if (name) out.push({ addr: startPc, name, kind: 1, ext: 0, chained: true });
          }
        }
      }
    }
    return out;
  }

  function mergeSymbolResult(base, extra) {
    const names = base.names ? base.names.split('\n') : [];
    const map = new Map();
    for (let i = 0; i < (base.addrs ? base.addrs.length : 0); i++) {
      map.set(base.addrs[i].toString(), {
        addr: base.addrs[i], name: names[i] || '', kind: base.kinds[i] || 0,
        ext: base.flags ? base.flags[i] : 0, chained: false,
      });
    }
    for (const e of extra) {
      if (!e || e.addr == null || !e.name) continue;
      const key = e.addr.toString();
      const old = map.get(key);
      if (!old || old.kind !== 0) map.set(key, e);
    }
    const all = Array.from(map.values());
    all.sort((a, b) => (a.addr < b.addr ? -1 : a.addr > b.addr ? 1 : a.kind - b.kind));
    const capped = false;
    const addrs = new BigUint64Array(all.length);
    const kinds = new Uint8Array(all.length);
    const flags = new Uint8Array(all.length);
    const outNames = new Array(all.length);
    for (let i = 0; i < all.length; i++) {
      addrs[i] = all[i].addr;
      kinds[i] = all[i].kind;
      flags[i] = all[i].ext ? 1 : 0;
      outNames[i] = all[i].name;
    }
    return { addrs, kinds, flags, _names: outNames, capped };
  }

  function inAnyRange(addr, ranges) {
    for (const [lo, hi] of ranges) if (addr >= lo && addr < hi) return true;
    return false;
  }

  function poolCString(pool, off) {
    if (!Number.isInteger(off) || off < 0 || off >= pool.length) return '';
    let end = off;
    const lim = Math.min(pool.length, off + 1_048_576);
    while (end < lim && pool[end] !== 0) end++;
    if (end === lim) return '';
    try { return new TextDecoder('utf-8', { fatal: false }).decode(pool.subarray(off, end)); }
    catch {
      let s = '';
      for (let i = off; i < end; i++) s += String.fromCharCode(pool[i]);
      return s;
    }
  }

  function u32(dv, off) { return off + 4 <= dv.byteLength ? dv.getUint32(off, true) : 0; }
  function inRange(buf, off, len) {
    return Number.isInteger(off) && Number.isInteger(len) && off >= 0 && len >= 0 && off <= buf.length && len <= buf.length - off;
  }
})(typeof self !== 'undefined' ? self : globalThis);
