from pathlib import Path

# Keep the App/ObjC part of the staging script; AI/Product are patched against
# the current virtual-list implementation below.
p=Path('tools/fix-app-product-529-531-541-543-544-545-546.py')
s=p.read_text()
marker='# AI: capability-aware instruction alignment + whole symbol inventory search with completeness metadata.'
if marker in s:
    s=s.split(marker,1)[0].rstrip()+"\n"
p.write_text(s)

# #543/#544: capability-aware rows and full-inventory function search while
# preserving the array return contract used by the planner.
p=Path('js/ai/ui/hex-context.js'); s=p.read_text()
old="""function fixedRows(app) {
  const arch = String(app.store.get('architecture') || 'arm64').toLowerCase();
  return /arm64|aarch64/.test(arch) || !!app.store.get('canDisassemble');
}"""
new="""function fixedRows(app) {
  return !!app.store.get('canDisassemble') && Number(app.store.get('instructionAlignment') || app.store.get('capability')?.instructionAlignment || 0) > 0;
}
function instructionBytes(app) {
  return Math.max(1, Number(app.store.get('instructionAlignment') || app.store.get('capability')?.instructionAlignment || 4));
}"""
if old not in s: raise SystemExit('AI fixedRows anchor changed')
s=s.replace(old,new,1)
s=s.replace("  const startRow = Number((start - region.vmAddr) / 4n);\n  const totalRows = Number(region.size / 4n);", "  const step=BigInt(instructionBytes(app));\n  if ((start-region.vmAddr)%step !== 0n) return null;\n  const startRow = Number((start - region.vmAddr) / step);\n  const totalRows = Number(region.size / step);",1)
s=s.replace("? Math.min(totalRows - 1, Number((fn.end - region.vmAddr) / 4n) - 1)", "? Math.min(totalRows - 1, Number((fn.end - region.vmAddr) / step) - 1)",1)
old="""    get candidateFunctions() {
      const addr = safeCurrentFunction(app);
      return addr == null ? [] : [addr];
    },"""
new="""    get candidateFunctions() {
      const ranked=app.recognition?.records;
      if (Array.isArray(ranked) && ranked.length) return ranked.slice(0,5000).map((item)=>item.address);
      const addr = safeCurrentFunction(app);
      return addr == null ? [] : [addr];
    },"""
s=s.replace(old,new,1)
old="""    searchFunctions(query, options = {}) {
      const limit = Math.max(1, Math.min(200, Number(options.limit) || 40));
      const sym = app.symbols;
      if (!sym || !Array.isArray(sym.names)) return [];
      const q = String(query || '').toLowerCase();
      const out = [];
      for (let i = 0; i < sym.names.length && out.length < limit; i++) {
        const name = String(sym.names[i] || '');
        if (q && !name.toLowerCase().includes(q)) continue;
        out.push({ addr: sym.addrs[i], name });
      }
      return out;
    },"""
new="""    searchFunctions(query, options = {}) {
      const limit = Math.max(1, Math.min(200, Number(options.limit) || 40));
      const sym = app.symbols;
      if (!sym || !Array.isArray(sym.names)) return [];
      const q = String(query || '').toLowerCase();
      const maxScan=Math.min(sym.names.length,1_000_000), out=[];
      let matches=0;
      for (let i = 0; i < maxScan; i++) {
        const name = String(sym.names[i] || '');
        if (q && !name.toLowerCase().includes(q)) continue;
        matches++;
        if(out.length<limit) out.push({ addr: sym.addrs[i], name });
      }
      out.complete=maxScan===sym.names.length && matches<=limit;
      out.scannedCount=maxScan; out.total=sym.names.length; out.matchCount=matches;
      out.truncationReason=maxScan<sym.names.length?'scan-budget':matches>limit?'result-limit':null;
      out.coverage=sym.names.length?maxScan/sym.names.length:1;
      return out;
    },"""
if old not in s: raise SystemExit('AI searchFunctions anchor changed')
s=s.replace(old,new,1)
old="""    rowOfAddress: (a) => (region && a != null ? Number((a - region.vmAddr) / 4n) : null),
    addrOfRow: (row) => (region ? region.vmAddr + BigInt(row) * 4n : null),"""
new="""    rowOfAddress: (a) => (region && a != null ? Number((a - region.vmAddr) / BigInt(instructionBytes(app))) : null),
    addrOfRow: (row) => (region ? region.vmAddr + BigInt(row) * BigInt(instructionBytes(app)) : null),"""
