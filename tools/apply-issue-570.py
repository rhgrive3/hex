from pathlib import Path


def replace(path, old, new, label, count=1):
    p=Path(path); s=p.read_text()
    if old not in s: raise SystemExit(f'{label} anchor missing in {path}')
    p.write_text(s.replace(old,new,count))

# ---------------------------------------------------------------------------
# macho.js: construct one budget per thin image and thread it through every
# decoded metadata producer.
# ---------------------------------------------------------------------------
p=Path('js/binary/macho.js'); s=p.read_text()
s=s.replace("import { parseChainedImports, parseChainedBindingSites, parseClassicBindings, parseExportTrie } from './macho-dyld.js';", "import { parseChainedImports, parseChainedBindingSites, parseClassicBindings, parseExportTrie } from './macho-dyld.js';\nimport { createMachOMetadataBudget } from './macho-budget.js';",1)
anchor="""  const commands = [];
  const segmentOrder = [];"""
new="""  const metadataBudget = createMachOMetadataBudget(image, { signal: opts.signal, limits: opts.metadataLimits });
  const commands = [];
  const segmentOrder = [];"""
if anchor not in s: raise SystemExit('budget creation anchor missing')
s=s.replace(anchor,new,1)
s=s.replace("if (p + 8 > commandEnd) { image.warnings.push(`truncated load command ${i}`); break; }", "if (p + 8 > commandEnd) { metadataBudget.partial('load-command-truncated', `truncated load command ${i}`); break; }",1)
s=s.replace("""    if (cmdsize < 8 || p + cmdsize > commandEnd) {
      image.warnings.push(`invalid load command ${i} size ${cmdsize}`);
      break;
    }
    commands.push({ cmd, offset: p, size: cmdsize });""", """    if (cmdsize < 8 || p + cmdsize > commandEnd) {
      metadataBudget.partial('load-command-invalid', `invalid load command ${i} size ${cmdsize}`);
      break;
    }
    if (!metadataBudget.take({ inputBytes:cmdsize, records:1, objects:1, operations:1, estimatedHeapBytes:64 }, 'load-command')) break;
    commands.push({ cmd, offset: p, size: cmdsize });""",1)
s=s.replace("parseDylib(r, p, cmdsize, image, cmd === LC_ID_DYLIB);", "parseDylib(r, p, cmdsize, image, cmd === LC_ID_DYLIB, metadataBudget);",1)
s=s.replace("image.warnings.push(`load command 0x${cmd.toString(16)}: ${e.message}`);", "metadataBudget.warn(`load command 0x${cmd.toString(16)}: ${e.message}`);",1)
old="""  if (image.entrypoint != null && image.entrypoint !== 0n) image.functions.push(functionSeed(image.entrypoint, { source: 'entrypoint', confidence: 0.9 }));

  for (const st of symtabs) parseSymbolTable(r, st, image, bits);
  const hadFunctionStarts = !!linkeditData.functionStarts;
  if (linkeditData.functionStarts) parseFunctionStarts(r, linkeditData.functionStarts, image);
  let chainedImports = null;
  if (linkeditData.chainedFixups) chainedImports = parseChainedImports(r, linkeditData.chainedFixups, image);
  if (linkeditData.chainedFixups && chainedImports) parseChainedBindingSites(r, linkeditData.chainedFixups, image, chainedImports, segmentOrder);
  for (const info of dyldInfos) {
    parseClassicBindings(r, info.bind, image, segmentOrder, 'bind');
    parseClassicBindings(r, info.weakBind, image, segmentOrder, 'weak-bind');
    parseClassicBindings(r, info.lazyBind, image, segmentOrder, 'lazy-bind');
    if (!linkeditData.exportsTrie && info.export.size) parseExportTrie(r, info.export, image);
  }
  if (linkeditData.exportsTrie) parseExportTrie(r, linkeditData.exportsTrie, image);"""
