from pathlib import Path
import re


def replace_once(s, old, new, label):
    if old not in s: raise SystemExit(f'{label} anchor missing')
    return s.replace(old,new,1)

def sub_once(s, pattern, repl, label, flags=0):
    out,n=re.subn(pattern,repl,s,count=1,flags=flags)
    if n!=1: raise SystemExit(f'{label} regex matched {n}')
    return out

def fn_slice(s,start_marker,next_marker):
    a=s.index(start_marker); b=s.index(next_marker,a); return a,b,s[a:b]

p=Path('js/binary/macho.js'); s=p.read_text()
if "./macho-budget.js" not in s:
    s=s.replace("from './macho-dyld.js';", "from './macho-dyld.js';\nimport { ensureMachOMetadataBudget } from './macho-budget.js';",1)
s=sub_once(s,r"(const image\s*=\s*new BinaryImage\([\s\S]*?\);\n)",r"\1  const metadataBudget = ensureMachOMetadataBudget(image);\n",'budget construction')
s=replace_once(s,"    commands.push({ cmd, offset: p, size: cmdsize });","    if (!metadataBudget.take({ inputBytes:cmdsize, records:1, objects:1, operations:1, estimatedHeapBytes:64 }, 'load-command')) break;\n    commands.push({ cmd, offset: p, size: cmdsize });",'load command budget')
for old,new in {
 "parseSymbolTable(r, st, image, bits);":"parseSymbolTable(r, st, image, bits, metadataBudget);",
 "parseFunctionStarts(r, linkeditData.functionStarts, image);":"parseFunctionStarts(r, linkeditData.functionStarts, image, metadataBudget);",
 "parseChainedImports(r, linkeditData.chainedFixups, image);":"parseChainedImports(r, linkeditData.chainedFixups, image, metadataBudget);",
 "parseChainedBindingSites(r, linkeditData.chainedFixups, image, chainedImports, segmentOrder);":"parseChainedBindingSites(r, linkeditData.chainedFixups, image, chainedImports, segmentOrder, metadataBudget);",
 "parseClassicBindings(r, info.bind, image, segmentOrder, 'bind');":"parseClassicBindings(r, info.bind, image, segmentOrder, 'bind', metadataBudget);",
 "parseClassicBindings(r, info.weakBind, image, segmentOrder, 'weak-bind');":"parseClassicBindings(r, info.weakBind, image, segmentOrder, 'weak-bind', metadataBudget);",
 "parseClassicBindings(r, info.lazyBind, image, segmentOrder, 'lazy-bind');":"parseClassicBindings(r, info.lazyBind, image, segmentOrder, 'lazy-bind', metadataBudget);",
 "parseExportTrie(r, info.export, image);":"parseExportTrie(r, info.export, image, metadataBudget);",
 "parseExportTrie(r, linkeditData.exportsTrie, image);":"parseExportTrie(r, linkeditData.exportsTrie, image, metadataBudget);",
}.items(): s=s.replace(old,new)
old="""  const namesByAddr = new Map();
  for (const sym of image.symbols) if (sym.defined && sym.address) namesByAddr.set(sym.address.toString(), sym.name);
  for (const ex of image.exports) if (ex.address) namesByAddr.set(ex.address.toString(), ex.name);"""
new="""  const namesByAddr = new Map();
  const nameIndexEntries = image.symbols.length + image.exports.length;
  if (metadataBudget.take({ objects:nameIndexEntries, operations:nameIndexEntries, estimatedHeapBytes:nameIndexEntries*48 }, 'name-address-index')) {
    for (const sym of image.symbols) if (sym.defined && sym.address) namesByAddr.set(sym.address.toString(), sym.name);
    for (const ex of image.exports) if (ex.address) namesByAddr.set(ex.address.toString(), ex.name);
  }"""
