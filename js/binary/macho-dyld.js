import { functionSeed } from './model.js';

export function parseChainedImports(r, dc, image) {
  if (!dc.size || dc.offset + dc.size > r.length || dc.size < 28) return null;
  const base = dc.offset;
  const version = r.u32(base);
  const startsOffset = r.u32(base + 4);
  const importsOffset = r.u32(base + 8);
  const symbolsOffset = r.u32(base + 12);
  const importsCount = r.u32(base + 16);
  const importsFormat = r.u32(base + 20);
  const symbolsFormat = r.u32(base + 24);
  image.metadata.chainedFixups = { version, startsOffset, importsCount, importsFormat, symbolsFormat, complete: true, symbolsComplete: true };
  if (symbolsFormat !== 0) {
    image.metadata.chainedFixups.complete = false;
    image.metadata.chainedFixups.symbolsComplete = false;
    image.metadata.chainedFixups.partialReason = symbolsFormat === 1 ? 'compressed-symbol-pool' : 'unknown-symbol-pool-format';
    image.warnings.push(`chained-fixups symbol pool format ${symbolsFormat} is not supported; results are partial`);
    return null;
  }
  const importsBase = base + importsOffset;
  const stringsBase = base + symbolsOffset;
  const entrySize = importsFormat === 1 ? 4 : importsFormat === 2 ? 8 : importsFormat === 3 ? 16 : 0;
  if (!entrySize) { image.warnings.push(`unknown chained import format ${importsFormat}`); return null; }
  if (importsBase + importsCount * entrySize > base + dc.size) { image.warnings.push('chained imports are truncated'); return null; }
  const parsed = [];
  for (let i = 0; i < importsCount; i++) {
    const p = importsBase + i * entrySize;
    let ordinal, weak, nameOffset, addend = 0n;
    if (importsFormat === 1 || importsFormat === 2) {
      const raw = r.u32(p);
      ordinal = signExtend(raw & 0xff, 8);
      weak = !!((raw >>> 8) & 1);
      nameOffset = raw >>> 9;
      if (importsFormat === 2) addend = BigInt(r.i32(p + 4));
    } else {
      const raw = r.u32(p);
      ordinal = signExtend(raw & 0xffff, 16);
      weak = !!((raw >>> 16) & 1);
      nameOffset = r.u32(p + 4);
      addend = r.i64(p + 8);
    }
    const strp = stringsBase + nameOffset;
    if (strp < base || strp >= base + dc.size) continue;
    const name = r.cstring(strp, base + dc.size - strp);
    if (!name) continue;
    const imp = { name, library: dylibForOrdinal(image, ordinal), ordinal, weak, addend, source: 'chained-fixups', sites: [], chainedIndex: i };
    image.imports.push(imp);
    parsed[i] = imp;
  }
  return parsed;
}

export function parseChainedBindingSites(r, dc, image, imports) {
  const base = dc.offset;
  const startsOffset = r.u32(base + 4);
  if (!startsOffset || base + startsOffset + 4 > base + dc.size) return;
  const startsBase = base + startsOffset;
  const segCount = r.u32(startsBase);
  if (segCount > 4096 || startsBase + 4 + segCount * 4 > base + dc.size) return;
  let decoded = 0;
  for (let segIndex = 0; segIndex < segCount; segIndex++) {
    const rel = r.u32(startsBase + 4 + segIndex * 4);
    if (!rel) continue;
    const p = startsBase + rel;
    if (p + 22 > base + dc.size) continue;
    const structSize = r.u32(p);
    const pageSize = r.u16(p + 4);
    const pointerFormat = r.u16(p + 6);
    const segmentOffset = r.u64(p + 8);
    const maxValidPointer = r.u32(p + 16);
    const pageCount = r.u16(p + 20);
    if (!pageSize || p + structSize > base + dc.size || 22 + pageCount * 2 > structSize) continue;
    for (let page = 0; page < pageCount; page++) {
      const start = r.u16(p + 22 + page * 2);
      if (start === 0xffff) continue;
      const starts = [];
      if (start & 0x8000) {
        let oi = start & 0x7fff;
        for (let guard = 0; guard < 4096; guard++, oi++) {
          const q = p + 22 + oi * 2;
          if (q + 2 > p + structSize) break;
          const x = r.u16(q);
          starts.push(x & 0x7fff);
          if (x & 0x8000) break;
        }
      } else starts.push(start);
      for (const chainStart of starts) {
        let address = image.imageBase + segmentOffset + BigInt(page * pageSize + chainStart);
        for (let guard = 0; guard < 100000; guard++) {
          const off = image.addressToOffset(address);
          const width = chainedPointerWidth(pointerFormat);
          if (!width) { markUnsupportedChainedFormat(image, pointerFormat); break; }
          if (off == null || off + BigInt(width) > BigInt(r.length)) break;
          const raw = width === 4 ? BigInt(r.u32(Number(off))) : r.u64(Number(off));
          const d = decodeChainedPointer(raw, pointerFormat);
          if (!d) { markUnsupportedChainedFormat(image, pointerFormat); break; }
          if (d.bind && d.ordinal >= 0 && d.ordinal < imports.length && imports[d.ordinal]) {
            imports[d.ordinal].sites.push({ address, offset: off, kind: 'chained-bind', pointerFormat, addend: d.addend });
            decoded++;
          }
          if (!d.next) break;
          address += BigInt(d.next * d.stride);
          if (maxValidPointer && address - (image.imageBase + segmentOffset) > BigInt(maxValidPointer) + BigInt(pageSize * pageCount)) break;
        }
      }
    }
  }
  image.metadata.chainedFixups.bindingSites = decoded;
}