new="""  if (image.entrypoint != null && image.entrypoint !== 0n && metadataBudget.take({ objects:1, operations:1, estimatedHeapBytes:128 }, 'entrypoint-function')) image.functions.push(functionSeed(image.entrypoint, { source: 'entrypoint', confidence: 0.9 }));

  for (const st of symtabs) parseSymbolTable(r, st, image, bits, metadataBudget);
  const hadFunctionStarts = !!linkeditData.functionStarts;
  if (linkeditData.functionStarts) parseFunctionStarts(r, linkeditData.functionStarts, image, metadataBudget);
  let chainedImports = null;
  if (linkeditData.chainedFixups) chainedImports = parseChainedImports(r, linkeditData.chainedFixups, image, metadataBudget);
  if (linkeditData.chainedFixups && chainedImports) parseChainedBindingSites(r, linkeditData.chainedFixups, image, chainedImports, segmentOrder, metadataBudget);
  for (const info of dyldInfos) {
    parseClassicBindings(r, info.bind, image, segmentOrder, 'bind', metadataBudget);
    parseClassicBindings(r, info.weakBind, image, segmentOrder, 'weak-bind', metadataBudget);
    parseClassicBindings(r, info.lazyBind, image, segmentOrder, 'lazy-bind', metadataBudget);
    if (!linkeditData.exportsTrie && info.export.size) parseExportTrie(r, info.export, image, metadataBudget);
  }
  if (linkeditData.exportsTrie) parseExportTrie(r, linkeditData.exportsTrie, image, metadataBudget);"""
if old not in s: raise SystemExit('metadata parser call anchor missing')
s=s.replace(old,new,1)
old="""  const namesByAddr = new Map();
  for (const sym of image.symbols) if (sym.defined && sym.address) namesByAddr.set(sym.address.toString(), sym.name);
  for (const ex of image.exports) if (ex.address) namesByAddr.set(ex.address.toString(), ex.name);"""
new="""  const namesByAddr = new Map();
  const indexCost = image.symbols.length + image.exports.length;
  if (metadataBudget.take({ objects:indexCost, operations:indexCost, estimatedHeapBytes:indexCost*48 }, 'name-address-index')) {
    for (const sym of image.symbols) if (sym.defined && sym.address) namesByAddr.set(sym.address.toString(), sym.name);
    for (const ex of image.exports) if (ex.address) namesByAddr.set(ex.address.toString(), ex.name);
  }"""
if old not in s: raise SystemExit('name index anchor missing')
s=s.replace(old,new,1)
old="""      if (sec && sec.perms.execute && sym.name !== '__mh_execute_header') image.functions.push(functionSeed(sym.address, { name: sym.name, source: 'symbol', confidence: 0.9 }));"""
new="""      if (sec && sec.perms.execute && sym.name !== '__mh_execute_header') {
        if (!metadataBudget.take({ objects:1, operations:1, estimatedHeapBytes:128 }, 'symbol-function-fallback')) break;
        image.functions.push(functionSeed(sym.address, { name: sym.name, source: 'symbol', confidence: 0.9 }));
      }"""
if old not in s: raise SystemExit('symbol function fallback anchor missing')
s=s.replace(old,new,1)
s=s.replace("  return image.finalize();\n}", "  image.metadata.machoMetadata = metadataBudget.snapshot();\n  return image.finalize();\n}",1)
# Dylib strings use shared string/output budget.
s=s.replace('function parseDylib(r, p, cmdsize, image, isId) {', 'function parseDylib(r, p, cmdsize, image, isId, budget) {',1)
old="""  const name = r.cstring(p + nameoff, cmdsize - nameoff);
  if (isId) image.metadata.installName = name;
  else if (name) image.libraries.push(name);"""