if old in s: s=s.replace(old,new,1)
s=s.replace("if (sec && sec.perms.execute && sym.name !== '__mh_execute_header') image.functions.push(functionSeed(sym.address, { name: sym.name, source: 'symbol', confidence: 0.9 }));","if (sec && sec.perms.execute && sym.name !== '__mh_execute_header' && metadataBudget.take({ objects:1, operations:1, estimatedHeapBytes:128 }, 'symbol-function-fallback')) image.functions.push(functionSeed(sym.address, { name: sym.name, source: 'symbol', confidence: 0.9 }));")
s=replace_once(s,"  return image.finalize();\n}","  image.metadata.machoMetadata = metadataBudget.snapshot();\n  return image.finalize();\n}",'budget snapshot')
s=s.replace('function parseSymbolTable(r, st, image, bits) {','function parseSymbolTable(r, st, image, bits, sharedBudget = null) {\n  const budget = ensureMachOMetadataBudget(image, sharedBudget);',1)
a,b,part=fn_slice(s,'function parseSymbolTable(', '\nfunction parseFunctionStarts')
part=sub_once(part,r"for \(let i = 0; i < st\.nsyms; i\+\+\) \{","for (let i = 0; i < st.nsyms; i++) {\n    if (!budget.take({ inputBytes:ent, records:1, objects:1, operations:2, estimatedHeapBytes:224 }, 'symbol-record')) break;",'symbol loop')
part=sub_once(part,r"(const name\s*=\s*strx < st\.strsize \? r\.cstring\([^\n]+\) : '';\n\s*if \(!name\) continue;)",r"\1\n    if (!budget.take({ stringBytes:name.length*2, estimatedHeapBytes:name.length*2+32 }, 'symbol-name')) break;",'symbol name')
part=part.replace("if (undefinedSymbol) image.imports.push(","if (undefinedSymbol && budget.take({ objects:1, operations:1, estimatedHeapBytes:160 }, 'symbol-import')) image.imports.push(")
part=part.replace("if (defined && external && address) image.exports.push(","if (defined && external && address && budget.take({ objects:1, operations:1, estimatedHeapBytes:144 }, 'symbol-export')) image.exports.push(")
s=s[:a]+part+s[b:]
s=s.replace('function parseFunctionStarts(r, dc, image) {','function parseFunctionStarts(r, dc, image, sharedBudget = null) {\n  const budget = ensureMachOMetadataBudget(image, sharedBudget);',1)
a,b,part=fn_slice(s,'function parseFunctionStarts(', '\nfunction dylibForOrdinal')
part=sub_once(part,r"while \(p < end\) \{","while (p < end) {\n    if (!budget.take({ records:1, operations:1, estimatedHeapBytes:32 }, 'function-start-record')) { status.complete=false; status.partialReason='metadata-budget'; break; }",'function starts loop')
part=part.replace("image.functions.push(functionSeed(addr, { source: 'function_starts', confidence: 0.995 }));","if (!budget.take({ inputBytes:x.bytes, objects:1, estimatedHeapBytes:128 }, 'function-start-output')) { status.complete=false; status.partialReason='metadata-budget'; break; }\n    image.functions.push(functionSeed(addr, { source: 'function_starts', confidence: 0.995 }));")
s=s[:a]+part+s[b:]
p.write_text(s)

p=Path('js/binary/macho-dyld.js'); s=p.read_text()
if "./macho-budget.js" not in s: s="import { ensureMachOMetadataBudget } from './macho-budget.js';\n"+s
s=sub_once(s,r"export function parseChainedImports\([^)]*\)\s*\{","export function parseChainedImports(r,dc,image,sharedBudget=null){\n  const budget=ensureMachOMetadataBudget(image,sharedBudget);",'chained imports signature')
a,b,part=fn_slice(s,'export function parseChainedImports', '\nexport function parseChainedBindingSites')
part=sub_once(part,r"for\s*\(\s*let i\s*=\s*0\s*;\s*i\s*<\s*importsCount\s*;\s*i\+\+\s*\)\s*\{","for(let i=0;i<importsCount;i++){\n    if(!budget.take({inputBytes:entrySize,records:1,objects:1,operations:2,estimatedHeapBytes:224},'chained-import-record')){image.metadata.chainedFixups.importsComplete=false;image.metadata.chainedFixups.importsPartialReason='metadata-budget';break;}",'chained import loop')
part=sub_once(part,r"(const name\s*=\s*r\.cstring\([^;]+;\s*if\s*\(!name\)\s*continue;)",r"\1\n    if(!budget.take({stringBytes:name.length*2,estimatedHeapBytes:name.length*2+32},'chained-import-name'))break;",'chained import name')
part=part.replace('image.imports.push(imp);parsed[i]=imp;',"if(!budget.take({objects:1,operations:1,estimatedHeapBytes:160},'chained-import-output')){image.metadata.chainedFixups.importsComplete=false;break;}image.imports.push(imp);parsed[i]=imp;")
s=s[:a]+part+s[b:]
s=sub_once(s,r"export function parseChainedBindingSites\([^)]*\)\s*\{","export function parseChainedBindingSites(r,dc,image,imports,segments=image.segments||[],sharedBudget=null){\n  const budget=ensureMachOMetadataBudget(image,sharedBudget);",'chained sites signature')
a,b,part=fn_slice(s,'export function parseChainedBindingSites', '\nfunction chainedPointerWidth')
part=sub_once(part,r"for \(let page = 0; page < pageCount; page\+\+\) \{","for (let page = 0; page < pageCount; page++) {\n      if(!budget.take({inputBytes:2,records:1,operations:1,estimatedHeapBytes:16},'chained-page')){fail('shared metadata budget exhausted while decoding pages');status.bindingSites=decoded;return status;}",'chained page loop')
# Width is computed inside the pointer loop on current main; account the maximum pointer width before the read.
part=sub_once(part,r"for \(let guard = 0; guard < 100000; guard\+\+\) \{","for (let guard = 0; guard < 100000; guard++) {\n          if(!budget.take({inputBytes:8,records:1,operations:1,estimatedHeapBytes:16},'chained-pointer')){fail('shared metadata budget exhausted while decoding pointer chain');status.bindingSites=decoded;return status;}",'chained pointer loop')
part=part.replace("imports[d.ordinal].sites.push({ address, offset: expectedOff, kind: 'chained-bind', pointerFormat, addend: d.addend });","if(!budget.take({objects:1,operations:1,estimatedHeapBytes:112},'chained-bind-site')){fail('shared metadata budget exhausted while recording bind site');status.bindingSites=decoded;return status;}\n            imports[d.ordinal].sites.push({ address, offset: expectedOff, kind: 'chained-bind', pointerFormat, addend: d.addend });")
s=s[:a]+part+s[b:]
s=sub_once(s,r"export function parseClassicBindings\([^)]*\)\s*\{","export function parseClassicBindings(r,dc,image,segments,source,sharedBudget=null){\n  const budget=ensureMachOMetadataBudget(image,sharedBudget);",'classic signature')
a,b,part=fn_slice(s,'export function parseClassicBindings', '\nexport function parseExportTrie')
part=sub_once(part,r"while \(p < end\) \{","while (p < end) {\n    if(!budget.take({inputBytes:1,records:1,operations:1,estimatedHeapBytes:8},'classic-bind-opcode')){fail('shared metadata budget exhausted while decoding bind stream');break;}",'classic opcode loop')
pat=r"if \(a\.value > 10_000_000n\) \{ fail\('bind repeat count exceeds budget'\); break; \}\s*for \(let i = 0n; i < a\.value; i\+\+\) \{ bind\(\); segOffset \+= ptrSize \+ b\.value; \}"
repl="""if(a.value>BigInt(Number.MAX_SAFE_INTEGER)){fail('bind repeat count exceeds safe integer range');break;}
      const repeat=Number(a.value),step=ptrSize+b.value,owner=segments[segIndex];
      const maxBySegment=owner&&step>0n&&segOffset>=0n&&segOffset+ptrSize<=owner.size?Number(((owner.size-segOffset-ptrSize)/step)+1n):0;
      const maxByBudget=Math.min(budget.remaining('operations'),Math.floor(budget.remaining('objects')/2));
      const allowed=Math.max(0,Math.min(repeat,maxBySegment,maxByBudget));
      for(let i=0;i<allowed;i++){bind();segOffset+=step;}
      if(allowed<repeat){fail(`bind repeat count ${repeat} exceeds segment/shared metadata capacity ${allowed}`);break;}"""