function chainedPointerWidth(format) {
  if ([3, 4, 5].includes(format)) return 4;
  if ([1, 2, 6, 7, 9, 10, 12].includes(format)) return 8;
  return 0;
}
function markUnsupportedChainedFormat(image, format) {
  image.metadata.chainedFixups ||= {};
  image.metadata.chainedFixups.complete = false;
  image.metadata.chainedFixups.bindingSitesComplete = false;
  const list = image.metadata.chainedFixups.unsupportedPointerFormats ||= [];
  if (!list.includes(format)) { list.push(format); image.warnings.push(`chained pointer format ${format} is not supported; binding sites are partial`); }
}
function decodeChainedPointer(raw, format) {
  if (format === 3) {
    const bind = !!((raw >> 31n) & 1n);
    const next = Number((raw >> 26n) & 0x1fn);
    if (!bind) return { bind: false, ordinal: -1, addend: 0n, next, stride: 4 };
    const ordinal = Number(raw & 0xfffffn);
    let addend = Number((raw >> 20n) & 0x3fn);
    if (addend & 0x20) addend -= 0x40;
    return { bind: true, ordinal, addend: BigInt(addend), next, stride: 4 };
  }
  if (format === 2 || format === 6) {
    const bind = !!(raw >> 63n);
    const next = Number((raw >> 51n) & 0xfffn);
    if (!bind) return { bind: false, ordinal: -1, addend: 0n, next, stride: 4 };
    const ordinal = Number(raw & 0xffffffn);
    let addend = Number((raw >> 24n) & 0xffn);
    if (addend & 0x80) addend -= 0x100;
    return { bind: true, ordinal, addend: BigInt(addend), next, stride: 4 };
  }
  if ([1, 7, 9, 10, 12].includes(format)) {
    const bind = !!((raw >> 62n) & 1n);
    const next = Number((raw >> 51n) & 0x7ffn);
    const ordinalBits = format === 12 ? 24n : 16n;
    const ordinalMask = (1n << ordinalBits) - 1n;
    const ordinal = Number(raw & ordinalMask);
    const auth = !!((raw >> 63n) & 1n);
    let addend = 0n;
    if (bind && !auth) {
      let a = Number((raw >> 32n) & 0x7ffffn);
      if (a & 0x40000) a -= 0x80000;
      addend = BigInt(a);
    }
    const stride = format === 7 || format === 10 ? 4 : 8;
    return { bind, ordinal, addend, next, stride };
  }
  return null;
}

