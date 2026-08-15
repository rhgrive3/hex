from pathlib import Path


def replace(path, old, new, label, count=1):
    p=Path(path); s=p.read_text()
    if old not in s: raise SystemExit(f'{label} anchor missing in {path}')
    p.write_text(s.replace(old,new,count))

# Common ByteView contract: variable-length integers may be bounded by the
# logical owner (section/stream/node), not merely by the backing file.
replace('js/binary/reader.js', """  uleb(offset, maxBytes = 10) {
    let p = this.check(offset, 0);
    let value = 0n;
    let shift = 0n;
    for (let i = 0; i < maxBytes; i++, p++) {
      this.check(p, 1);
      const b = this.u8(p);
      value |= BigInt(b & 0x7f) << shift;
      if ((b & 0x80) === 0) return { value, next: p + 1, bytes: p + 1 - Number(offset) };
      shift += 7n;
    }
    throw new BinaryReadError('ULEB128 is too long', this.base + BigInt(Number(offset)));
  }

  sleb(offset, maxBytes = 10) {
    let p = this.check(offset, 0);
    let value = 0n;
    let shift = 0n;
    let b = 0;
    for (let i = 0; i < maxBytes; i++, p++) {
      this.check(p, 1);
      b = this.u8(p);
      value |= BigInt(b & 0x7f) << shift;
      shift += 7n;
      if ((b & 0x80) === 0) {
        if (shift < 64n && (b & 0x40)) value |= (-1n) << shift;
        return { value, next: p + 1, bytes: p + 1 - Number(offset) };
      }
    }
    throw new BinaryReadError('SLEB128 is too long', this.base + BigInt(Number(offset)));
  }""", """  _lebEnd(end) {
    if (end == null) return this.length;
    const n = Number(end);
    if (!Number.isSafeInteger(n) || n < 0 || BigInt(n) > this.lengthBigInt)
      throw new BinaryReadError('invalid bounded substream end', this.base);
    return n;
  }

  uleb(offset, maxBytes = 10, end = null) {
    const start = this.check(offset, 0);
    const hardEnd = this._lebEnd(end);
    if (start > hardEnd) throw new BinaryReadError('ULEB128 starts outside bounded substream', this.base + BigInt(start));
    let p = start;
    let value = 0n;
    let shift = 0n;
    for (let i = 0; i < maxBytes; i++, p++) {
      if (p >= hardEnd) throw new BinaryReadError('ULEB128 crosses bounded substream', this.base + BigInt(p));
      this.check(p, 1);
      const b = this.u8(p);
      value |= BigInt(b & 0x7f) << shift;
      if ((b & 0x80) === 0) return { value, next: p + 1, bytes: p + 1 - start };
      shift += 7n;
    }
    throw new BinaryReadError('ULEB128 is too long', this.base + BigInt(start));
  }

  sleb(offset, maxBytes = 10, end = null) {
    const start = this.check(offset, 0);
    const hardEnd = this._lebEnd(end);
    if (start > hardEnd) throw new BinaryReadError('SLEB128 starts outside bounded substream', this.base + BigInt(start));
    let p = start;
    let value = 0n;
    let shift = 0n;
    let b = 0;
    for (let i = 0; i < maxBytes; i++, p++) {
      if (p >= hardEnd) throw new BinaryReadError('SLEB128 crosses bounded substream', this.base + BigInt(p));
      this.check(p, 1);
      b = this.u8(p);
      value |= BigInt(b & 0x7f) << shift;
      shift += 7n;
      if ((b & 0x80) === 0) {
        if (shift < 64n && (b & 0x40)) value |= (-1n) << shift;
        return { value, next: p + 1, bytes: p + 1 - start };
      }
    }
    throw new BinaryReadError('SLEB128 is too long', this.base + BigInt(start));
  }""", '#572 ByteView bounded LEB')

# LC_FUNCTION_STARTS: a split ULEB must not consume adjacent __LINKEDIT bytes.
replace('js/binary/macho.js', """  while (p < end) {
    const x = r.uleb(p);
    p = x.next;
    if (x.value === 0n) break;""", """  const status = image.metadata.functionStarts = { complete: true, recovered: 0, partialReason: null };
  while (p < end) {
    let x;
    try { x = r.uleb(p, 10, end); }
    catch (e) {
      status.complete = false; status.partialReason = 'truncated-leb';
      image.warnings.push(`LC_FUNCTION_STARTS: ${e.message}`); break;
    }
    p = x.next;
    if (x.value === 0n) break;""", '#572 function starts bounded decode')
replace('js/binary/macho.js', """    image.functions.push(functionSeed(addr, { source: 'function_starts', confidence: 0.995 }));
  }
}""", """    image.functions.push(functionSeed(addr, { source: 'function_starts', confidence: 0.995 }));
    status.recovered++;
  }
}""", '#572 function starts status')

# Classic bind streams: every operand LEB belongs to the declared dyld stream.
p=Path('js/binary/macho-dyld.js'); s=p.read_text()
start=s.index('export function parseClassicBindings')
end_fn=s.index('\nexport function parseExportTrie',start)
part=s[start:end_fn]
part=part.replace('  while (p < end) {','  try {\n    while (p < end) {',1)
part=part.replace('r.uleb(p)', 'r.uleb(p, 10, end)')
part=part.replace('r.sleb(p)', 'r.sleb(p, 10, end)')
needle="""  }
  if (threadedTable && threadedTable.length !== threadedTableLimit) fail(`threaded ordinal table expected ${threadedTableLimit} entries, decoded ${threadedTable.length}`);"""