new="""  const max = Math.min(cmdsize-nameoff, 1<<20, Math.max(1, Math.floor(budget.remainingStringBytes/2)+1));
  const name = r.cstring(p + nameoff, max);
  if (name && !budget.take({ stringBytes:name.length*2, objects:1, operations:1, estimatedHeapBytes:name.length*2+64 }, 'dylib-name')) return;
  if (isId) image.metadata.installName = name;
  else if (name) image.libraries.push(name);"""
if old not in s: raise SystemExit('dylib string anchor missing')
s=s.replace(old,new,1)
# Symbol table budget.
s=s.replace('function parseSymbolTable(r, st, image, bits) {', 'function parseSymbolTable(r, st, image, bits, budget) {',1)
old="""  for (let i = 0; i < st.nsyms; i++) {
    const p = st.symoff + i * ent;
    const strx = r.u32(p);"""
new="""  for (let i = 0; i < st.nsyms; i++) {
    if (!budget.take({ inputBytes:ent, records:1, objects:1, operations:2, estimatedHeapBytes:224 }, 'symbol-record')) { image.metadata.symbolTable = { complete:false, decoded:i, declared:st.nsyms, reason:'metadata-budget' }; break; }
    const p = st.symoff + i * ent;
    const strx = r.u32(p);"""
if old not in s: raise SystemExit('symbol loop anchor missing')
s=s.replace(old,new,1)
old="""    const name = strx < st.strsize ? r.cstring(st.stroff + strx, st.strsize - strx) : '';
    if (!name) continue;"""
new="""    const maxName = strx < st.strsize ? Math.min(st.strsize-strx, 1<<20, Math.max(1, Math.floor(budget.remainingStringBytes/2)+1)) : 0;
    const name = maxName ? r.cstring(st.stroff + strx, maxName) : '';
    if (!name) continue;
    if (!budget.take({ stringBytes:name.length*2, estimatedHeapBytes:name.length*2+32 }, 'symbol-name')) break;"""
if old not in s: raise SystemExit('symbol name anchor missing')
s=s.replace(old,new,1)
s=s.replace("if (undefinedSymbol) image.imports.push({ name, library: null, ordinal: null, source: 'LC_SYMTAB', sites: [] });", "if (undefinedSymbol && budget.take({ objects:1, operations:1, estimatedHeapBytes:160 }, 'symbol-import')) image.imports.push({ name, library: null, ordinal: null, source: 'LC_SYMTAB', sites: [] });",1)
s=s.replace("if (defined && external && address) image.exports.push({ name, address, kind: 'symbol', source: 'LC_SYMTAB' });", "if (defined && external && address && budget.take({ objects:1, operations:1, estimatedHeapBytes:144 }, 'symbol-export')) image.exports.push({ name, address, kind: 'symbol', source: 'LC_SYMTAB' });",1)
# Function starts budget.
s=s.replace('function parseFunctionStarts(r, dc, image) {', 'function parseFunctionStarts(r, dc, image, budget) {',1)
old="""  while (p < end) {
    let x;
    try { x = r.uleb(p, 10, end); }"""
new="""  while (p < end) {
    if (!budget.take({ records:1, operations:1, estimatedHeapBytes:32 }, 'function-start-record')) { status.complete=false; status.partialReason='metadata-budget'; break; }
    let x;
    try { x = r.uleb(p, 10, end); }"""
if old not in s: raise SystemExit('function start loop anchor missing')
s=s.replace(old,new,1)
old="""    image.functions.push(functionSeed(addr, { source: 'function_starts', confidence: 0.995 }));
    status.recovered++;"""
new="""    if (!budget.take({ inputBytes:x.bytes, objects:1, estimatedHeapBytes:128 }, 'function-start-output')) { status.complete=false; status.partialReason='metadata-budget'; break; }
    image.functions.push(functionSeed(addr, { source: 'function_starts', confidence: 0.995 }));
    status.recovered++;"""
if old not in s: raise SystemExit('function start output anchor missing')
s=s.replace(old,new,1)
p.write_text(s)

