'use strict';

/*
 * Canonical memory-aware xref hardening.
 *
 * worker-fixes.js replaces findXrefs with its hardened CFG-boundary scanner,
 * but that implementation historically only consumed Words.pairedOffset().
 * Pair/exclusive/LSE instructions are decoded by Words.memoryAccess(), so the
 * hardened scanner could miss references that scanProgram/fieldAccess proved.
 * Keep the same conservative provenance policy while making memoryAccess the
 * authoritative memory decoder; pairedOffset remains only the legacy
 * address-materialization fallback.
 */
findXrefs = async function findXrefsCanonicalMemory({ regionId, target, limit, requestId, epoch }) {
  const region = regions.get(regionId);
  if (!region) throw new Error('Unknown region.');
  const want = BigInt(target);
  const cap = Math.min(Number(limit) || XREF_LIMIT, XREF_LIMIT);
  const total = Number(region.size);
  const out = [];
  const provenance = AddressProvenance.create({
    words: Words,
    pairWindow: PAIR_WINDOW,
    functionStarts: functionStartsForRegion(region),
    rangeStart: region.vmAddr,
    rangeEnd: region.vmAddr + region.size,
  });
  let index = 0;
  let pos = 0;

  while (pos < total && out.length < cap) {
    if (cancelled(requestId)) return { results: out, cancelled: true, capped: false };
    const blk = await readRange(region.fileOffset + BigInt(pos), Math.min(SCAN_BLOCK, total - pos));
    if (blk.length < 4) break;
    const words = Math.floor(blk.length / 4);
    const dv = new DataView(blk.buffer, blk.byteOffset, words * 4);

    for (let i = 0; i < words; i++, index++) {
      const w = dv.getUint32(i * 4, true);
      const byteOff = pos + i * 4;
      const pc = region.vmAddr + BigInt(byteOff);
      provenance.enter(pc);

      const direct = Words.wordTarget(w, pc);
      if (direct != null && direct === want) {
        out.push({ row: byteOff / 4, addr: pc, kind: 'branch' });
        if (out.length >= cap) break;
      }

      const kind = Words.classifyWord(w);
      if (kind === Words.KIND.CALL || kind === Words.KIND.INDCALL ||
          kind === Words.KIND.CONDBR || kind === Words.KIND.BRANCH ||
          kind === Words.KIND.RET || kind === Words.KIND.TRAP) {
        provenance.control(w, pc, kind);
        continue;
      }

      const rel = Words.pcRelTarget(w, pc);
      if (rel) {
        provenance.note(rel.reg, rel.value, index);
        if (!rel.page && rel.value === want) {
          out.push({ row: byteOff / 4, addr: pc, kind: 'address' });
          if (out.length >= cap) break;
        }
        continue;
      }

      // Canonical memory facts come first. This covers pair loads/stores,
      // exclusives and LSE RMW operations as well as ordinary scalar accesses.
      const mem = Words.memoryAccess(w);
      if (mem) {
        const knownBase = !mem.indexed && mem.disp != null ? provenance.base(mem.base, index) : null;
        if (knownBase != null) {
          const full = mem.mode === 'post' ? knownBase : knownBase + mem.disp;
          if (full === want) {
            out.push({ row: byteOff / 4, addr: pc, kind: mem.rmw ? 'rmw' : mem.load ? 'load' : 'store' });
            if (out.length >= cap) break;
          }
        }
        if (mem.load && !mem.vector) {
          provenance.kill(mem.reg);
          if (mem.pair && mem.reg2 != null) provenance.kill(mem.reg2);
        }
        if (mem.statusReg != null) provenance.kill(mem.statusReg);
        if (mem.mode === 'pre' || mem.mode === 'post') provenance.kill(mem.base);
        continue;
      }

      // Legacy ADRP+ADD address materialization still needs pairedOffset().
      const pair = Words.pairedOffset(w);
      const base = pair ? provenance.base(pair.rn, index) : null;
      if (pair && base != null) {
        const full = base + pair.imm;
        if (full === want) {
          out.push({ row: byteOff / 4, addr: pc, kind: pair.load ? 'load' : pair.store ? 'store' : 'address' });
          if (out.length >= cap) break;
        }
        if (!pair.load && !pair.store) provenance.note(pair.rd, full, index);
        else if (pair.load && pair.gpDest !== false) provenance.kill(pair.rd);
        continue;
      }

      if (kind === Words.KIND.FARITH || kind === Words.KIND.FMUL || kind === Words.KIND.SIMD ||
          (kind === Words.KIND.CSEL && Words.isFpCondSelect?.(w))) continue;
      if (WRITES_LOW_REG[kind]) provenance.kill(w & 0x1f);
    }

    pos += words * 4;
    scanProgress(requestId, epoch, pos, total, out.length);
    await yieldToQueue();
  }
  return { results: out, cancelled: false, capped: out.length >= cap };
};