part,n=re.subn(pat,repl,part,count=1)
if n!=1: raise SystemExit(f'classic repeat matched {n}')
part=part.replace('image.imports.push(imp); status.decodedBinds++;',"if(!budget.take({objects:2,operations:1,estimatedHeapBytes:320},'classic-bind-output')){fail('shared metadata budget exhausted while recording bind');return;}\n    image.imports.push(imp); status.decodedBinds++;")
s=s[:a]+part+s[b:]
s=sub_once(s,r"export function parseExportTrie\([^)]*\)\s*\{","export function parseExportTrie(r,dc,image,sharedBudget=null){\n  const budget=ensureMachOMetadataBudget(image,sharedBudget);",'export trie signature')
a,b,part=fn_slice(s,'export function parseExportTrie', '\nfunction normalizeSpecialDylibOrdinal')
part=part.replace("if (++status.nodes > 1_000_000) { markPartial('node budget exceeded', 'budgetExceeded'); return; }","if(!budget.take({records:1,objects:1,operations:1,estimatedHeapBytes:48},'export-trie-node')){markPartial('shared metadata node budget exceeded','budgetExceeded');return;} status.nodes++;")
part=part.replace("if (++status.edges > 2_000_000) { markPartial('edge budget exceeded', 'budgetExceeded'); return; }","if(!budget.take({records:1,operations:1,estimatedHeapBytes:32},'export-trie-edge')){markPartial('shared metadata edge budget exceeded','budgetExceeded');return;} status.edges++;")
part=part.replace('image.exports.push(ex);',"if(!budget.take({objects:1,operations:1,stringBytes:prefix.length*2,estimatedHeapBytes:prefix.length*2+160},'export-trie-output')){markPartial('shared metadata output budget exceeded','budgetExceeded');return;} image.exports.push(ex);")
part=part.replace("image.functions.push(functionSeed(address, { name: prefix, source: 'export', confidence: 0.9 }));","if(!budget.take({objects:1,operations:1,estimatedHeapBytes:128},'export-function')){markPartial('shared metadata function budget exceeded','budgetExceeded');return;} image.functions.push(functionSeed(address, { name: prefix, source: 'export', confidence: 0.9 }));")
s=s[:a]+part+s[b:]
p.write_text(s)
print('applied issue #570 v3')