# ---------------------------------------------------------------------------
# macho-dyld.js: consume the same budget in chained/classic/export decoders.
# ---------------------------------------------------------------------------
p=Path('js/binary/macho-dyld.js'); s=p.read_text()
s="import { ensureMachOMetadataBudget } from './macho-budget.js';\n"+s
# Insert bounded string helper before first export.
anchor='export function parseChainedImports'
helper=r'''function budgetedRawCString(r, p, end, budget, label) {
  const maxByBudget = Math.floor(budget.remainingStringBytes / 2) + 1;
  const hardEnd = Math.min(end, p + Math.max(1, Math.min(1 << 20, maxByBudget)));
  let out;
  try { out = rawCString(r, p, hardEnd); }
  catch (e) {
    budget.partial(`${label}:string-budget-or-termination`, `${label}: ${e.message}`);
    return null;
  }
  if (!budget.take({ inputBytes:out.bytes, stringBytes:out.text.length*2, estimatedHeapBytes:out.text.length*2+32 }, `${label}-string`)) return null;
  return out;
}

'''
if anchor not in s: raise SystemExit('dyld helper insertion anchor missing')
s=s.replace(anchor,helper+anchor,1)
# Chained imports signature and budget.
s=s.replace('export function parseChainedImports(r, dc, image) {', 'export function parseChainedImports(r, dc, image, sharedBudget = null) {\n  const budget = ensureMachOMetadataBudget(image, sharedBudget);',1)
# Replace loop start.
old="""  for (let i = 0; i < importsCount; i++) {
    const p = importsStart + i * entrySize;
    let libOrdinal = 0, weak = false, nameOffset = 0, addend = 0n;"""
new="""  let decodedImports = 0;
  for (let i = 0; i < importsCount; i++) {
    if (!budget.take({ inputBytes:entrySize, records:1, objects:1, operations:2, estimatedHeapBytes:224 }, 'chained-import-record')) { image.metadata.chainedFixups ||= {}; image.metadata.chainedFixups.importsComplete=false; image.metadata.chainedFixups.importsPartialReason='metadata-budget'; break; }
    const p = importsStart + i * entrySize;
    let libOrdinal = 0, weak = false, nameOffset = 0, addend = 0n;"""
if old not in s: raise SystemExit('chained import loop anchor missing')
s=s.replace(old,new,1)
old="""    const np = symbolsStart + nameOffset;
    const name = np < dc.offset + dc.size ? r.cstring(np, dc.offset + dc.size - np) : '';
    if (!name) continue;
    const library = dylibForOrdinal(image, libOrdinal);
    const imp = { name, library, ordinal: libOrdinal, weak, addend, source: 'chained-fixups', sites: [] };
    image.imports.push(imp); parsed[i] = imp;"""
new="""    const np = symbolsStart + nameOffset;
    const nameX = np < dc.offset + dc.size ? budgetedRawCString(r,np,dc.offset+dc.size,budget,'chained import name') : null;
    const name = nameX?.text || '';
    if (!name) continue;
    const library = dylibForOrdinal(image, libOrdinal);
    const imp = { name, library, ordinal: libOrdinal, weak, addend, source: 'chained-fixups', sites: [] };
    image.imports.push(imp); parsed[i] = imp; decodedImports++;"""
if old not in s: raise SystemExit('chained import name anchor missing')
s=s.replace(old,new,1)
# Find return metadata block. We'll append before return parsed.
s=s.replace('  return parsed;\n}', "  image.metadata.chainedFixups ||= {};\n  image.metadata.chainedFixups.importsDecoded = decodedImports;\n  if (image.metadata.chainedFixups.importsComplete == null) image.metadata.chainedFixups.importsComplete = decodedImports === importsCount;\n  return parsed;\n}",1)
# Chained sites signature budget and warning fail helper.
s=s.replace('export function parseChainedBindingSites(r, dc, image, imports, segments = image.segments || []) {', 'export function parseChainedBindingSites(r, dc, image, imports, segments = image.segments || [], sharedBudget = null) {\n  const budget = ensureMachOMetadataBudget(image, sharedBudget);',1)
s=s.replace("    const warning = `chained-fixups: ${message}`;\n    if (!image.warnings.includes(warning)) image.warnings.push(warning);", "    const warning = `chained-fixups: ${message}`;\n    budget.warn(warning);",1)
# Page loop budget.
old="""    for (let page = 0; page < pageCount; page++) {
      const start = r.u16(p + 22 + page * 2);"""
