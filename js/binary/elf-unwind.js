import { functionSeed } from './model.js';

function warn(image, message) {
  if (Array.isArray(image?.warnings)) image.warnings.push(`.eh_frame_hdr: ${message}`);
}

function sectionName(sec) {
  return String(sec?.name || sec?.sectionName || '');
}

function sectionReadable(r, sec) {
  if (!sec || sec.offset == null || sec.size == null) return false;
  const start = BigInt(sec.offset);
  const size = BigInt(sec.size);
  return start >= 0n && size > 0n && start <= BigInt(r.length) && size <= BigInt(r.length) - start;
}

function sameSection(a, b) {
  return !!a && !!b && BigInt(a.addr ?? a.address ?? -1n) === BigInt(b.addr ?? b.address ?? -2n)
    && BigInt(a.offset ?? -1n) === BigInt(b.offset ?? -2n)
    && BigInt(a.size ?? -1n) === BigInt(b.size ?? -2n);
}

function ehFrameSectionAt(r, image, address) {
  const sec = typeof image?.sectionAt === 'function' ? image.sectionAt(address) : null;
  if (!sec || sectionName(sec) !== '.eh_frame' || !sectionReadable(r, sec)) return null;
  const start = BigInt(sec.addr ?? sec.address ?? 0n);
  const size = BigInt(sec.size);
  const value = BigInt(address);
  return value >= start && value < start + size ? sec : null;
}

function executableAt(image, address) {
  const sec = typeof image?.sectionAt === 'function' ? image.sectionAt(address) : null;
  if (sec?.perms?.execute) return true;
  const seg = typeof image?.segmentAt === 'function' ? image.segmentAt(address) : null;
  return !!seg?.perms?.execute;
}

function sameExecutableRange(image, start, range) {
  const begin = BigInt(start);
  const size = BigInt(range);
  if (size <= 0n) return false;
  const last = begin + size - 1n;
  if (last < begin || !executableAt(image, begin) || !executableAt(image, last)) return false;
  const aSec = typeof image?.sectionAt === 'function' ? image.sectionAt(begin) : null;
  const bSec = typeof image?.sectionAt === 'function' ? image.sectionAt(last) : null;
  if (aSec?.perms?.execute && bSec?.perms?.execute && sameSection(aSec, bSec)) return true;
  const aSeg = typeof image?.segmentAt === 'function' ? image.segmentAt(begin) : null;
  const bSeg = typeof image?.segmentAt === 'function' ? image.segmentAt(last) : null;
  return !!aSeg?.perms?.execute && !!bSeg?.perms?.execute
    && BigInt(aSeg.address ?? aSeg.addr ?? -1n) === BigInt(bSeg.address ?? bSeg.addr ?? -2n)
    && BigInt(aSeg.size ?? -1n) === BigInt(bSeg.size ?? -2n);
}

function requiredInstructionAlignment(image) {
  const arch = String(image?.architecture || image?.arch || '').toLowerCase();
  if (arch === 'arm64' || arch === 'aarch64') return 4n;
  if (arch.includes('riscv')) return 2n;
  if (arch === 'arm' || arch === 'thumb') return 2n;
  return 1n;
}

function sectionContext(sec, image, bits) {
  return {
    secAddress: BigInt(sec.addr ?? sec.address ?? 0n),
    secOffset: Number(sec.offset),
    textBase: (image.segments.find((s) => s.perms.execute) || image.segments[0] || { address: 0n }).address,
    image,
    bits,
    functionBase: null,
  };
}