if old not in s: raise SystemExit('AI pseudocode row anchor changed')
s=s.replace(old,new,1)
p.write_text(s)

# #541/#543/#545/#546: retain Product's VirtualList contract, but source it from
# canonical recognition when available, bound expensive string materialization,
# propagate completeness, and refuse unverified function ranges.
p=Path('js/ui/product.js'); s=p.read_text()
old="""function architectureOf(app) {
  const info = app?.store?.get?.('fileInfo') || {};
  const value = app?.capabilities?.architecture || app?.backend?.capabilities?.architecture || info.architecture || info.arch || info.cpu || 'arm64';
  return String(value).toLowerCase();
}

function fixedArm64Rows(app) {
  return /arm64|aarch64/.test(architectureOf(app));
}"""
new="""function architectureOf(app) {
  const capability=app?.store?.get?.('capability') || {};
  const info = app?.store?.get?.('fileInfo') || {};
  const value = capability.architecture || app?.store?.get?.('architecture') || info.architecture || info.arch || info.cpu || 'unknown';
  return String(value).toLowerCase();
}
function instructionBytes(app) { return Math.max(1,Number(app?.store?.get?.('instructionAlignment') || app?.store?.get?.('capability')?.instructionAlignment || 4)); }
function fixedArm64Rows(app) { return !!app?.store?.get?.('canDisassemble') && instructionBytes(app)>0; }
const EXPLORER_SOURCE_LIMIT=50000;
function annotateCollection(items,{complete=true,total=items?.length||0,scannedCount=items?.length||0,truncationReason=null,provenance='canonical-app-state'}={}) {
  if(items && typeof items==='object'){items.complete=!!complete;items.total=total;items.scannedCount=scannedCount;items.truncationReason=truncationReason;items.provenance=provenance;}
  return items;
}"""
if old not in s: raise SystemExit('Product architecture anchor changed')
s=s.replace(old,new,1)
# Replace functionSource, preserving virtual-source object API.
a=s.index('function functionSource(app) {')
b=s.index('\nfunction matchingFunctionItems',a)
new_fn="""function functionSource(app) {
  void app.ensureRecognition?.({maxFunctions:350000});
  const ranked=app.recognition?.records;
  if(Array.isArray(ranked) && ranked.length){
    const count=Math.min(ranked.length,EXPLORER_SOURCE_LIMIT);
    return {
      length:count, complete:app.recognition.complete===true && ranked.length<=EXPLORER_SOURCE_LIMIT,
      total:app.recognition.total, scannedCount:app.recognition.scannedCount,
      truncationReason:ranked.length>EXPLORER_SOURCE_LIMIT?'explorer-source-budget':app.recognition.truncationReason,
      provenance:'recognition/classifier+knowledge',
      itemAt(index){const item=ranked[index];return {addr:item.address,name:item.name||functionName(app,item.address),classification:item.classification,recognitionScore:item.score,recognitionConfidence:item.confidence};}
    };
  }
  const sym = app.symbols;
  const funcs = sym?.funcs || [];
  const total=funcs.length, count=Math.min(total,EXPLORER_SOURCE_LIMIT);
  return {
    length:count, complete:count===total,total,scannedCount:count,truncationReason:count===total?null:'explorer-source-budget',provenance:'symbol-index',
    itemAt(index){const addr=funcs[index],next=index+1<total?funcs[index+1]:null,exact=sym?.exact?.(addr);return {addr,name:exact?.name||functionName(app,addr),size:next!=null&&next>addr?next-addr:null,classification:'UNKNOWN'};}
  };
}"""
s=s[:a]+new_fn+s[b:]
# Whole-function search, bounded only on returned results and with completeness metadata.
a=s.index('function matchingFunctionItems(app, query) {')
b=s.index('\nfunction sectionItems',a)
new_match="""function matchingFunctionItems(app, query) {
  const q=String(query||'').trim().toLowerCase();
  if(!q)return functionSource(app);
  const sym=app.symbols;if(!sym)return [];
  const out=[],seen=new Set(),names=Array.isArray(sym.names)?sym.names:[],addrs=sym.addrs||[];
  const maxScan=Math.min(names.length,1_000_000);let matches=0;
  const add=(addr,name)=>{if(addr==null||!sym.isFunctionStart?.(addr))return;const key=addr.toString();if(seen.has(key))return;seen.add(key);matches++;if(out.length<EXPLORER_SOURCE_LIMIT)out.push({addr,name:name||functionName(app,addr)});};
  for(let i=0;i<maxScan&&i<addrs.length;i++){const name=String(names[i]||'');if(name.toLowerCase().includes(q))add(addrs[i],name);}
  for(const [rawAddr,name] of sym.renames||[]){if(String(name||'').toLowerCase().includes(q)){try{add(BigInt(rawAddr),name);}catch{}}}
  const sub=/^sub_?([0-9a-f]+)$/i.exec(q);if(sub){try{add(BigInt('0x'+sub[1]),null);}catch{}}
  out.sort((x,y)=>x.addr<y.addr?-1:x.addr>y.addr?1:0);
  return annotateCollection(out,{complete:maxScan===names.length&&matches<=EXPLORER_SOURCE_LIMIT,total:names.length,scannedCount:maxScan,truncationReason:maxScan<names.length?'scan-budget':matches>EXPLORER_SOURCE_LIMIT?'result-limit':null,provenance:'full-symbol-search'});
}"""
s=s[:a]+new_match+s[b:]
# Bounded string scan; do not allocate full filtered copies.
a=s.index('async function stringItems(app, query) {')
b=s.index('\nfunction externalItems',a)
new_strings="""async function stringItems(app, query) {
  const rows=await app.ensureStrings() || [],q=String(query||'').trim().toLowerCase(),out=[];
  const maxScan=Math.min(rows.length,250000);let matches=0;
  for(let i=0;i<maxScan;i++){const row=rows[i];if(q&&!String(row.text||'').toLowerCase().includes(q))continue;matches++;if(out.length<EXPLORER_SOURCE_LIMIT)out.push(row);}
  return annotateCollection(out,{complete:rows.complete!==false&&maxScan===rows.length&&matches<=EXPLORER_SOURCE_LIMIT,total:rows.length,scannedCount:maxScan,truncationReason:maxScan<rows.length?'scan-budget':matches>EXPLORER_SOURCE_LIMIT?'result-limit':rows.complete===false?'upstream-incomplete':null,provenance:'decoded-string-index'});
}"""
s=s[:a]+new_strings+s[b:]
# Show incompleteness without breaking VirtualList.
old="""    virtual = new VirtualList({ items, rowHeight: 64, ariaLabel: text('索引の結果', 'Explorer results'), renderRow });
    content.append(virtual.root);"""
