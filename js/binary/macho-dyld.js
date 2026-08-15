import { ensureMachOMetadataBudget } from './macho-budget.js';
import { functionSeed } from './model.js';

export function parseChainedImports(r,dc,image,sharedBudget=null){
  const budget=ensureMachOMetadataBudget(image,sharedBudget);
  if (!dc?.size || dc.offset + dc.size > r.length || dc.size < 28) {
    image.metadata.chainedFixups = { complete:false, symbolsComplete:false, importsComplete:false, bindingSitesComplete:false, partialReason:'invalid-or-truncated-payload' };
    image.warnings.push('chained-fixups payload is missing or truncated; results are partial');
    return null;
  }
  const base = dc.offset;
  const version = r.u32(base);
  const startsOffset = r.u32(base + 4);
  const importsOffset = r.u32(base + 8);
  const symbolsOffset = r.u32(base + 12);
  const importsCount = r.u32(base + 16);
  const importsFormat = r.u32(base + 20);
  const symbolsFormat = r.u32(base + 24);
  const status = image.metadata.chainedFixups = { version, startsOffset, importsCount, importsFormat, symbolsFormat, complete:true, symbolsComplete:true, importsComplete:true };
  if (version !== 0) {
    status.complete=false; status.importsComplete=false; status.importsPartialReason='unsupported-version';
    image.warnings.push(`chained-fixups version ${version} is not supported; results are partial`);
    return null;
  }
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
  if (!entrySize) { status.complete=false; status.importsComplete=false; status.importsPartialReason='unsupported-import-format'; image.warnings.push(`unknown chained import format ${importsFormat}`); return null; }
  if (importsOffset >= dc.size || symbolsOffset >= dc.size || importsBase + importsCount * entrySize > base + dc.size) { status.complete=false; status.importsComplete=false; status.importsPartialReason='truncated-import-table'; image.warnings.push('chained imports are truncated'); return null; }
  const parsed = [];
  for(let i=0;i<importsCount;i++){
    if(!budget.take({inputBytes:entrySize,records:1,objects:1,operations:2,estimatedHeapBytes:224},'chained-import-record')){status.complete=false;status.importsComplete=false;status.importsPartialReason='metadata-budget';break;}
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
    if (strp < base || strp >= base + dc.size) { status.complete=false;status.importsComplete=false;status.importsPartialReason ||= 'invalid-name-offset';continue; }
    const name = r.cstring(strp, base + dc.size - strp);
    if (!name) { status.complete=false;status.importsComplete=false;status.importsPartialReason ||= 'invalid-import-name';continue; }
    if(!budget.take({stringBytes:name.length*2,estimatedHeapBytes:name.length*2+32},'chained-import-name')){status.complete=false;status.importsComplete=false;status.importsPartialReason='metadata-budget';break;}
    const imp = { name, library: dylibForOrdinal(image, ordinal), ordinal, weak, addend, source: 'chained-fixups', sites: [], chainedIndex: i };
    image.imports.push(imp);
    parsed[i] = imp;
  }
  return parsed;
}