repl="""    }
  } catch (e) {
    if (e?.code === 'BINARY_SOURCE_RANGE_MISSING') throw e;
    fail(`bounded stream operand is truncated: ${e.message}`);
  }
  if (threadedTable && threadedTable.length !== threadedTableLimit) fail(`threaded ordinal table expected ${threadedTableLimit} entries, decoded ${threadedTable.length}`);"""
if needle not in part: raise SystemExit('#572 classic bind close anchor missing')
part=part.replace(needle,repl,1)
s=s[:start]+part+s[end_fn:]
p.write_text(s)

# Export trie: terminal payload fields are bounded by terminalSize; child offsets
# are bounded by the trie command itself.
replace('js/binary/macho-dyld.js', "const term = r.uleb(p); p = term.next;", "const term = r.uleb(p, 10, end); p = term.next;", '#572 export terminal size')
replace('js/binary/macho-dyld.js', "const flagsX = r.uleb(p); p = flagsX.next; const flags = Number(flagsX.value);", "const flagsX = r.uleb(p, 10, terminalEnd); p = flagsX.next; const flags = Number(flagsX.value);", '#572 export flags')
replace('js/binary/macho-dyld.js', "const ord = r.uleb(p); p = ord.next; const importedX = rawCString(r, p, terminalEnd);", "const ord = r.uleb(p, 10, terminalEnd); p = ord.next; const importedX = rawCString(r, p, terminalEnd);", '#572 export ordinal')
replace('js/binary/macho-dyld.js', "const addrX = r.uleb(p); p = addrX.next; const exportKind = flags & 0x03;", "const addrX = r.uleb(p, 10, terminalEnd); p = addrX.next; const exportKind = flags & 0x03;", '#572 export address')
replace('js/binary/macho-dyld.js', "if (flags & 0x10) { const resolverX = r.uleb(p); p = resolverX.next; ex.resolver = image.imageBase + resolverX.value; }", "if (flags & 0x10) { const resolverX = r.uleb(p, 10, terminalEnd); p = resolverX.next; ex.resolver = image.imageBase + resolverX.value; }", '#572 export resolver')
replace('js/binary/macho-dyld.js', "const child = r.uleb(p); p = child.next; walk(Number(child.value), prefix + edge, depth + 1);", "const child = r.uleb(p, 10, end); p = child.next; walk(Number(child.value), prefix + edge, depth + 1);", '#572 export child offset')

# .eh_frame_hdr: pass the section end through every encoded value, including
# ULEB/SLEB and fixed-width formats after alignment.
replace('js/binary/elf-unwind.js', """    const frame = decodeEhValue(r, p, ehFrameEnc, ctx); p = frame.next;
    const countX = decodeEhValue(r, p, countEnc, ctx); p = countX.next;""", """    const frame = decodeEhValue(r, p, ehFrameEnc, ctx, end); p = frame.next;
    const countX = decodeEhValue(r, p, countEnc, ctx, end); p = countX.next;""", '#572 eh header prelude')
replace('js/binary/elf-unwind.js', """      const initial = decodeEhValue(r, p, tableEnc, ctx); p = initial.next;
      const fde = decodeEhValue(r, p, tableEnc, ctx); p = fde.next;""", """      const initial = decodeEhValue(r, p, tableEnc, ctx, end); p = initial.next;
      const fde = decodeEhValue(r, p, tableEnc, ctx, end); p = fde.next;""", '#572 eh table')
replace('js/binary/elf-unwind.js', "function decodeEhValue(r, p0, enc, ctx) {", "function decodeEhValue(r, p0, enc, ctx, end = r.length) {", '#572 eh decoder signature')
replace('js/binary/elf-unwind.js', """  let p = p0;
  if (application === 0x50) p = Math.ceil(p / ptrBytes) * ptrBytes;
  let raw, next;
  if (format === 0x00) { raw = ctx.bits === 64 ? r.u64(p) : BigInt(r.u32(p)); next = p + ptrBytes; }
  else if (format === 0x01) { const x = r.uleb(p); raw = x.value; next = x.next; }
  else if (format === 0x02) { raw = BigInt(r.u16(p)); next = p + 2; }
  else if (format === 0x03) { raw = BigInt(r.u32(p)); next = p + 4; }
  else if (format === 0x04) { raw = r.u64(p); next = p + 8; }
  else if (format === 0x09) { const x = r.sleb(p); raw = x.value; next = x.next; }
  else if (format === 0x0a) { raw = BigInt(r.i16(p)); next = p + 2; }
  else if (format === 0x0b) { raw = BigInt(r.i32(p)); next = p + 4; }
  else if (format === 0x0c) { raw = r.i64(p); next = p + 8; }""", """  let p = p0;
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
  else if (format === 0x0c) { requireSpan(8); raw = r.i64(p); next = p + 8; }""", '#572 eh bounded formats')

print('applied issue #572 bounded LEB/substream fix')