function recordHeader(r, image, sec, address) {
  const addressValue = BigInt(address);
  const offBig = image.addressToOffset(addressValue);
  if (offBig == null || offBig < BigInt(sec.offset) || offBig >= BigInt(sec.offset) + BigInt(sec.size))
    throw new Error(`FDE/CIE address 0x${addressValue.toString(16)} is not file-backed by .eh_frame`);
  if (offBig > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('FDE/CIE file offset exceeds safe integer range');
  const offset = Number(offBig);
  if (offset + 4 > r.length) throw new Error('truncated FDE/CIE initial length');
  const initialLength = r.u32(offset);
  if (initialLength === 0) throw new Error('zero-length FDE/CIE record');
  let payload = offset + 4;
  let length = BigInt(initialLength);
  let idBytes = 4;
  if (initialLength === 0xffffffff) {
    if (offset + 12 > r.length) throw new Error('truncated DWARF64 FDE/CIE initial length');
    length = r.u64(offset + 4);
    payload = offset + 12;
    idBytes = 8;
  }
  if (length < BigInt(idBytes)) throw new Error('FDE/CIE record is shorter than its id field');
  if (length > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('FDE/CIE record is too large');
  const endBig = BigInt(payload) + length;
  const secEnd = BigInt(sec.offset) + BigInt(sec.size);
  if (endBig > BigInt(r.length) || endBig > secEnd) throw new Error('FDE/CIE record crosses .eh_frame boundary');
  return { offset, payload, end:Number(endBig), idBytes };
}

function readCStringBounded(r, p0, end) {
  let p = p0;
  let value = '';
  while (p < end) {
    const ch = r.u8(p++);
    if (ch === 0) return { value, next:p };
    if (ch < 0x20 || ch > 0x7e) throw new Error('non-ASCII CIE augmentation string');
    if (value.length >= 256) throw new Error('CIE augmentation string is too long');
    value += String.fromCharCode(ch);
  }
  throw new Error('unterminated CIE augmentation string');
}

function parseCie(r, image, sec, address, bits) {
  const header = recordHeader(r, image, sec, address);
  let p = header.payload;
  const cieId = header.idBytes === 8 ? r.u64(p) : BigInt(r.u32(p));
  p += header.idBytes;
  if (cieId !== 0n) throw new Error('referenced record is not an .eh_frame CIE');
  if (p >= header.end) throw new Error('truncated CIE version');
  const version = r.u8(p++);
  if (![1,3,4].includes(version)) throw new Error(`unsupported CIE version ${version}`);
  const augmentationX = readCStringBounded(r, p, header.end); p = augmentationX.next;
  const augmentation = augmentationX.value;
  const codeAlign = r.uleb(p, 10, header.end); p = codeAlign.next;
  const dataAlign = r.sleb(p, 10, header.end); p = dataAlign.next;
  if (version === 1) {
    if (p >= header.end) throw new Error('truncated CIE return-address register');
    p++;
  } else {
    const returnReg = r.uleb(p, 10, header.end); p = returnReg.next;
  }
  let fdeEncoding = 0x00;
  let hasAugmentationData = false;
  if (augmentation.startsWith('z')) {
    hasAugmentationData = true;
    const augLength = r.uleb(p, 10, header.end); p = augLength.next;
    if (augLength.value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('CIE augmentation data is too large');
    const augEnd = p + Number(augLength.value);
    if (augEnd > header.end) throw new Error('CIE augmentation data crosses record boundary');
    const ctx = sectionContext(sec, image, bits);
    for (const ch of augmentation.slice(1)) {
      if (ch === 'L') {
        if (p >= augEnd) throw new Error('truncated CIE LSDA encoding');
        p++;
      } else if (ch === 'R') {
        if (p >= augEnd) throw new Error('truncated CIE FDE encoding');
        fdeEncoding = r.u8(p++);
      } else if (ch === 'P') {
        if (p >= augEnd) throw new Error('truncated CIE personality encoding');
        const enc = r.u8(p++);
        const personality = decodeEhValue(r, p, enc, ctx, augEnd);
        p = personality.next;
      } else if (ch === 'S') {
        // Signal-frame marker carries no augmentation payload.
      } else {
        throw new Error(`unsupported CIE augmentation '${ch}'`);
      }
    }
    if (p > augEnd) throw new Error('CIE augmentation parser crossed its declared length');
  } else if (augmentation.length !== 0) {
    throw new Error(`unsupported non-z CIE augmentation '${augmentation}'`);
  }
  return { version, augmentation, fdeEncoding, hasAugmentationData };
}

function parseFde(r, image, sec, fdeAddress, bits) {
  const header = recordHeader(r, image, sec, fdeAddress);
  let p = header.payload;
  const cieDelta = header.idBytes === 8 ? r.u64(p) : BigInt(r.u32(p));
  if (cieDelta === 0n) throw new Error('table FDE pointer references a CIE');
  const pointerFieldAddress = BigInt(sec.addr ?? sec.address ?? 0n) + BigInt(p - Number(sec.offset));
  if (cieDelta > pointerFieldAddress) throw new Error('FDE CIE pointer underflows address space');
  const cieAddress = pointerFieldAddress - cieDelta;
  p += header.idBytes;
  const cie = parseCie(r, image, sec, cieAddress, bits);
  const ctx = sectionContext(sec, image, bits);
  const initial = decodeEhValue(r, p, cie.fdeEncoding, ctx, header.end); p = initial.next;
  const rangeEncoding = cie.fdeEncoding & 0x0f;
  const range = decodeEhValue(r, p, rangeEncoding, ctx, header.end); p = range.next;
  if (cie.hasAugmentationData) {
    const augLength = r.uleb(p, 10, header.end); p = augLength.next;
    if (augLength.value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('FDE augmentation data is too large');
    const augEnd = p + Number(augLength.value);
    if (augEnd > header.end) throw new Error('FDE augmentation data crosses record boundary');
  }
  return { initial:initial.value, range:range.value, cieAddress, fdeEncoding:cie.fdeEncoding };
}

export function parseEhFrameHeader(r, sec, image, bits, budget = null) {
  if (sec.size < 4n || sec.offset + sec.size > BigInt(r.length)) return;
  let p = Number(sec.offset);
  const end = Number(sec.offset + sec.size);
  const version = r.u8(p++);
  const ehFrameEnc = r.u8(p++);
  const countEnc = r.u8(p++);
  const tableEnc = r.u8(p++);
  if (version !== 1 || tableEnc === 0xff) return;
  const ctx = {
    secAddress: sec.addr,
    secOffset: Number(sec.offset),
    textBase: (image.segments.find((s) => s.perms.execute) || image.segments[0] || { address: 0n }).address,
    image,
    bits,
    functionBase: null,
  };
  try {
    const frame = decodeEhValue(r, p, ehFrameEnc, ctx, end); p = frame.next;
    const countX = decodeEhValue(r, p, countEnc, ctx, end); p = countX.next;
    const count = Number(countX.raw);
    if (!Number.isSafeInteger(count) || count < 0 || count > 10_000_000) return;
    const frameSec = frame.value == null ? null : ehFrameSectionAt(r, image, frame.value);
    if (!frameSec) {
      image.metadata.ehFrameHeader = {
        version, ehFrameEnc, countEnc, tableEnc, declaredFunctions:count, recoveredFunctions:0,
        validatedEntries:0, invalidEntries:count, tableSorted:false, validation:'invalid',
      };
      warn(image, 'eh_frame_ptr does not resolve to readable .eh_frame data; function seeds suppressed');
      return;
    }

    const candidates = [];
    let invalidEntries = 0;
    let previousInitial = null;
    let tableSorted = true;
    for (let i = 0; i < count && p < end; i++) {
      if (budget && !budget.take({ records:1, operations:4, inputBytes:2, estimatedHeapBytes:64 }, 'eh-frame-table')) break;
      const initial = decodeEhValue(r, p, tableEnc, ctx, end); p = initial.next;
      const fde = decodeEhValue(r, p, tableEnc, ctx, end); p = fde.next;
      if (initial.value == null || initial.value === 0n || fde.value == null || fde.value === 0n) {
        invalidEntries++;
        continue;
      }
      if (previousInitial != null && initial.value <= previousInitial) tableSorted = false;
      previousInitial = initial.value;
      try {
        const fdeSec = ehFrameSectionAt(r, image, fde.value);
        if (!fdeSec || !sameSection(frameSec, fdeSec)) throw new Error('FDE pointer is outside authoritative .eh_frame domain');
        const decoded = parseFde(r, image, fdeSec, fde.value, bits);
        if (decoded.initial !== initial.value) throw new Error('table initial location does not match decoded FDE initial location');
        if (decoded.range == null || decoded.range <= 0n) throw new Error('FDE address range is empty or invalid');
        if (!sameExecutableRange(image, decoded.initial, decoded.range)) throw new Error('FDE range is not contained in executable mapping');
        const alignment = requiredInstructionAlignment(image);
        if (alignment > 1n && decoded.initial % alignment !== 0n) throw new Error('FDE initial location violates target instruction alignment');
        candidates.push({ address:decoded.initial, fdeAddress:fde.value });
      } catch (entryError) {
        invalidEntries++;
        warn(image, `entry ${i} rejected: ${entryError.message}`);
      }
    }

    let added = 0;
    if (!tableSorted) {
      warn(image, 'binary-search table is not strictly increasing; all header-derived function seeds suppressed');
    } else {
      const seen = new Set();
      for (const candidate of candidates) {
        const key = candidate.address.toString();
        if (seen.has(key)) continue;
        if (budget && !budget.take({ objects:1, operations:1, estimatedHeapBytes:128 }, 'eh-frame-function')) break;
        image.functions.push(functionSeed(candidate.address, {
          source:'unwind', confidence:0.985,
          evidence:{ kind:'eh-frame-fde', fdeAddress:candidate.fdeAddress },
        }));
        seen.add(key);
        added++;
      }
    }
    image.metadata.ehFrameHeader = {
      version, ehFrameEnc, countEnc, tableEnc, declaredFunctions:count, recoveredFunctions:added,
      validatedEntries:candidates.length, invalidEntries, tableSorted,
      validation:tableSorted && invalidEntries === 0 && candidates.length === count ? 'verified' : 'partial',
      ehFrameAddress:frame.value,
    };
  } catch (e) {
    if (e?.code === 'BINARY_SOURCE_RANGE_MISSING') throw e;
    warn(image, e.message);
  }
}

function decodeEhValue(r, p0, enc, ctx, end = r.length) {
  if (enc === 0xff) return { value: null, raw: 0n, next: p0 };
  const format = enc & 0x0f;
  const application = enc & 0x70;
  const indirect = !!(enc & 0x80);
  const ptrBytes = ctx.bits === 64 ? 8 : 4;
  let p = p0;
  if (application === 0x50) p = Math.ceil(p / ptrBytes) * ptrBytes;
  const requireSpan = (n) => {
    if (!Number.isSafeInteger(p) || !Number.isSafeInteger(end) || p < 0 || n < 0 || p > end || n > end - p)
      throw new Error('DW_EH_PE value crosses .eh_frame_hdr boundary');
  };
  let raw, next;
  if (format === 0x00) { requireSpan(ptrBytes); raw = ctx.bits === 64 ? r.u64(p) : BigInt(r.u32(p)); next = p + ptrBytes; }
  else if (format === 0x01) { const x = r.uleb(p, 10, end); raw = x.value; next = x.next; }
  else if (format === 0x02) { requireSpan(2); raw = BigInt(r.u16(p)); next = p + 2; }
  else if (format === 0x03) { requireSpan(4); raw = BigInt(r.u32(p)); next = p + 4; }
  else if (format === 0x04) { requireSpan(8); raw = r.u64(p); next = p + 8; }
  else if (format === 0x09) { const x = r.sleb(p, 10, end); raw = x.value; next = x.next; }
  else if (format === 0x0a) { requireSpan(2); raw = BigInt(r.i16(p)); next = p + 2; }
  else if (format === 0x0b) { requireSpan(4); raw = BigInt(r.i32(p)); next = p + 4; }
  else if (format === 0x0c) { requireSpan(8); raw = r.i64(p); next = p + 8; }
  else throw new Error(`unsupported DW_EH_PE format 0x${format.toString(16)}`);
  let value = raw;
  const fieldAddress = ctx.secAddress + BigInt(p - ctx.secOffset);
  if (application === 0x10) value += fieldAddress;
  else if (application === 0x20) value += ctx.textBase;
  else if (application === 0x30) value += ctx.secAddress;
  else if (application === 0x40) {
    if (ctx.functionBase == null) throw new Error('DW_EH_PE_funcrel requires a function base');
    value += ctx.functionBase;
  }
  else if (application !== 0 && application !== 0x50) throw new Error(`unsupported DW_EH_PE application 0x${application.toString(16)}`);
  if (indirect) {
    const off = ctx.image.addressToOffset(value);
    if (off == null || off + BigInt(ptrBytes) > BigInt(r.length)) throw new Error(`DW_EH_PE_indirect target 0x${value.toString(16)} is not readable`);
    value = ctx.bits === 64 ? r.u64(Number(off)) : BigInt(r.u32(Number(off)));
  }
  return { value, raw, next };
}