new="""    for (let page = 0; page < pageCount; page++) {
      if (!budget.take({ records:1, operations:1, inputBytes:2, estimatedHeapBytes:16 }, 'chained-page')) { fail('shared metadata budget exhausted while decoding pages'); status.bindingSites=decoded; return status; }
      const start = r.u16(p + 22 + page * 2);"""
if old not in s: raise SystemExit('chained page loop anchor missing')
s=s.replace(old,new,1)
# Pointer loop budget.
old="""        for (let guard = 0; guard < 100000; guard++) {
          if (address < pageAddress || address + BigInt(width) > pageAddressEnd || address + BigInt(width) > fileBackedAddressEnd) {"""
new="""        for (let guard = 0; guard < 100000; guard++) {
          if (!budget.take({ inputBytes:width, records:1, operations:1, estimatedHeapBytes:16 }, 'chained-pointer')) { fail('shared metadata budget exhausted while decoding pointer chain'); status.bindingSites=decoded; return status; }
          if (address < pageAddress || address + BigInt(width) > pageAddressEnd || address + BigInt(width) > fileBackedAddressEnd) {"""
if old not in s: raise SystemExit('chained pointer loop anchor missing')
s=s.replace(old,new,1)
old="""            imports[d.ordinal].sites.push({ address, offset: expectedOff, kind: 'chained-bind', pointerFormat, addend: d.addend });
            decoded++;"""
new="""            if (!budget.take({ objects:1, operations:1, estimatedHeapBytes:112 }, 'chained-bind-site')) { fail('shared metadata budget exhausted while recording bind site'); status.bindingSites=decoded; return status; }
            imports[d.ordinal].sites.push({ address, offset: expectedOff, kind: 'chained-bind', pointerFormat, addend: d.addend });
            decoded++;"""
if old not in s: raise SystemExit('chained site output anchor missing')
s=s.replace(old,new,1)
# Classic bindings signature/budget.
s=s.replace('export function parseClassicBindings(r, dc, image, segments, source) {', 'export function parseClassicBindings(r, dc, image, segments, source, sharedBudget = null) {\n  const budget = ensureMachOMetadataBudget(image, sharedBudget);',1)
s=s.replace("    image.warnings.push(`${source}: ${message}`);", "    budget.warn(`${source}: ${message}`);",1)
# snapshot string/object output handled at bind.
old="""    const imp = snapshotImport();
    imp.sites.push({ address, offset: image.addressToOffset(address), kind: source, type, addend, weak: imp.weak });
    image.imports.push(imp); status.decodedBinds++;"""
new="""    if (!budget.take({ objects:2, operations:1, estimatedHeapBytes:320 }, 'classic-bind-output')) { fail('shared metadata budget exhausted while recording bind'); return; }
    const imp = snapshotImport();
    imp.sites.push({ address, offset: image.addressToOffset(address), kind: source, type, addend, weak: imp.weak });
    image.imports.push(imp); status.decodedBinds++;"""
if old not in s: raise SystemExit('classic bind output anchor missing')
s=s.replace(old,new,1)
# Threaded site output.
old="""          const imp = { ...template, sites: [{ address, offset: off, kind: 'threaded-bind', type: template.type, addend: template.addend, weak: template.weak }] };
          image.imports.push(imp); status.decodedBinds++;"""
