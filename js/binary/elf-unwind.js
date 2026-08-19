import { functionSeed } from './model.js';

const DW_EH_PE_OMIT = 0xff;
const MAX_EH_RECORDS = 10_000_000;

function warn(image, message) {
  if (Array.isArray(image?.warnings)) image.warnings.push(`.eh_frame_hdr: ${message}`);
}

function sectionName(sec) {
  return String(sec?.name || sec?.sectionName || '');
}

function sectionAddress(sec) {
  return BigInt(sec?.addr ?? sec?.address ?? 0n);
}

function sectionOffset(sec) {
  const value = sec?.offset ?? sec?.fileOffset;
  return value == null ? null : BigInt(value);
}

function sectionFileSize(sec) {
  return BigInt(sec?.fileSize ?? sec?.size ?? 0n);
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
  if (aSec?.perms?.execute && bSec?.perms?.execute && aSec === bSec) return true;
  if (aSec?.perms?.execute && bSec?.perms?.execute
    && sectionAddress(aSec) === sectionAddress(bSec)
    && BigInt(aSec.size ?? -1n) === BigInt(bSec.size ?? -2n)) return true;
  const aSeg = typeof image?.segmentAt === 'function' ? image.segmentAt(begin) : null;
  const bSeg = typeof image?.segmentAt === 'function' ? image.segmentAt(last) : null;
  return !!aSeg?.perms?.execute && !!bSeg?.perms?.execute
    && BigInt(aSeg.address ?? aSeg.addr ?? -1n) === BigInt(bSeg.address ?? bSeg.addr ?? -2n)
    && BigInt(aSeg.size ?? -1n) === BigInt(bSeg.size ?? -2n);
}

function instructionAlignment(image) {
  const arch = String(image?.architecture || image?.arch || '').toLowerCase();
  if (arch === 'arm64' || arch === 'aarch64') return 4n;
  if (arch.includes('riscv')) return 2n;
  if (arch === 'arm' || arch === 'thumb') return 2n;
  return 1n;
}

function makeDomain(address, fileOffset, fileSize, kind) {
  return {
    address:BigInt(address),
    fileOffset:BigInt(fileOffset),
    fileSize:BigInt(fileSize),
    kind,
  };
}

function resolveEhFrameDomain(r, image, address) {
  if (address == null) return null;
  const value = BigInt(address);
  const sec = typeof image?.sectionAt === 'function' ? image.sectionAt(value) : null;
  if (sec && sectionName(sec) === '.eh_frame') {
    const fileOffset = sectionOffset(sec);
    const fileSize = sectionFileSize(sec);
    if (fileOffset != null && fileSize > 0n && fileOffset <= BigInt(r.length) && fileSize <= BigInt(r.length) - fileOffset)
      return makeDomain(sectionAddress(sec), fileOffset, fileSize, 'section');
  }

  const seg = typeof image?.segmentAt === 'function' ? image.segmentAt(value) : null;
  if (!seg) return null;
  const segAddress = BigInt(seg.address ?? seg.addr ?? 0n);
  const segFileOffset = BigInt(seg.fileOffset ?? seg.offset ?? 0n);
  const segFileSize = BigInt(seg.fileSize ?? 0n);
  const delta = value - segAddress;
  if (delta < 0n || delta >= segFileSize) return null;
  const fileOffset = segFileOffset + delta;
  const fileSize = segFileSize - delta;
  if (fileOffset > BigInt(r.length) || fileSize <= 0n || fileSize > BigInt(r.length) - fileOffset) return null;
  return makeDomain(value, fileOffset, fileSize, 'segment-fallback');
}

function domainContains(domain, address, bytes = 1n) {
  const value = BigInt(address);
  const size = BigInt(bytes);
  if (!domain || size < 0n || value < domain.address) return false;
  const delta = value - domain.address;
  return delta <= domain.fileSize && size <= domain.fileSize - delta;
}

function domainOffset(domain, address) {
  if (!domainContains(domain, address, 1n)) return null;
  return domain.fileOffset + (BigInt(address) - domain.address);
}

function domainContext(domain, image, bits) {
  return {
    secAddress:domain.address,
    secOffset:Number(domain.fileOffset),
    textBase:(image.segments.find((s) => s.perms.execute) || image.segments[0] || { address:0n }).address,
    image,
    bits,
    functionBase:null,
  };
}

