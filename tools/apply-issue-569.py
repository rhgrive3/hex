from pathlib import Path

p=Path('js/binary/macho-dyld.js')
s=p.read_text()
start=s.index('export function parseChainedBindingSites(')
end=s.index('\nfunction chainedPointerWidth', start)
new=r'''export function parseChainedBindingSites(r, dc, image, imports, segments = image.segments || []) {
  const base = dc.offset;
  const payloadEnd = base + dc.size;
  image.metadata.chainedFixups ||= {};
  const status = image.metadata.chainedFixups;
  status.bindingSitesComplete = status.bindingSitesComplete !== false;
  status.bindingSiteReasons ||= [];
  let decoded = 0;
  const fail = (message) => {
    status.complete = false;
    status.bindingSitesComplete = false;
    if (!status.bindingSiteReasons.includes(message)) status.bindingSiteReasons.push(message);
    const warning = `chained-fixups: ${message}`;
    if (!image.warnings.includes(warning)) image.warnings.push(warning);
  };
  const startsOffset = r.u32(base + 4);
  if (!startsOffset || base + startsOffset + 4 > payloadEnd) {
    fail('starts-in-image header is missing or truncated');
    status.bindingSites = decoded;
    return status;
  }
  const startsBase = base + startsOffset;
  const segCount = r.u32(startsBase);
  if (segCount > 4096 || startsBase + 4 + segCount * 4 > payloadEnd) {
    fail('segment starts table is truncated or unreasonable');
    status.bindingSites = decoded;
    return status;
  }
  if (segCount !== segments.length) fail(`segment count ${segCount} does not match Mach-O load-command segment count ${segments.length}`);
  const count = Math.min(segCount, segments.length);
  for (let segIndex = 0; segIndex < count; segIndex++) {
    const rel = r.u32(startsBase + 4 + segIndex * 4);
    if (!rel) continue;
    const seg = segments[segIndex];
    const p = startsBase + rel;
    if (!seg || p + 22 > payloadEnd) { fail(`segment ${segIndex} starts record is truncated`); continue; }
    const structSize = r.u32(p);
    const pageSize = r.u16(p + 4);
    const pointerFormat = r.u16(p + 6);
    const segmentOffset = r.u64(p + 8);
    const maxValidPointer = r.u32(p + 16);
    const pageCount = r.u16(p + 20);
    if (structSize < 22 || p + structSize > payloadEnd || 22 + pageCount * 2 > structSize) {
      fail(`segment ${segIndex} starts record size/page table is invalid`); continue;
    }
    if (pageSize !== 0x1000 && pageSize !== 0x4000) {
      fail(`segment ${segIndex} has invalid chained page size 0x${pageSize.toString(16)}`); continue;
    }
    const width = chainedPointerWidth(pointerFormat);
    if (!width) { markUnsupportedChainedFormat(image, pointerFormat); fail(`segment ${segIndex} uses unsupported pointer format ${pointerFormat}`); continue; }
    const segAddress = BigInt(seg.address ?? 0);
    const segSize = BigInt(seg.size ?? 0);
    const segFileOffset = BigInt(seg.fileOffset ?? 0);
    const segFileSize = BigInt(seg.fileSize ?? seg.size ?? 0);
    if (segAddress < image.imageBase || segmentOffset !== segAddress - image.imageBase) {
      fail(`segment ${segIndex} segment_offset does not identify its Mach-O segment`); continue;
    }
    const pageSizeBig = BigInt(pageSize);
    const maxPages = segSize === 0n ? 0n : (segSize + pageSizeBig - 1n) / pageSizeBig;
    if (BigInt(pageCount) > maxPages) {
      fail(`segment ${segIndex} page_count exceeds segment VM range`); continue;
    }
    const structEnd = p + structSize;
    const overflowBase = p + 22 + pageCount * 2;
    if ((structEnd - overflowBase) % 2 !== 0) { fail(`segment ${segIndex} chain_starts array is misaligned`); continue; }
    const overflowCount = (structEnd - overflowBase) / 2;

    for (let page = 0; page < pageCount; page++) {
      const start = r.u16(p + 22 + page * 2);
      if (start === 0xffff) continue;
      const pageOffset = BigInt(page) * pageSizeBig;
      if (pageOffset >= segSize) { fail(`segment ${segIndex} page ${page} starts outside segment`); continue; }
      const pageVmEnd = pageOffset + pageSizeBig < segSize ? pageOffset + pageSizeBig : segSize;
      const pageFileEnd = pageVmEnd < segFileSize ? pageVmEnd : segFileSize;
      const starts = [];
      if (start & 0x8000) {
        let oi = start & 0x7fff;
        if (oi >= overflowCount) { fail(`segment ${segIndex} page ${page} chain_starts index is out of range`); continue; }
        let terminated = false;
        for (let guard = 0; guard < 4096 && oi < overflowCount; guard++, oi++) {
          const x = r.u16(overflowBase + oi * 2);
          starts.push(x & 0x7fff);
          if (x & 0x8000) { terminated = true; break; }
        }
        if (!terminated) { fail(`segment ${segIndex} page ${page} multi-start list is unterminated`); continue; }
      } else {
        starts.push(start);
      }

      const pageAddress = segAddress + pageOffset;
      const pageAddressEnd = segAddress + pageVmEnd;
      const fileBackedAddressEnd = segAddress + pageFileEnd;
      for (const chainStart of starts) {
        if (chainStart >= pageSize || BigInt(chainStart) + BigInt(width) > pageVmEnd - pageOffset || BigInt(chainStart) + BigInt(width) > pageFileEnd - pageOffset) {
          fail(`segment ${segIndex} page ${page} chain start 0x${chainStart.toString(16)} is outside file-backed page data`);
          continue;
        }
        let address = pageAddress + BigInt(chainStart);
        let terminated = false;
        for (let guard = 0; guard < 100000; guard++) {
          if (address < pageAddress || address + BigInt(width) > pageAddressEnd || address + BigInt(width) > fileBackedAddressEnd) {
            fail(`segment ${segIndex} page ${page} chain leaves its page or file-backed segment range`); break;
          }
          const off = image.addressToOffset(address);
          const expectedOff = segFileOffset + (address - segAddress);
          if (off == null || BigInt(off) !== expectedOff || expectedOff + BigInt(width) > segFileOffset + segFileSize || expectedOff + BigInt(width) > BigInt(r.length)) {
            fail(`segment ${segIndex} page ${page} chain address is not backed by its owning segment`); break;
          }
          const raw = width === 4 ? BigInt(r.u32(Number(expectedOff))) : r.u64(Number(expectedOff));
          const d = decodeChainedPointer(raw, pointerFormat);
          if (!d) { markUnsupportedChainedFormat(image, pointerFormat); fail(`segment ${segIndex} pointer format ${pointerFormat} could not be decoded`); break; }
          if (d.bind && d.ordinal >= 0 && d.ordinal < imports.length && imports[d.ordinal]) {
            imports[d.ordinal].sites.push({ address, offset: expectedOff, kind: 'chained-bind', pointerFormat, addend: d.addend });
            decoded++;
          }
          if (!d.next) { terminated = true; break; }
          const delta = BigInt(d.next) * BigInt(d.stride);
          const nextAddress = address + delta;
          if (delta <= 0n || nextAddress <= address || nextAddress + BigInt(width) > pageAddressEnd || nextAddress + BigInt(width) > fileBackedAddressEnd) {
            fail(`segment ${segIndex} page ${page} chained next leaves its page`); break;
          }
          address = nextAddress;
        }
        if (!terminated && status.bindingSitesComplete && starts.length) fail(`segment ${segIndex} page ${page} chain exceeded iteration budget`);
      }
    }
    void maxValidPointer; // value classification for 32-bit pointers, never an address-ownership bound
  }
  status.bindingSites = decoded;
  return status;
}
'''
s=s[:start]+new+s[end:]
p.write_text(s)

p=Path('js/binary/macho.js')
s=p.read_text()
old="if (linkeditData.chainedFixups && chainedImports) parseChainedBindingSites(r, linkeditData.chainedFixups, image, chainedImports);"
new="if (linkeditData.chainedFixups && chainedImports) parseChainedBindingSites(r, linkeditData.chainedFixups, image, chainedImports, segmentOrder);"
if old not in s: raise SystemExit('Mach-O chained binding call anchor missing')
p.write_text(s.replace(old,new,1))

print('applied issue #569 chained segment/page ownership hardening')