export function parseClassicBindings(r, dc, image, segments, source) {
  if (!dc || !dc.size || dc.offset + dc.size > r.length) return null;
  const BIND_OPCODE_MASK = 0xf0, BIND_IMMEDIATE_MASK = 0x0f;
  const ptrSize = image.bits === 64 ? 8n : 4n;
  let p = dc.offset;
  const end = dc.offset + dc.size;
  let libOrdinal = 0, symbol = '', symbolFlags = 0, type = 1, addend = 0n, segIndex = 0, segOffset = 0n;
  let threadedTable = null, threadedTableLimit = 0;
  const status = { source, complete: true, decodedBinds: 0, threadedApplies: 0, unsupportedOpcodes: [] };
  image.metadata.dyldBindings ||= { complete: true, streams: {} };
  image.metadata.dyldBindings.streams[source] = status;
  const fail = (message, opcode = null) => {
    status.complete = false; image.metadata.dyldBindings.complete = false;
    if (opcode != null && !status.unsupportedOpcodes.includes(opcode)) status.unsupportedOpcodes.push(opcode);
    image.warnings.push(`${source}: ${message}`);
  };
  const snapshotImport = () => ({ name: symbol, library: dylibForOrdinal(image, libOrdinal), ordinal: libOrdinal, weak: !!(symbolFlags & 1), symbolFlags, nonWeakDefinition: !!(symbolFlags & 8), addend, type, source, sites: [] });
  const validLocation = () => {
    const seg = segments[segIndex];
    return !!seg && segOffset >= 0n && segOffset <= seg.size && ptrSize <= seg.size - segOffset;
  };
  const bind = () => {
    if (!symbol) return;
    if (threadedTable && threadedTable.length < threadedTableLimit) { threadedTable.push(snapshotImport()); return; }
    if (!validLocation()) { fail(`bind location is outside segment ${segIndex} at +0x${segOffset.toString(16)}`); return; }
    const seg = segments[segIndex];
    const address = seg.address + segOffset;
    const imp = snapshotImport();
    imp.sites.push({ address, offset: image.addressToOffset(address), kind: source, type, addend, weak: imp.weak });
    image.imports.push(imp); status.decodedBinds++;
  };
  const applyThreaded = () => {
    if (!threadedTable) { fail('threaded APPLY encountered before ordinal table'); return; }
    if (!validLocation()) { fail('threaded APPLY starts outside its segment'); return; }
    const seg = segments[segIndex];
    let address = seg.address + segOffset;
    for (let guard = 0; guard < 100000; guard++) {
      const off = image.addressToOffset(address);
      if (off == null || off + 8n > BigInt(r.length)) { fail('threaded binding chain leaves mapped file data'); return; }
      const raw = r.u64(Number(off));
      const isBind = !!((raw >> 62n) & 1n);
      const delta = Number((raw >> 51n) & 0x7ffn);
      if (isBind) {
        const ordinal = Number(raw & 0xffffn);
        const template = threadedTable[ordinal];
        if (!template) fail(`threaded bind ordinal ${ordinal} is outside table`);
        else {
          const imp = { ...template, sites: [{ address, offset: off, kind: 'threaded-bind', type: template.type, addend: template.addend, weak: template.weak }] };
          image.imports.push(imp); status.decodedBinds++;
        }
      }
      if (!delta) { status.threadedApplies++; return; }
      address += BigInt(delta * 8);
      if (address < seg.address || address + ptrSize > seg.address + seg.size) { fail('threaded binding delta leaves segment'); return; }
    }
    fail('threaded binding chain exceeded the 100000-entry budget');
  };
  while (p < end) {
    const byte = r.u8(p++);
    const op = byte & BIND_OPCODE_MASK;
    const imm = byte & BIND_IMMEDIATE_MASK;
    if (op === 0x00) {
      if (source === 'lazy-bind') { symbol = ''; symbolFlags = 0; libOrdinal = 0; addend = 0n; continue; }
      break;
    } else if (op === 0x10) libOrdinal = imm;
    else if (op === 0x20) { const x = r.uleb(p); p = x.next; libOrdinal = Number(x.value); }
    else if (op === 0x30) libOrdinal = imm === 0 ? 0 : signExtend(imm | 0xf0, 8);
    else if (op === 0x40) { const x = rawCString(r, p, end); symbol = x.text; symbolFlags = imm; p = x.next; }
    else if (op === 0x50) type = imm;
    else if (op === 0x60) { const x = r.sleb(p); p = x.next; addend = x.value; }
    else if (op === 0x70) { segIndex = imm; const x = r.uleb(p); p = x.next; segOffset = x.value; }
    else if (op === 0x80) { const x = r.uleb(p); p = x.next; segOffset += x.value; }
    else if (op === 0x90) { bind(); segOffset += ptrSize; }
    else if (op === 0xa0) { bind(); const x = r.uleb(p); p = x.next; segOffset += ptrSize + x.value; }
    else if (op === 0xb0) { bind(); segOffset += ptrSize + BigInt(imm) * ptrSize; }
    else if (op === 0xc0) {
      const a = r.uleb(p); p = a.next; const b = r.uleb(p); p = b.next;
      if (a.value > 10_000_000n) { fail('bind repeat count exceeds budget'); break; }
      for (let i = 0n; i < a.value; i++) { bind(); segOffset += ptrSize + b.value; }
    } else if (op === 0xd0) {
      if (imm === 0) {
        const x = r.uleb(p); p = x.next;
        if (x.value > 65536n) { fail('threaded ordinal table exceeds 65536 entries'); break; }
        threadedTableLimit = Number(x.value); threadedTable = [];
      } else if (imm === 1) applyThreaded();
      else { fail(`unknown threaded bind subopcode 0x${imm.toString(16)}`, byte); break; }
    } else { fail(`unknown dyld bind opcode 0x${op.toString(16)}`, byte); break; }
  }
  if (threadedTable && threadedTable.length !== threadedTableLimit) fail(`threaded ordinal table expected ${threadedTableLimit} entries, decoded ${threadedTable.length}`);
  return status;
}