function recordHeader(r, domain, address) {
  const addressValue = BigInt(address);
  const offBig = domainOffset(domain, addressValue);
  if (offBig == null || offBig > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('FDE/CIE address is outside validated .eh_frame domain');
  const offset = Number(offBig);
  const domainEnd = domain.fileOffset + domain.fileSize;
  if (offBig + 4n > domainEnd || offset + 4 > r.length) throw new Error('truncated FDE/CIE initial length');
  const initialLength = r.u32(offset);
  if (initialLength === 0) throw new Error('zero-length FDE/CIE record');
  let payload = offset + 4;
  let length = BigInt(initialLength);
  let idBytes = 4;
  if (initialLength === 0xffffffff) {
    if (offBig + 12n > domainEnd || offset + 12 > r.length) throw new Error('truncated DWARF64 FDE/CIE initial length');
    length = r.u64(offset + 4);
    payload = offset + 12;
    idBytes = 8;
  }
  if (length < BigInt(idBytes) || length > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('invalid FDE/CIE record length');
  const endBig = BigInt(payload) + length;
  if (endBig > domainEnd || endBig > BigInt(r.length)) throw new Error('FDE/CIE record crosses validated .eh_frame domain');
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

function parseCie(r, image, domain, address, bits) {
  const header = recordHeader(r, domain, address);
  let p = header.payload;
  const cieId = header.idBytes === 8 ? r.u64(p) : BigInt(r.u32(p));
  p += header.idBytes;
  if (cieId !== 0n) throw new Error('referenced record is not an .eh_frame CIE');
  if (p >= header.end) throw new Error('truncated CIE version');
  const version = r.u8(p++);
  if (![1,3,4].includes(version)) throw new Error(`unsupported CIE version ${version}`);
  const augmentationX = readCStringBounded(r, p, header.end);
  p = augmentationX.next;
  const augmentation = augmentationX.value;
  if (version === 4) {
    if (p + 2 > header.end) throw new Error('truncated DWARF4 CIE address-size fields');
    const addressSize = r.u8(p++);
    const segmentSelectorSize = r.u8(p++);
    if (addressSize !== bits / 8 || segmentSelectorSize !== 0) throw new Error('unsupported DWARF4 CIE address/segment size');
  }
  const codeAlign = r.uleb(p, 10, header.end); p = codeAlign.next;
  const dataAlign = r.sleb(p, 10, header.end); p = dataAlign.next;
  void codeAlign; void dataAlign;
  if (version === 1) {
    if (p >= header.end) throw new Error('truncated CIE return-address register');
    p++;
  } else {
    const returnReg = r.uleb(p, 10, header.end); p = returnReg.next;
    void returnReg;
  }

  let fdeEncoding = 0x00;
  let hasAugmentationData = false;
  if (augmentation.startsWith('z')) {
    hasAugmentationData = true;
    const augLength = r.uleb(p, 10, header.end); p = augLength.next;
    if (augLength.value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('CIE augmentation data is too large');
    const augEnd = p + Number(augLength.value);
    if (augEnd > header.end) throw new Error('CIE augmentation data crosses record boundary');
    const ctx = domainContext(domain, image, bits);
    for (const ch of augmentation.slice(1)) {
      if (ch === 'L') {
        if (p >= augEnd) throw new Error('truncated CIE LSDA encoding');
        p++;
      } else if (ch === 'R') {
        if (p >= augEnd) throw new Error('truncated CIE FDE encoding');
        fdeEncoding = r.u8(p++);
        if (fdeEncoding === DW_EH_PE_OMIT) throw new Error('CIE omits FDE initial-location encoding');
      } else if (ch === 'P') {
        if (p >= augEnd) throw new Error('truncated CIE personality encoding');
        const enc = r.u8(p++);
        const personality = decodeEhValue(r, p, enc, ctx, augEnd);
        p = personality.next;
      } else if (ch !== 'S') {
        throw new Error(`unsupported CIE augmentation '${ch}'`);
      }
    }
    if (p > augEnd) throw new Error('CIE augmentation parser crossed declared length');
  } else if (augmentation.length !== 0) {
    throw new Error(`unsupported non-z CIE augmentation '${augmentation}'`);
  }
  return { fdeEncoding, hasAugmentationData };
}

function parseFde(r, image, domain, fdeAddress, bits) {
  const header = recordHeader(r, domain, fdeAddress);
  let p = header.payload;
  const cieDelta = header.idBytes === 8 ? r.u64(p) : BigInt(r.u32(p));
  if (cieDelta === 0n) throw new Error('table FDE pointer references a CIE');
  const pointerFieldAddress = domain.address + BigInt(p - Number(domain.fileOffset));
  if (cieDelta > pointerFieldAddress) throw new Error('FDE CIE pointer underflows address space');
  const cieAddress = pointerFieldAddress - cieDelta;
  if (!domainContains(domain, cieAddress, 4n)) throw new Error('FDE CIE pointer leaves validated .eh_frame domain');
  p += header.idBytes;
  const cie = parseCie(r, image, domain, cieAddress, bits);
  const ctx = domainContext(domain, image, bits);
  const initial = decodeEhValue(r, p, cie.fdeEncoding, ctx, header.end); p = initial.next;
  const rangeEncoding = cie.fdeEncoding & 0x0f;
  const range = decodeEhValue(r, p, rangeEncoding, ctx, header.end); p = range.next;
  if (cie.hasAugmentationData) {
    const augLength = r.uleb(p, 10, header.end); p = augLength.next;
    if (augLength.value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('FDE augmentation data is too large');
    if (p + Number(augLength.value) > header.end) throw new Error('FDE augmentation data crosses record boundary');
  }
  return { initial:initial.value, range:range.value, cieAddress };
}

function existingNonUnwindFunction(image, address) {
  const key = BigInt(address);
  return image.functions.some((f) => BigInt(f?.address ?? -1n) === key && f?.source !== 'unwind');
}

function recordUnverifiedKnownUnwind(image, address, reason, seen) {
  if (address == null || address === 0n || !existingNonUnwindFunction(image, address)) return;
  const key = BigInt(address).toString();
  if (seen.has(key)) return;
  image.functions.push(functionSeed(address, {
    source:'unwind',
    confidence:0,
    exactFunctionStart:false,
    functionStartEvidence:{ kind:'eh-frame-hdr-unverified', verified:false, reason },
  }));
  seen.add(key);
}

export function parseEhFrameHeader(r, sec, image, bits, budget = null) {
  if (sec.size < 4n || sec.offset + sec.size > BigInt(r.length)) return;
  let p = Number(sec.offset);
  const end = Number(sec.offset + sec.size);
  const version = r.u8(p++);
  const ehFrameEnc = r.u8(p++);
  const countEnc = r.u8(p++);
  const tableEnc = r.u8(p++);
  if (version !== 1 || tableEnc === DW_EH_PE_OMIT) return;
  const ctx = {
    secAddress:sec.addr,
    secOffset:Number(sec.offset),
    textBase:(image.segments.find((s) => s.perms.execute) || image.segments[0] || { address:0n }).address,
    image,
    bits,
    functionBase:null,
  };

  try {
    const frame = decodeEhValue(r, p, ehFrameEnc, ctx, end); p = frame.next;
    const countX = decodeEhValue(r, p, countEnc, ctx, end); p = countX.next;
    const count = Number(countX.raw);
    if (!Number.isSafeInteger(count) || count < 0 || count > MAX_EH_RECORDS) return;

    const rows = [];
    let previousInitial = null;
    let tableSorted = true;
    let tableComplete = true;
    for (let i = 0; i < count; i++) {
      if (p >= end) { tableComplete = false; break; }
      if (budget && !budget.take({ records:1, operations:4, inputBytes:2, estimatedHeapBytes:64 }, 'eh-frame-table')) {
        tableComplete = false;
        break;
      }
      const initial = decodeEhValue(r, p, tableEnc, ctx, end); p = initial.next;
      const fde = decodeEhValue(r, p, tableEnc, ctx, end); p = fde.next;
      rows.push({ index:i, initial:initial.value, fde:fde.value });
      if (initial.value != null && initial.value !== 0n) {
        if (previousInitial != null && initial.value <= previousInitial) tableSorted = false;
        previousInitial = initial.value;
      }
    }

    const domain = resolveEhFrameDomain(r, image, frame.value);
    const candidates = [];
    const unverifiedSeen = new Set();
    let invalidEntries = 0;

    if (!tableComplete || !tableSorted) {
      const reason = !tableComplete ? 'eh-frame-table-incomplete' : 'eh-frame-table-not-sorted';
      for (const row of rows) recordUnverifiedKnownUnwind(image, row.initial, reason, unverifiedSeen);
      image.metadata.ehFrameHeader = {
        version, ehFrameEnc, countEnc, tableEnc, declaredFunctions:count, recoveredFunctions:0,
        validatedEntries:0, invalidEntries:count - rows.length, tableSorted, tableComplete,
        validation:'partial', ehFrameAddress:frame.value,
      };
      warn(image, `${reason}; high-confidence header-derived function seeds suppressed`);
      return;
    }

    if (!domain) {
      for (const row of rows) recordUnverifiedKnownUnwind(image, row.initial, 'eh-frame-domain-unresolved', unverifiedSeen);
      image.metadata.ehFrameHeader = {
        version, ehFrameEnc, countEnc, tableEnc, declaredFunctions:count, recoveredFunctions:0,
        validatedEntries:0, invalidEntries:count, tableSorted:true, tableComplete:true,
        validation:'invalid', ehFrameAddress:frame.value,
      };
      warn(image, 'eh_frame_ptr does not resolve to a readable validation domain; new function seeds suppressed');
      return;
    }

    for (const row of rows) {
      if (row.initial == null || row.initial === 0n || row.fde == null || row.fde === 0n) {
        invalidEntries++;
        recordUnverifiedKnownUnwind(image, row.initial, 'missing-fde-evidence', unverifiedSeen);
        continue;
      }
      try {
        if (!domainContains(domain, row.fde, 4n)) throw new Error('FDE pointer is outside validated .eh_frame domain');
        const decoded = parseFde(r, image, domain, row.fde, bits);
        if (decoded.initial !== row.initial) throw new Error('table initial location does not match decoded FDE initial location');
        if (decoded.range == null || decoded.range <= 0n) throw new Error('FDE address range is empty or invalid');
        if (!sameExecutableRange(image, decoded.initial, decoded.range)) throw new Error('FDE range is not contained in executable mapping');
        const alignment = instructionAlignment(image);
        if (alignment > 1n && decoded.initial % alignment !== 0n) throw new Error('FDE initial location violates target instruction alignment');
        candidates.push({ address:decoded.initial, fdeAddress:row.fde, domainKind:domain.kind });
      } catch (entryError) {
        invalidEntries++;
        recordUnverifiedKnownUnwind(image, row.initial, entryError.message, unverifiedSeen);
        warn(image, `entry ${row.index} rejected: ${entryError.message}`);
      }
    }

    let added = 0;
    const addedSeen = new Set();
    for (const candidate of candidates) {
      const key = candidate.address.toString();
      if (addedSeen.has(key)) continue;
      if (budget && !budget.take({ objects:1, operations:1, estimatedHeapBytes:128 }, 'eh-frame-function')) break;
      image.functions.push(functionSeed(candidate.address, {
        source:'unwind',
        confidence:candidate.domainKind === 'section' ? 0.985 : 0.97,
        exactFunctionStart:true,
        functionStartEvidence:{ kind:'eh-frame-fde', verified:true, fdeAddress:candidate.fdeAddress, domain:candidate.domainKind },
      }));
      addedSeen.add(key);
      added++;
    }

    image.metadata.ehFrameHeader = {
      version, ehFrameEnc, countEnc, tableEnc, declaredFunctions:count, recoveredFunctions:added,
      validatedEntries:candidates.length, invalidEntries, tableSorted:true, tableComplete:true,
      validation:invalidEntries === 0 && candidates.length === count ? 'verified' : 'partial',
      ehFrameAddress:frame.value, ehFrameDomain:domain.kind,
    };
  } catch (e) {
    if (e?.code === 'BINARY_SOURCE_RANGE_MISSING') throw e;
    warn(image, e.message);
  }
}

function decodeEhValue(r, p0, enc, ctx, end = r.length) {
  if (enc === DW_EH_PE_OMIT) return { value:null, raw:0n, next:p0 };
  const format = enc & 0x0f;
  const application = enc & 0x70;
  const indirect = !!(enc & 0x80);
  const ptrBytes = ctx.bits === 64 ? 8 : 4;
  let p = p0;
  if (application === 0x50) p = Math.ceil(p / ptrBytes) * ptrBytes;
  const requireSpan = (n) => {
    if (!Number.isSafeInteger(p) || !Number.isSafeInteger(end) || p < 0 || n < 0 || p > end || n > end - p)
      throw new Error('DW_EH_PE value crosses bounded record');
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
  } else if (application !== 0 && application !== 0x50) {
    throw new Error(`unsupported DW_EH_PE application 0x${application.toString(16)}`);
  }
  if (indirect) {
    const off = ctx.image.addressToOffset(value);
    if (off == null || off + BigInt(ptrBytes) > BigInt(r.length)) throw new Error(`DW_EH_PE_indirect target 0x${value.toString(16)} is not readable`);
    value = ctx.bits === 64 ? r.u64(Number(off)) : BigInt(r.u32(Number(off)));
  }
  return { value, raw, next };
}