export function parseChainedBindingSites(r,dc,image,imports,segments=image.segments||[],sharedBudget=null){
  const budget=ensureMachOMetadataBudget(image,sharedBudget);
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
      if(!budget.take({inputBytes:2,records:1,operations:1,estimatedHeapBytes:16},'chained-page')){fail('shared metadata budget exhausted while decoding pages');status.bindingSites=decoded;return status;}
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
          if(!budget.take({inputBytes:width,records:1,operations:1,estimatedHeapBytes:16},'chained-pointer')){fail('shared metadata budget exhausted while decoding pointer chain');status.bindingSites=decoded;return status;}
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
            if(!budget.take({objects:1,operations:1,estimatedHeapBytes:112},'chained-bind-site')){fail('shared metadata budget exhausted while recording bind site');status.bindingSites=decoded;return status;}
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

export function parseClassicBindings(r,dc,image,segments,source,sharedBudget=null){
  const budget=ensureMachOMetadataBudget(image,sharedBudget);
  image.metadata.dyldBindings ||= { complete:true, streams:{} };
  if (!dc || !dc.size) return null;
  if (dc.offset + dc.size > r.length) {
    const invalid={source,complete:false,decodedBinds:0,threadedApplies:0,unsupportedOpcodes:[],partialReason:'truncated-range'};
    image.metadata.dyldBindings.complete=false;image.metadata.dyldBindings.streams[source]=invalid;
    image.warnings.push(`${source}: binding stream is truncated`);return invalid;
  }
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
    if(!budget.take({objects:2,operations:1,estimatedHeapBytes:320},'classic-bind-output')){fail('shared metadata budget exhausted while recording bind');return;}
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
          if(!budget.take({objects:2,operations:1,estimatedHeapBytes:320},'classic-bind-output')){fail('shared metadata budget exhausted while recording bind');return;}
    image.imports.push(imp); status.decodedBinds++;
        }
      }
      if (!delta) { status.threadedApplies++; return; }
      address += BigInt(delta * 8);
      if (address < seg.address || address + ptrSize > seg.address + seg.size) { fail('threaded binding delta leaves segment'); return; }
    }
    fail('threaded binding chain exceeded the 100000-entry budget');
  };
  try {
    while (p < end) {
    if(!budget.take({inputBytes:1,records:1,operations:1,estimatedHeapBytes:8},'classic-bind-opcode')){fail('shared metadata budget exhausted while decoding bind stream');break;}
    const byte = r.u8(p++);
    const op = byte & BIND_OPCODE_MASK;
    const imm = byte & BIND_IMMEDIATE_MASK;
    if (op === 0x00) {
      if (source === 'lazy-bind') { symbol = ''; symbolFlags = 0; libOrdinal = 0; addend = 0n; continue; }
      break;
    } else if (op === 0x10) libOrdinal = imm;
    else if (op === 0x20) { const x = r.uleb(p, 10, end); p = x.next; libOrdinal = Number(x.value); }
    else if (op === 0x30) libOrdinal = imm === 0 ? 0 : signExtend(imm | 0xf0, 8);
    else if (op === 0x40) { const x = rawCString(r, p, end); symbol = x.text; symbolFlags = imm; p = x.next; }
    else if (op === 0x50) type = imm;
    else if (op === 0x60) { const x = r.sleb(p, 10, end); p = x.next; addend = x.value; }
    else if (op === 0x70) { segIndex = imm; const x = r.uleb(p, 10, end); p = x.next; segOffset = x.value; }
    else if (op === 0x80) { const x = r.uleb(p, 10, end); p = x.next; segOffset += x.value; }
    else if (op === 0x90) { bind(); segOffset += ptrSize; }
    else if (op === 0xa0) { bind(); const x = r.uleb(p, 10, end); p = x.next; segOffset += ptrSize + x.value; }
    else if (op === 0xb0) { bind(); segOffset += ptrSize + BigInt(imm) * ptrSize; }
    else if (op === 0xc0) {
      const a = r.uleb(p, 10, end); p = a.next; const b = r.uleb(p, 10, end); p = b.next;
      if(a.value>BigInt(Number.MAX_SAFE_INTEGER)){fail('bind repeat count exceeds safe integer range');break;}
      const repeat=Number(a.value),step=ptrSize+b.value,owner=segments[segIndex];
      const maxBySegment=owner&&step>0n&&segOffset>=0n&&segOffset+ptrSize<=owner.size?Number(((owner.size-segOffset-ptrSize)/step)+1n):0;
      const maxByBudget=Math.min(budget.remaining('operations'),Math.floor(budget.remaining('objects')/2));
      const allowed=Math.max(0,Math.min(repeat,maxBySegment,maxByBudget));
      for(let i=0;i<allowed;i++){bind();segOffset+=step;}
      if(allowed<repeat){fail(`bind repeat count ${repeat} exceeds segment/shared metadata capacity ${allowed}`);break;}
    } else if (op === 0xd0) {
      if (imm === 0) {
        const x = r.uleb(p, 10, end); p = x.next;
        if (x.value > 65536n) { fail('threaded ordinal table exceeds 65536 entries'); break; }
        threadedTableLimit = Number(x.value); threadedTable = [];
      } else if (imm === 1) applyThreaded();
      else { fail(`unknown threaded bind subopcode 0x${imm.toString(16)}`, byte); break; }
    } else { fail(`unknown dyld bind opcode 0x${op.toString(16)}`, byte); break; }
    }
  } catch (e) {
    if (e?.code === 'BINARY_SOURCE_RANGE_MISSING') throw e;
    fail(`bounded stream operand is truncated: ${e.message}`);
  }
  if (threadedTable && threadedTable.length !== threadedTableLimit) fail(`threaded ordinal table expected ${threadedTableLimit} entries, decoded ${threadedTable.length}`);
  return status;
}

