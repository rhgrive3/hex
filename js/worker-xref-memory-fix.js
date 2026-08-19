'use strict';

/*
 * Add the memory forms from issues #814-#816 without replacing the hardened
 * xref scanner installed by worker-fixes.js.  The control boundaries,
 * ADR/ADRP provenance window, register invalidation and existing pairedOffset
 * path below intentionally remain byte-for-byte equivalent to that scanner;
 * memoryAccess() only contributes additional proven memory hits.  This keeps
 * the existing cross-binary xref set monotonic while covering pair/exclusive/
 * LSE operands that pairedOffset() cannot describe.
 */
findXrefs = async function findXrefsCanonicalMemory({ regionId, target, limit, requestId, epoch }) {
  const region = regions.get(regionId);
  if (!region) throw new Error('Unknown region.');
  const want = BigInt(target);
  const cap = Math.min(Number(limit) || 2000, 2000);
  const total = Number(region.size);
  const out = [];
  const pageOf = new Array(32).fill(null);
  const pageAt = new Int32Array(32); pageAt.fill(-1);
  let index = 0, pos = 0;

  const pushHit = (byteOff, pc, kind) => {
    out.push({ row:byteOff / 4, addr:pc, kind });
    return out.length >= cap;
  };

  while (pos < total && out.length < cap) {
    if (cancelled(requestId)) return { results:out, cancelled:true, capped:false };
    const blk = await readRange(region.fileOffset + BigInt(pos), Math.min(1024 * 1024, total - pos));
    if (blk.length < 4) break;
    const words = Math.floor(blk.length / 4);
    const dv = new DataView(blk.buffer, blk.byteOffset, words * 4);

    for (let i = 0; i < words; i++, index++) {
      const w = dv.getUint32(i * 4, true);
      const byteOff = pos + i * 4;
      const pc = region.vmAddr + BigInt(byteOff);
      const direct = Words.wordTarget(w, pc);
      if (direct != null && direct === want && pushHit(byteOff, pc, 'branch')) break;

      /* Preserve worker-fixes.js control-boundary semantics exactly. */
      if (__controlBoundary(w)) {
        __clearPages(pageOf, pageAt);
        continue;
      }

      const rel = Words.pcRelTarget(w, pc);
      if (rel) {
        pageOf[rel.reg] = rel.value;
        pageAt[rel.reg] = index;
        if (!rel.page && rel.value === want && pushHit(byteOff, pc, 'address')) break;
        continue;
      }

      /* Preserve the pre-existing ADRP+ADD/ordinary unsigned-offset route. */
      const pair = Words.pairedOffset(w);
      let propagated = -1;
      if (pair && pageOf[pair.rn] != null && index - pageAt[pair.rn] <= 8) {
        const full = pageOf[pair.rn] + pair.imm;
        if (full === want && pushHit(byteOff, pc, pair.load ? 'load' : pair.store ? 'store' : 'address')) break;
        if (!pair.load && !pair.store) {
          pageOf[pair.rd] = full;
          pageAt[pair.rd] = index;
          propagated = pair.rd;
        } else if (pair.load && pair.rd < 31) {
          pageOf[pair.rd] = null;
          pageAt[pair.rd] = -1;
        }
      }

      /*
       * memoryAccess is supplemental only.  If pairedOffset already describes
       * the same ordinary scalar access, it remains authoritative above.  The
       * new route therefore cannot delete an existing xref; it only surfaces
       * memory shapes pairedOffset cannot represent.
       */
      const mem = Words.memoryAccess(w);
      if (mem && !pair && !mem.indexed && mem.disp != null &&
          pageOf[mem.base] != null && index - pageAt[mem.base] <= 8) {
        const first = mem.mode === 'post' ? pageOf[mem.base] : pageOf[mem.base] + mem.disp;
        const hitKind = mem.rmw ? 'rmw' : mem.load ? 'load' : 'store';
        if (first === want && pushHit(byteOff, pc, hitKind)) break;

        // LDP/STP/LDPSW transfer the second element at the next element-size
        // address.  size is the whole pair; elementSize is decoder-authoritative.
        if (mem.pair && Number.isSafeInteger(mem.elementSize) && mem.elementSize > 0) {
          const second = first + BigInt(mem.elementSize);
          if (second === want && pushHit(byteOff, pc, hitKind)) break;
        }
      }

      /* Preserve the original register-provenance invalidation contract. */
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
  return { results:out, cancelled:false, capped:out.length >= cap };
};