new="""          if (!budget.take({ objects:2, operations:1, estimatedHeapBytes:320 }, 'threaded-bind-output')) { fail('shared metadata budget exhausted while recording threaded bind'); return; }
          const imp = { ...template, sites: [{ address, offset: off, kind: 'threaded-bind', type: template.type, addend: template.addend, weak: template.weak }] };
          image.imports.push(imp); status.decodedBinds++;"""
if old not in s: raise SystemExit('threaded bind output anchor missing')
s=s.replace(old,new,1)
# Main opcode loop operation budget.
old="""    while (p < end) {
    const byte = r.u8(p++);"""
new="""    while (p < end) {
    if (!budget.take({ inputBytes:1, records:1, operations:1, estimatedHeapBytes:8 }, 'classic-bind-opcode')) { fail('shared metadata budget exhausted while decoding bind stream'); break; }
    const byte = r.u8(p++);"""
if old not in s: raise SystemExit('classic opcode loop anchor missing')
s=s.replace(old,new,1)
# Symbol cstring budget.
old="""    else if (op === 0x40) { const x = rawCString(r, p, end); symbol = x.text; symbolFlags = imm; p = x.next; }"""
new="""    else if (op === 0x40) { const x = budgetedRawCString(r,p,end,budget,`${source} symbol`); if(!x){fail('symbol string exceeds shared metadata budget');break;} symbol = x.text; symbolFlags = imm; p = x.next; }"""
if old not in s: raise SystemExit('classic symbol anchor missing')
s=s.replace(old,new,1)
# Repeat prebound.
old="""      if (a.value > 10_000_000n) { fail('bind repeat count exceeds budget'); break; }
      for (let i = 0n; i < a.value; i++) { bind(); segOffset += ptrSize + b.value; }"""
new="""      if (a.value > BigInt(Number.MAX_SAFE_INTEGER)) { fail('bind repeat count exceeds safe integer range'); break; }
      const repeat = Number(a.value);
      const step = ptrSize + b.value;
      const seg = segments[segIndex];
      const bySegment = seg && step > 0n && segOffset >= 0n && segOffset + ptrSize <= seg.size
        ? Number(((seg.size - segOffset - ptrSize) / step) + 1n) : 0;
      const byWork = Math.min(budget.remaining('operations'), Math.floor(budget.remaining('objects') / 2));
      const allowed = Math.max(0, Math.min(repeat, bySegment, byWork));
      for (let i = 0; i < allowed; i++) { bind(); segOffset += step; }
      if (allowed < repeat) { fail(`bind repeat count ${repeat} exceeds segment/shared metadata capacity ${allowed}`); break; }"""
if old not in s: raise SystemExit('classic repeat anchor missing')
s=s.replace(old,new,1)
# Threaded table limit shared cap.
old="""        if (x.value > 65536n) { fail('threaded ordinal table exceeds 65536 entries'); break; }
        threadedTableLimit = Number(x.value); threadedTable = [];"""
new="""        const remaining = Math.min(65536, budget.remaining('objects'), budget.remaining('operations'));
        if (x.value > BigInt(remaining)) { fail(`threaded ordinal table exceeds shared metadata capacity ${remaining}`); break; }
        threadedTableLimit = Number(x.value); threadedTable = [];"""
if old not in s: raise SystemExit('threaded table anchor missing')
s=s.replace(old,new,1)
# Export trie signature/budget/warning.
s=s.replace('export function parseExportTrie(r, dc, image) {', 'export function parseExportTrie(r, dc, image, sharedBudget = null) {\n  const budget = ensureMachOMetadataBudget(image, sharedBudget);',1)
s=s.replace("const markPartial = (message, field) => { status.complete = false; if (field) status[field] = true; image.warnings.push(`exports trie: ${message}`); };", "const markPartial = (message, field) => { status.complete = false; if (field) status[field] = true; budget.partial(`export-trie:${field||'partial'}`, `exports trie: ${message}`); };",1)
# Node budget shared.
old="""    if (++status.nodes > 1_000_000) { markPartial('node budget exceeded', 'budgetExceeded'); return; }
    active.add(nodeOff);"""