export function parseExportTrie(r, dc, image) {
  if (!dc || !dc.size || dc.offset + dc.size > r.length) return null;
  const base = dc.offset, end = dc.offset + dc.size;
  const active = new Set();
  const status = { complete: true, nodes: 0, edges: 0, cycleDetected: false, budgetExceeded: false };
  image.metadata.exportTrie = status;
  const markPartial = (message, field) => { status.complete = false; if (field) status[field] = true; image.warnings.push(`exports trie: ${message}`); };
  const walk = (nodeOff, prefix, depth) => {
    if (depth > 256) { markPartial('depth budget exceeded', 'budgetExceeded'); return; }
    if (!Number.isSafeInteger(nodeOff) || nodeOff < 0 || base + nodeOff >= end) { markPartial('child node offset is outside trie'); return; }
    if (active.has(nodeOff)) { markPartial(`cycle detected at node 0x${nodeOff.toString(16)}`, 'cycleDetected'); return; }
    if (++status.nodes > 1_000_000) { markPartial('node budget exceeded', 'budgetExceeded'); return; }
    active.add(nodeOff);
    try {
      let p = base + nodeOff;
      const term = r.uleb(p); p = term.next;
      const terminalSize = Number(term.value);
      if (!Number.isSafeInteger(terminalSize) || terminalSize < 0 || p + terminalSize > end) { markPartial('terminal payload is truncated'); return; }
      const terminalEnd = p + terminalSize;
      if (term.value) {
        const flagsX = r.uleb(p); p = flagsX.next; const flags = Number(flagsX.value);
        if (flags & 0x08) {
          const ord = r.uleb(p); p = ord.next; const importedX = rawCString(r, p, terminalEnd);
          image.exports.push({ name: prefix, address: 0n, kind: 'reexport', flags, ordinal: Number(ord.value), imported: importedX.text || null, source: 'exports-trie' });
        } else {
          const addrX = r.uleb(p); p = addrX.next; const exportKind = flags & 0x03;
          const address = exportKind === 0 ? image.imageBase + addrX.value : addrX.value;
          const kind = exportKind === 1 ? 'thread-local' : exportKind === 2 ? 'absolute' : 'export';
          const ex = { name: prefix, address, kind, flags, source: 'exports-trie' };
          if (flags & 0x10) { const resolverX = r.uleb(p); p = resolverX.next; ex.resolver = image.imageBase + resolverX.value; }
          image.exports.push(ex);
          if (exportKind === 0) { const sec = image.sectionAt(address); if (sec && sec.perms.execute) image.functions.push(functionSeed(address, { name: prefix, source: 'export', confidence: 0.9 })); }
        }
      }
      p = terminalEnd; if (p >= end) return;
      const children = r.u8(p++);
      for (let i = 0; i < children; i++) {
        if (++status.edges > 2_000_000) { markPartial('edge budget exceeded', 'budgetExceeded'); return; }
        const edgeX = rawCString(r, p, end); const edge = edgeX.text; p = edgeX.next;
        if (p >= end) { markPartial('child offset is truncated'); return; }
        const child = r.uleb(p); p = child.next; walk(Number(child.value), prefix + edge, depth + 1);
      }
    } finally { active.delete(nodeOff); }
  };
  try { walk(0, '', 0); } catch (e) {
    if (e?.code === 'BINARY_SOURCE_RANGE_MISSING') throw e; markPartial(e.message);
  }
  return status;
}

function rawCString(r, p, end) {
  const start = p;
  while (p < end && r.u8(p) !== 0) p++;
  if (p >= end) throw new Error('unterminated C string');
  const raw = r.slice(start, p - start);
  let text;
  try { text = new TextDecoder('utf-8', { fatal: false }).decode(raw); }
  catch { text = Array.from(raw, (c) => c >= 0x20 && c <= 0x7e ? String.fromCharCode(c) : '\uFFFD').join(''); }
  return { text, next: p + 1, bytes: p + 1 - start };
}

function dylibForOrdinal(image, ordinal) {
  if (ordinal === 0) return null;
  if (ordinal === -1 || ordinal === 0xff) return '<main-executable>';
  if (ordinal === -2 || ordinal === 0xfe) return '<flat-lookup>';
  if (ordinal === -3 || ordinal === 0xfd) return '<weak-lookup>';
  return ordinal > 0 ? image.libraries[ordinal - 1] || null : null;
}
function signExtend(v, bits) { const sign = 1 << (bits - 1); const mask = (1 << bits) - 1; v &= mask; return (v & sign) ? v - (1 << bits) : v; }