/* Bounded, lazy Objective-C stub recovery for the classic worker. */
(function installObjCStubRecovery(root) {
  async function recover(options) {
    const {
      slice, known, readRange, cancelled, requestId, fileSize, Words, budget,
      sanitizePointer, maxSelector = 240, maxStubs = 80_000, maxSectionBytes = 8 * 1024 * 1024,
    } = options || {};
    if (!slice || !readRange || !Words || !budget) return [];
    const regs = slice.regions || [];
    const sliceStart = BigInt(slice.offset ?? 0);
    const totalFileSize = BigInt(fileSize ?? 0);
    const sliceSize = BigInt(slice.size ?? (totalFileSize - sliceStart));
    const sliceEnd = sliceStart + sliceSize;

    const validRegion = (r) => {
      if (!r || r.size == null || r.fileOffset == null || r.vmAddr == null) return false;
      const size = BigInt(r.size), off = BigInt(r.fileOffset);
      return size > 0n && off >= sliceStart && off <= sliceEnd && size <= sliceEnd - off &&
        off <= totalFileSize && size <= totalFileSize - off;
    };
    const dedupe = (list) => {
      const seen = new Set(), out = [];
      for (const r of list) {
        if (!validRegion(r)) continue;
        const key = `${r.fileOffset}:${r.size}:${r.vmAddr}:${r.section || ''}`;
        if (seen.has(key) || !budget.takeRegion()) continue;
        seen.add(key); out.push(r);
      }
      return out;
    };

    const stubs = dedupe(regs.filter((r) => r.section === '__objc_stubs'))[0];
    if (!stubs || BigInt(stubs.size) > BigInt(maxSectionBytes)) return [];
    const pointerRegions = dedupe(regs.filter((r) => /^__objc_(selrefs|superrefs|classrefs)$/.test(r.section || '')));
    const textRegions = dedupe(regs.filter((r) => r.cstrings || /^__objc_(methname|classname)$/.test(r.section || '')));
    if (!pointerRegions.length || !textRegions.length) return [];

    const PAGE = 64 * 1024, MAX_PAGES = 8;
    const pages = new Map();
    const isCancelled = () => cancelled?.(requestId) || budget.expired();
    const pageFor = async (r, addr) => {
      if (isCancelled()) return null;
      const rel = BigInt(addr) - BigInt(r.vmAddr);
      if (rel < 0n || rel >= BigInt(r.size)) return null;
      const pageRel = (rel / BigInt(PAGE)) * BigInt(PAGE);
      const key = `${r.fileOffset}:${pageRel}`;
      let cached = pages.get(key);
      if (cached) {
        pages.delete(key); pages.set(key, cached);
        return { bytes:cached, offset:Number(rel - pageRel) };
      }
      const remain = BigInt(r.size) - pageRel;
      const len = Number(remain < BigInt(PAGE) ? remain : BigInt(PAGE));
      if (!budget.takeRead(len) || !budget.takeResident(len)) return null;
      const chunk = await readRange(BigInt(r.fileOffset) + pageRel, len);
      if (isCancelled()) { budget.releaseResident(chunk?.length || 0); return null; }
      pages.set(key, chunk);
      while (pages.size > MAX_PAGES) {
        const oldest = pages.keys().next().value, evicted = pages.get(oldest);
        pages.delete(oldest); budget.releaseResident(evicted?.length || 0);
      }
      return { bytes:chunk, offset:Number(rel - pageRel) };
    };

    const slotOf = async (addr) => {
      for (const r of pointerRegions) {
        const vm = BigInt(r.vmAddr), end = vm + BigInt(r.size);
        if (addr < vm || addr + 8n > end) continue;
        const p = await pageFor(r, addr);
        if (!p || p.offset + 8 > p.bytes.length) return null;
        let v = 0n;
        for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(p.bytes[p.offset + i]);
        return v;
      }
      return null;
    };

    const textAt = async (addr) => {
      for (const r of textRegions) {
        const vm = BigInt(r.vmAddr), end = vm + BigInt(r.size);
        if (addr < vm || addr >= end) continue;
        let cur = BigInt(addr), out = '';
        while (cur < end && out.length < maxSelector) {
          if (!budget.takeOperation()) return null;
          const p = await pageFor(r, cur);
          if (!p) return null;
          while (p.offset < p.bytes.length && cur < end && out.length < maxSelector) {
            const ch = p.bytes[p.offset++];
            if (ch === 0) return out || null;
            if (!budget.takeString(1)) return null;
            out += String.fromCharCode(ch); cur++;
          }
        }
        return out || null;
      }
      return null;
    };

    const gotName = new Map();
    for (const e of known || []) if (e.kind === 2 && e.addr != null) gotName.set(e.addr.toString(), e.name);
    const imageBase = slice.info?.textVM ?? null;
    const out = [], pageOf = new Array(32).fill(null);
    let start = null, selref = null, target = null;
    const SCAN = 256 * 1024;
    let relBase = 0n;

    while (relBase < BigInt(stubs.size) && out.length < maxStubs) {
      if (isCancelled()) break;
      const remain = BigInt(stubs.size) - relBase;
      const len = Number(remain < BigInt(SCAN) ? remain : BigInt(SCAN));
      if (!budget.takeRead(len)) break;
      const code = await readRange(BigInt(stubs.fileOffset) + relBase, len);
      const words = Math.floor(code.length / 4);
      const dv = new DataView(code.buffer, code.byteOffset, words * 4);
      for (let i = 0; i < words && out.length < maxStubs; i++) {
        if (!budget.takeOperation() || isCancelled()) break;
        const w = dv.getUint32(i * 4, true);
        const pc = BigInt(stubs.vmAddr) + relBase + BigInt(i * 4);
        const rel = Words.pcRelTarget(w, pc);
        if (rel) {
          if (start === null) start = pc;
          pageOf[rel.reg] = rel.value;
          continue;
        }
        const pair = Words.pairedOffset(w);
        if (pair && pair.load && pageOf[pair.rn] != null) {
          const at = pageOf[pair.rn] + pair.imm;
          if (pair.rd === 1) selref = at; else target = at;
          pageOf[pair.rd] = null;
          continue;
        }
        const kind = Words.classifyWord(w);
        if (kind === Words.KIND.BRANCH || kind === Words.KIND.RET) {
          if (start !== null && selref != null) {
            const p = sanitizePointer(await slotOf(selref), imageBase);
            const sel = p == null ? null : await textAt(p);
            if (sel && budget.takeName()) {
              const via = target == null ? null : gotName.get(target.toString());
              const send = via && /msgSend/.test(via) ? via.replace(/^_/, '') : 'objc_msgSend';
              out.push({ addr:start, name:'_' + send + '$' + sel });
            }
          }
          start = null; selref = null; target = null; pageOf.fill(null);
        }
      }
      if (!code.length) break;
      relBase += BigInt(code.length);
    }
    return out;
  }

  root.HexObjCStubRecovery = Object.freeze({ recover });
})(globalThis);
