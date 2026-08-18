'use strict';

/*
 * ARM64 memory-consumer compatibility hardening.
 *
 * Words.memoryAccess() is the canonical source of memory width/direction facts.
 * This layer is intentionally loaded after worker-fixes.js so older helpers such
 * as pairedOffset() cannot reinterpret LDPSW/exclusive/LSE encodings differently.
 */

const __ARM64_MEMORY_SCAN_BLOCK = 1024 * 1024;
const __ARM64_MEMORY_SHAPE_RMW = 32;
const __ARM64_MEMORY_SHAPE_CAP = 200_000;

function __arm64MemoryControlBoundary(w) {
  return Words.isCallImm(w) || Words.isIndirectCall(w) || Words.isBranchImm(w) ||
    Words.isCondBranch(w) || Words.isRet(w) || Words.isBr(w);
}

function __arm64MemoryWritesLowReg(w) {
  const K = Words.KIND;
  const kind = Words.classifyWord(w);
  return !new Set([
    K.NOP, K.CONDBR, K.CMP, K.BRANCH, K.CALL, K.INDCALL,
    K.RET, K.STORE, K.SYS, K.TRAP,
  ]).has(kind);
}

/*
 * Replaces the hardened xref entry point from worker-fixes.js, retaining its
 * bounded local address-materialisation rule but consulting canonical memory
 * semantics before the legacy pairedOffset helper.
 */
findXrefs = async function findXrefsArm64Memory({ regionId, target, limit, requestId, epoch }) {
  const region = regions.get(regionId);
  if (!region) throw new Error('Unknown region.');
  const want = BigInt(target);
  const cap = Math.min(Number(limit) || 2000, 2000);
  const total = Number(region.size);
  const out = [];
  const pageOf = new Array(32).fill(null);
  const pageAt = new Int32Array(32); pageAt.fill(-1);
  let index = 0, pos = 0;

  const clearPages = () => { pageOf.fill(null); pageAt.fill(-1); };
  const kill = (r) => {
    if (r == null || r < 0 || r >= 31) return;
    pageOf[r] = null; pageAt[r] = -1;
  };

  while (pos < total && out.length < cap) {
    if (cancelled(requestId)) return { results: out, cancelled: true, capped: false };
    const blk = await readRange(region.fileOffset + BigInt(pos), Math.min(__ARM64_MEMORY_SCAN_BLOCK, total - pos));
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

      if (__arm64MemoryControlBoundary(w)) {
        clearPages();
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

      const mem = Words.memoryAccess(w);
      if (mem) {
        const base = !mem.indexed && mem.disp != null && pageOf[mem.base] != null && index - pageAt[mem.base] <= 8
          ? pageOf[mem.base]
          : null;
        if (base != null) {
          const full = mem.mode === 'post' ? base : base + BigInt(mem.disp);
          if (full === want) {
            out.push({
              row: byteOff / 4,
              addr: pc,
              kind: mem.rmw ? 'rmw' : mem.load ? 'load' : 'store',
            });
            if (out.length >= cap) break;
          }
        }
        if (mem.load && !mem.vector) {
          kill(mem.resultReg != null ? mem.resultReg : mem.reg);
          if (mem.pair) kill(mem.resultReg2 != null ? mem.resultReg2 : mem.reg2);
        }
        if (mem.statusReg != null) kill(mem.statusReg);
        if (mem.mode === 'pre' || mem.mode === 'post') kill(mem.base);
        continue;
      }

      // pairedOffset is retained only for address arithmetic not represented as
      // a memory access. This prevents the old LDPSW scale from winning first.
      const pair = Words.pairedOffset(w);
      let propagated = -1;
      if (pair && !pair.load && !pair.store && pageOf[pair.rn] != null && index - pageAt[pair.rn] <= 8) {
        const full = pageOf[pair.rn] + pair.imm;
        if (full === want) {
          out.push({ row: byteOff / 4, addr: pc, kind: 'address' });
          if (out.length >= cap) break;
        }
        pageOf[pair.rd] = full;
        pageAt[pair.rd] = index;
        propagated = pair.rd;
      }

      if (__arm64MemoryWritesLowReg(w)) {
        const d = w & 31;
        if (d < 31 && d !== propagated) kill(d);
      }
    }
    pos += words * 4;
    scanProgress(requestId, epoch, pos, total, out.length);
    await yieldToQueue();
  }
  return { results: out, cancelled: false, capped: out.length >= cap };
};

/*
 * Canonical field access scanner. Atomic RMWs are intentionally emitted twice:
 * one read and one write observation sharing the same instruction address.
 */