export function parseExportTrie(r,dc,image,sharedBudget=null){
  const budget=ensureMachOMetadataBudget(image,sharedBudget);
  if (!dc || !dc.size) return null;
  if (dc.offset + dc.size > r.length) {
    const invalid={complete:false,nodes:0,edges:0,cycleDetected:false,budgetExceeded:false,partialReason:'truncated-range'};
    image.metadata.exportTrie=invalid;image.warnings.push('exports trie: payload is truncated');return invalid;
  }
  const base = dc.offset, end = dc.offset + dc.size;
  const active = new Set();
  const status = { complete: true, nodes: 0, edges: 0, cycleDetected: false, budgetExceeded: false };
  image.metadata.exportTrie = status;
  const markPartial = (message, field) => { status.complete = false; if (field) status[field] = true; image.warnings.push(`exports trie: ${message}`); };
  const walk = (nodeOff, prefix, depth) => {
    if (depth > 256) { markPartial('depth budget exceeded', 'budgetExceeded'); return; }
    if (!Number.isSafeInteger(nodeOff) || nodeOff < 0 || base + nodeOff >= end) { markPartial('child node offset is outside trie'); return; }
    if (active.has(nodeOff)) { markPartial(`cycle detected at node 0x${nodeOff.toString(16)}`, 'cycleDetected'); return; }
    if(!budget.take({records:1,objects:1,operations:1,estimatedHeapBytes:48},'export-trie-node')){markPartial('shared metadata node budget exceeded','budgetExceeded');return;} status.nodes++;
    active.add(nodeOff);
    try {
      let p = base + nodeOff;
      const term = r.uleb(p, 10, end); p = term.next;
      const terminalSize = Number(term.value);
      if (!Number.isSafeInteger(terminalSize) || terminalSize < 0 || p + terminalSize > end) { markPartial('terminal payload is truncated'); return; }
      const terminalEnd = p + terminalSize;
      if (term.value) {
        const flagsX = r.uleb(p, 10, terminalEnd); p = flagsX.next; const flags = Number(flagsX.value);
        if (flags & 0x08) {
          const ord = r.uleb(p, 10, terminalEnd); p = ord.next; const importedX = rawCString(r, p, terminalEnd);
          image.exports.push({ name: prefix, address: 0n, kind: 'reexport', flags, ordinal: Number(ord.value), imported: importedX.text || null, source: 'exports-trie' });
        } else {
          const addrX = r.uleb(p, 10, terminalEnd); p = addrX.next; const exportKind = flags & 0x03;
          const address = exportKind === 0 ? image.imageBase + addrX.value : addrX.value;
          const kind = exportKind === 1 ? 'thread-local' : exportKind === 2 ? 'absolute' : 'export';
          const ex = { name: prefix, address, kind, flags, source: 'exports-trie' };
          if (flags & 0x10) { const resolverX = r.uleb(p, 10, terminalEnd); p = resolverX.next; ex.resolver = image.imageBase + resolverX.value; }
          if(!budget.take({objects:1,operations:1,stringBytes:prefix.length*2,estimatedHeapBytes:prefix.length*2+160},'export-trie-output')){markPartial('shared metadata output budget exceeded','budgetExceeded');return;} image.exports.push(ex);
          if (exportKind === 0) { const sec = image.sectionAt(address); if (sec && sec.perms.execute) if(!budget.take({objects:1,operations:1,estimatedHeapBytes:128},'export-function')){markPartial('shared metadata function budget exceeded','budgetExceeded');return;} image.functions.push(functionSeed(address, { name: prefix, source: 'export', confidence: 0.9 })); }
        }
      }
      p = terminalEnd; if (p >= end) return;
      const children = r.u8(p++);
      for (let i = 0; i < children; i++) {
        if(!budget.take({records:1,operations:1,estimatedHeapBytes:32},'export-trie-edge')){markPartial('shared metadata edge budget exceeded','budgetExceeded');return;} status.edges++;
        const edgeX = rawCString(r, p, end); const edge = edgeX.text; p = edgeX.next;
        if (p >= end) { markPartial('child offset is truncated'); return; }
        const child = r.uleb(p, 10, end); p = child.next; walk(Number(child.value), prefix + edge, depth + 1);
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