new="""    if (!budget.take({ records:1, objects:1, operations:1, estimatedHeapBytes:48 }, 'export-trie-node')) { markPartial('shared metadata node budget exceeded', 'budgetExceeded'); return; }
    status.nodes++;
    active.add(nodeOff);"""
if old not in s: raise SystemExit('export node anchor missing')
s=s.replace(old,new,1)
# terminal output reexport.
old="""          image.exports.push({ name: prefix, address: 0n, kind: 'reexport', flags, ordinal: Number(ord.value), imported: importedX.text || null, source: 'exports-trie' });"""
new="""          if (!budget.take({ objects:1, operations:1, stringBytes:prefix.length*2, estimatedHeapBytes:prefix.length*2+160 }, 'export-trie-output')) { markPartial('shared metadata output budget exceeded','budgetExceeded'); return; }
          image.exports.push({ name: prefix, address: 0n, kind: 'reexport', flags, ordinal: Number(ord.value), imported: importedX.text || null, source: 'exports-trie' });"""
if old not in s: raise SystemExit('reexport output anchor missing')
s=s.replace(old,new,1)
# regular output + function.
old="""          image.exports.push(ex);
          if (exportKind === 0) { const sec = image.sectionAt(address); if (sec && sec.perms.execute) image.functions.push(functionSeed(address, { name: prefix, source: 'export', confidence: 0.9 })); }"""
new="""          if (!budget.take({ objects:1, operations:1, stringBytes:prefix.length*2, estimatedHeapBytes:prefix.length*2+160 }, 'export-trie-output')) { markPartial('shared metadata output budget exceeded','budgetExceeded'); return; }
          image.exports.push(ex);
          if (exportKind === 0) { const sec = image.sectionAt(address); if (sec && sec.perms.execute) { if (!budget.take({ objects:1, operations:1, estimatedHeapBytes:128 }, 'export-function')) { markPartial('shared metadata function budget exceeded','budgetExceeded'); return; } image.functions.push(functionSeed(address, { name: prefix, source: 'export', confidence: 0.9 })); } }"""
if old not in s: raise SystemExit('regular export output anchor missing')
s=s.replace(old,new,1)
# Edge budget + string helper.
old="""        if (++status.edges > 2_000_000) { markPartial('edge budget exceeded', 'budgetExceeded'); return; }
        const edgeX = rawCString(r, p, end); const edge = edgeX.text; p = edgeX.next;
        if (p >= end) { markPartial('child offset is truncated'); return; }
        const child = r.uleb(p, 10, end); p = child.next; walk(Number(child.value), prefix + edge, depth + 1);"""
new="""        if (!budget.take({ records:1, operations:1, estimatedHeapBytes:32 }, 'export-trie-edge')) { markPartial('shared metadata edge budget exceeded', 'budgetExceeded'); return; }
        status.edges++;
        const edgeX = budgetedRawCString(r,p,end,budget,'export trie edge'); if(!edgeX){markPartial('edge string exceeds shared metadata budget','budgetExceeded');return;} const edge = edgeX.text; p = edgeX.next;
        if (p >= end) { markPartial('child offset is truncated'); return; }
        const nextPrefix=prefix+edge;
        if (!budget.take({ stringBytes:nextPrefix.length*2, estimatedHeapBytes:nextPrefix.length*2+32 }, 'export-trie-prefix')) { markPartial('prefix string budget exceeded','budgetExceeded'); return; }
        const child = r.uleb(p, 10, end); p = child.next; walk(Number(child.value), nextPrefix, depth + 1);"""
if old not in s: raise SystemExit('export edge anchor missing')
s=s.replace(old,new,1)
p.write_text(s)
print('applied issue #570 Mach-O shared metadata budget')