findFieldAccess = async function findFieldAccessArm64Memory({ regionId, offset, size, limit, offsets, requestId, epoch }) {
  const region = regions.get(regionId);
  if (!region) throw new Error('Unknown region.');
  const cap = Math.min(Number(limit) || 2000, 4000);
  const total = Number(region.size);
  const wanted = new Map();
  const list = Array.isArray(offsets) && offsets.length ? offsets : [{ offset, size }];
  for (const it of list) {
    if (it == null || it.offset == null) continue;
    const want = BigInt(it.offset);
    const key = want.toString();
    if (!wanted.has(key)) wanted.set(key, { want, size: Number(it.size) || 0, out: [] });
  }
  const firstOf = () => wanted.values().next().value?.out ?? [];
  const groupsOf = () => Object.fromEntries(Array.from(wanted, ([key, slot]) => [key, slot.out]));
  if (!wanted.size) return { results: [], groups: {}, cancelled: false, capped: false };
  const allFull = () => Array.from(wanted.values()).every((slot) => slot.out.length >= cap);

  let found = 0, pos = 0;
  while (pos < total && !allFull()) {
    if (cancelled(requestId)) return { results: firstOf(), groups: groupsOf(), cancelled: true, capped: false };
    const blk = await readRange(region.fileOffset + BigInt(pos), Math.min(__ARM64_MEMORY_SCAN_BLOCK, total - pos));
    if (blk.length < 4) break;
    const words = Math.floor(blk.length / 4);
    const dv = new DataView(blk.buffer, blk.byteOffset, words * 4);
    for (let i = 0; i < words; i++) {
      const w = dv.getUint32(i * 4, true);
      const kind = Words.classifyWord(w);
      if (kind !== Words.KIND.LOAD && kind !== Words.KIND.STORE && kind !== Words.KIND.ATOMIC) continue;
      const mem = Words.memoryAccess(w);
      if (!mem || mem.disp == null || mem.indexed) continue;
      const slot = wanted.get(BigInt(mem.disp).toString());
      if (!slot || slot.out.length >= cap) continue;
      if (slot.size > 0 && mem.size !== slot.size && !(slot.size > 8 && mem.size === 8)) continue;
      const byteOff = pos + i * 4;
      const accessKinds = mem.rmw ? ['load', 'store'] : [mem.load ? 'load' : 'store'];
      for (const accessKind of accessKinds) {
        if (slot.out.length >= cap) break;
        slot.out.push({
          row: byteOff / 4,
          addr: region.vmAddr + BigInt(byteOff),
          kind: accessKind,
          base: mem.base,
          size: mem.size,
          atomic: !!mem.atomic,
          rmw: !!mem.rmw,
        });
        found++;
      }
    }
    pos += words * 4;
    scanProgress(requestId, epoch, pos, total, found);
    await yieldToQueue();
  }
  return {
    results: firstOf(), groups: groupsOf(), cancelled: false,
    capped: Array.from(wanted.values()).some((slot) => slot.out.length >= cap),
  };
};

const __arm64MemoryBaseValueShapes = scanValueShapes;

function __arm64MemoryAppendTyped(base, extra) {
  const total = base.length + extra.length;
  const out = new base.constructor(total);
  out.set(base, 0);
  out.set(extra, base.length);
  return out;
}

/*
 * Preserve the existing scalar heuristic output, then add an explicit neutral
 * atomic-mutation event for every true RMW. Pair-exclusive accesses are not RMW
 * and therefore never become fabricated scalar mutations.
 */
scanValueShapes = async function scanValueShapesArm64Memory(args) {
  const base = await __arm64MemoryBaseValueShapes(args);
  if (!base || base.cancelled) return base;
  const region = regions.get(args?.regionId);
  if (!region) return base;
  const remaining = Math.max(0, __ARM64_MEMORY_SHAPE_CAP - Number(base.count || 0));
  if (!remaining) return { ...base, capped: true };

  const events = [];
  let pos = 0;
  const totalBytes = Number(region.size);
  while (pos < totalBytes && events.length < remaining) {
    if (cancelled(args?.requestId)) return base;
    const blk = await readRange(region.fileOffset + BigInt(pos), Math.min(__ARM64_MEMORY_SCAN_BLOCK, totalBytes - pos));
    if (blk.length < 4) break;
    const words = Math.floor(blk.length / 4);
    const dv = new DataView(blk.buffer, blk.byteOffset, words * 4);
    for (let i = 0; i < words && events.length < remaining; i++) {
      const mem = Words.memoryAccess(dv.getUint32(i * 4, true));
      if (!mem?.rmw || mem.disp == null || mem.indexed) continue;
      events.push({
        addr: region.vmAddr + BigInt(pos + i * 4),
        disp: Number(mem.disp),
        size: Number(mem.size) || 0,
      });
    }
    pos += words * 4;
    await yieldToQueue();
  }
  if (!events.length) return base;

  const extraAddr = new BigUint64Array(events.map((event) => event.addr));
  const extraDisp = new Int32Array(events.map((event) => event.disp));
  const extraSize = new Uint8Array(events.map((event) => event.size));
  const extraFlags = new Uint8Array(events.length); extraFlags.fill(__ARM64_MEMORY_SHAPE_RMW);
  const extraAmtKind = new Uint8Array(events.length);
  const extraAmtDisp = new Int32Array(events.length);
  const extraSpan = new Int32Array(events.length);
  const extraAmtSize = new Uint8Array(events.length);
  const extraAmtSpan = new Int32Array(events.length);

  const addr = __arm64MemoryAppendTyped(base.addr, extraAddr);
  const disp = __arm64MemoryAppendTyped(base.disp, extraDisp);
  const size = __arm64MemoryAppendTyped(base.size, extraSize);
  const flags = __arm64MemoryAppendTyped(base.flags, extraFlags);
  const amtKind = __arm64MemoryAppendTyped(base.amtKind, extraAmtKind);
  const amtDisp = __arm64MemoryAppendTyped(base.amtDisp, extraAmtDisp);
  const span = __arm64MemoryAppendTyped(base.span, extraSpan);
  const amtSize = __arm64MemoryAppendTyped(base.amtSize, extraAmtSize);
  const amtSpan = __arm64MemoryAppendTyped(base.amtSpan, extraAmtSpan);
  return {
    ...base,
    count: addr.length,
    capped: !!base.capped || events.length >= remaining,
    addr, disp, size, flags, amtKind, amtDisp, span, amtSize, amtSpan,
    __transfer: [addr.buffer, disp.buffer, size.buffer, flags.buffer,
      amtKind.buffer, amtDisp.buffer, span.buffer, amtSize.buffer, amtSpan.buffer],
  };
};