new="""    if(items.complete===false){content.append(h('div','ui-hint',text(`一部のみ表示: ${Number(items.scannedCount||0).toLocaleString()} / ${Number(items.total||0).toLocaleString()} を走査 (${items.truncationReason||'incomplete'})`,`Partial results: scanned ${Number(items.scannedCount||0).toLocaleString()} / ${Number(items.total||0).toLocaleString()} (${items.truncationReason||'incomplete'})`)));}
    virtual = new VirtualList({ items, rowHeight: 64, ariaLabel: text('索引の結果', 'Explorer results'), renderRow });
    content.append(virtual.root);"""
if old not in s: raise SystemExit('Product showRows anchor changed')
s=s.replace(old,new,1)
# Capability-sized address mapping.
s=s.replace("rowOfAddress: (a) => !region || a == null ? null : Number((a - region.vmAddr) / 4n),\n      addrOfRow: (row) => region ? region.vmAddr + BigInt(row) * 4n : null,", "rowOfAddress: (a) => !region || a == null ? null : Number((a - region.vmAddr) / BigInt(instructionBytes(app))),\n      addrOfRow: (row) => region ? region.vmAddr + BigInt(row) * BigInt(instructionBytes(app)) : null,",1)
# Function workspace trust boundary before analysis.
anchor="""  const tab = FUNCTION_TABS.some((x) => x.id === route.params.tab) ? route.params.tab : 'overview';"""
insert="""  const verifiedRange=app.validatedFunctionRange?.(addr);
  if(verifiedRange && !verifiedRange.ok){
    const s=screen(functionName(app,addr),{id:'function',subtitle:addressText(addr)});
    s.body.append(errorState(text('関数境界を検証できません','Function boundary could not be verified'),verifiedRange.reason||'unverified-function-range'));
    return {root:s.root};
  }
"""+anchor
if insert not in s:
    if anchor not in s: raise SystemExit('Product workspace trust anchor changed')
    s=s.replace(anchor,insert,1)
p.write_text(s)
