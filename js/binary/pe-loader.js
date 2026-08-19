import { functionSeed } from './model.js';

export const PE_METADATA_LIMITS = Object.freeze({
  inputBytes: 64 * 1024 * 1024,
  records: 250_000,
  objects: 500_000,
  stringBytes: 16 * 1024 * 1024,
  operations: 2_000_000,
  estimatedHeapBytes: 96 * 1024 * 1024,
  wallClockMs: 5_000,
});

function markPEPartial(image, reason, warning = null) {
  image.metadata ||= {};
  image.metadata.peMetadata ||= { complete: true, reasons: [] };
  image.metadata.peMetadata.complete = false;
  if (!image.metadata.peMetadata.reasons.includes(reason)) image.metadata.peMetadata.reasons.push(reason);
  if (warning && !image.warnings.includes(warning)) image.warnings.push(warning);
}

export function createPEMetadataBudget(image, options = {}) {
  image.metadata ||= {};
  const limits = { ...PE_METADATA_LIMITS, ...(options.limits || options.metadataLimits || {}) };
  const signal = options.signal || null;
  const started = Date.now();
  const used = { inputBytes:0, records:0, objects:0, stringBytes:0, operations:0, estimatedHeapBytes:0 };
  const meta = image.metadata.peMetadata ||= { complete:true, reasons:[] };
  meta.limits = { ...limits };
  meta.used = used;
  const fail = (reason) => { markPEPartial(image, `budget:${reason}`, `PE metadata budget exhausted: ${reason}`); return false; };
  const budget = {
    limits, used, signal,
    get remainingStringBytes() { return Math.max(0, limits.stringBytes - used.stringBytes); },
    take(cost = {}, reason = 'metadata') {
      if (signal?.aborted) return fail('aborted');
      const nextOps = used.operations + (cost.operations || 0);
      if ((nextOps & 1023) === 0 && Date.now() - started > limits.wallClockMs) return fail('wall-clock');
      for (const key of ['inputBytes','records','objects','stringBytes','operations','estimatedHeapBytes']) {
        const next = used[key] + (cost[key] || 0);
        if (!Number.isFinite(next) || next < 0 || next > limits[key]) return fail(`${reason}:${key}`);
      }
      for (const key of Object.keys(used)) used[key] += cost[key] || 0;
      return true;
    },
    partial(reason, warning = null) { markPEPartial(image, reason, warning); return false; },
  };
  return budget;
}

function ensureBudget(image, budget) { return budget || createPEMetadataBudget(image); }

export function mappedFileRangeForRva(image, rva) {
  if (!Number.isInteger(rva) || rva <= 0) return null;
  const address = image.imageBase + BigInt(rva);
  const owners = [...(image.sections || []), ...(image.segments || [])];
  for (const owner of owners) {
    if (!owner || owner.address == null || owner.fileOffset == null || owner.fileSize == null) continue;
    const fileSize = BigInt(owner.fileSize);
    if (fileSize <= 0n || address < owner.address || address >= owner.address + fileSize) continue;
    const delta = address - owner.address;
    const start = BigInt(owner.fileOffset) + delta;
    const end = BigInt(owner.fileOffset) + fileSize;
    if (start > BigInt(Number.MAX_SAFE_INTEGER) || end > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    return { start: Number(start), end: Number(end), owner, address };
  }
  return null;
}

export function mappedFileSpanForRva(image, rva, size) {
  if (!Number.isSafeInteger(size) || size < 0) return null;
  if (size === 0) return mappedFileRangeForRva(image, rva);
  const range = mappedFileRangeForRva(image, rva);
  if (!range || size > range.end - range.start) return null;
  return { ...range, spanEnd: range.start + size };
}

function mappedFileRangeForAddress(image, address) {
  const a = BigInt(address);
  if (a < image.imageBase || a - image.imageBase > 0xffffffffn) return null;
  return mappedFileRangeForRva(image, Number(a - image.imageBase));
}

function mappedCStringAtRva(r, image, rva, budget, label) {
  const range = mappedFileRangeForRva(image, rva);
  if (!range) { budget.partial(`${label}:unmapped-string`, `Ignored ${label} string outside a file-backed mapping`); return ''; }
  const maxByStringBudget = Math.max(1, Math.floor(budget.remainingStringBytes / 2) + 1);
  const max = Math.min(1 << 16, range.end - range.start, maxByStringBudget);
  if (max <= 0) return '';
  const value = r.cstring(range.start, max);
  const inputBytes = Math.min(max, value.length + 1);
  if (!budget.take({ inputBytes, stringBytes:value.length*2, operations:1, estimatedHeapBytes:value.length*2+32 }, `${label}-string`)) return '';
  return value;
}

function mappedCStringAtOffset(r, start, end, budget, label) {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= end || end > r.length) return '';
  const max = Math.min(1 << 16, end-start, Math.max(1, Math.floor(budget.remainingStringBytes/2)+1));
  const value = r.cstring(start,max);
  if (!budget.take({ inputBytes:Math.min(max,value.length+1), stringBytes:value.length*2, operations:1, estimatedHeapBytes:value.length*2+32 }, `${label}-string`)) return '';
  return value;
}

function markImportPartial(image, message) {
  image.metadata.peImports ||= { complete: true, truncatedTables: 0 };
  image.metadata.peImports.complete = false;
  image.metadata.peImports.truncatedTables++;
  markPEPartial(image, 'imports-partial', message);
}

export function parseImports(r, dir, image, sharedBudget = null) {
  if (!dir || !dir.rva || !dir.size) return;
  const budget = ensureBudget(image, sharedBudget);
  image.metadata.peImports ||= { complete: true, truncatedTables: 0 };
  const dirRange = mappedFileSpanForRva(image, dir.rva, dir.size);
  if (!dirRange) { markImportPartial(image, 'PE import directory crosses a mapped RVA/file boundary'); return; }
  let off = dirRange.start;
  const end = dirRange.spanEnd;
  const ptrSize = image.bits === 64 ? 8 : 4;
  let terminatedDescriptors = false;
  for (let guard = 0; guard < 65536 && off + 20 <= end; guard++, off += 20) {
    if (!budget.take({inputBytes:20,records:1,operations:1,estimatedHeapBytes:32},'import-descriptor')) break;
    const originalFirstThunk = r.u32(off), timeDateStamp = r.u32(off+4), forwarderChain = r.u32(off+8);
    const nameRva = r.u32(off+12), firstThunk = r.u32(off+16);
    if (!(originalFirstThunk || timeDateStamp || forwarderChain || nameRva || firstThunk)) { terminatedDescriptors=true; break; }
    const library = mappedCStringAtRva(r,image,nameRva,budget,'PE import library');
    if (library) image.libraries.push(library);
    const thunkRva = originalFirstThunk || firstThunk;
    const thunkRange = mappedFileRangeForRva(image, thunkRva), iatRange = mappedFileRangeForRva(image, firstThunk);
    if (!thunkRange || !iatRange) { markImportPartial(image, `PE import thunk table for ${library||'<unknown>'} is not fully file-backed`); continue; }
    let terminated=false;
    for (let index=0; index<100000; index++) {
      const thunkOff=thunkRange.start+index*ptrSize, iatOff=iatRange.start+index*ptrSize;
      if (thunkOff+ptrSize>thunkRange.end || iatOff+ptrSize>iatRange.end || thunkOff+ptrSize>r.length || iatOff+ptrSize>r.length) break;
      if (!budget.take({inputBytes:ptrSize*2,records:1,objects:1,operations:2,estimatedHeapBytes:192},'import-thunk')) break;
      const raw=image.bits===64?r.u64(thunkOff):BigInt(r.u32(thunkOff));
      if(raw===0n){terminated=true;break;}
      const ordinalMask=image.bits===64?0x8000000000000000n:0x80000000n;
      let name=null,ordinal=null,hint=null;
      if(raw&ordinalMask) ordinal=Number(raw&0xffffn);
      else {
        const ibnRaw=raw&(image.bits===64?0x7fffffffffffffffn:0x7fffffffn);
        if(ibnRaw>0xffffffffn){markImportPartial(image,`Ignored PE import thunk with out-of-range name RVA for ${library||'<unknown>'}`);continue;}
        const ibnRva=Number(ibnRaw), ibnRange=mappedFileRangeForRva(image,ibnRva);
        if(ibnRange && ibnRange.start+2<ibnRange.end){hint=r.u16(ibnRange.start);name=mappedCStringAtOffset(r,ibnRange.start+2,ibnRange.end,budget,'PE import name');}
        if(!name){markImportPartial(image,`Ignored malformed PE import thunk for ${library||'<unknown>'}`);continue;}
      }
      const iatAddress=image.imageBase+BigInt(firstThunk+index*ptrSize);
      image.imports.push({name:name||`#${ordinal}`,library,ordinal,hint,source:'PE-import',sites:[{address:iatAddress,offset:BigInt(iatOff),kind:'iat'}]});
    }
    if(!terminated)markImportPartial(image,`PE import thunk table for ${library||'<unknown>'} reached its mapped file boundary without a NUL terminator`);
  }
  if (!terminatedDescriptors && off + 20 > end) markImportPartial(image,'PE import descriptor table reached its mapped boundary without a zero descriptor');
}

export function parseExports(r, dir, image, sharedBudget = null) {
  if (!dir || !dir.rva || dir.size < 40) return;
  const budget=ensureBudget(image,sharedBudget);
  const header=mappedFileSpanForRva(image,dir.rva,40);
  if(!header){budget.partial('exports:unmapped-header','PE export directory header is not fully file-backed');return;}
  const off=header.start;
  const nameRva=r.u32(off+12),baseOrdinal=r.u32(off+16),numberOfFunctions=r.u32(off+20),numberOfNames=r.u32(off+24);
  const addrFunctions=r.u32(off+28),addrNames=r.u32(off+32),addrOrdinals=r.u32(off+36);
  const dllName=mappedCStringAtRva(r,image,nameRva,budget,'PE export DLL'); if(dllName)image.metadata.exportName=dllName;
  const fBytes=numberOfFunctions*4,nBytes=numberOfNames*4,oBytes=numberOfNames*2;
  if(!Number.isSafeInteger(fBytes)||!Number.isSafeInteger(nBytes)||!Number.isSafeInteger(oBytes)){budget.partial('exports:count-overflow','PE export table count overflows safe span arithmetic');return;}
  const fr=numberOfFunctions?mappedFileSpanForRva(image,addrFunctions,fBytes):null;
  const nr=numberOfNames?mappedFileSpanForRva(image,addrNames,nBytes):null;
  const or=numberOfNames?mappedFileSpanForRva(image,addrOrdinals,oBytes):null;
  if(numberOfFunctions&&!fr){budget.partial('exports:function-array-span','PE export function RVA array crosses a mapped boundary');return;}
  if(numberOfNames&&(!nr||!or)){budget.partial('exports:name-array-span','PE export name/ordinal array crosses a mapped boundary');return;}
  const names=new Map();
  for(let i=0;i<numberOfNames;i++){
    if(!budget.take({inputBytes:6,records:1,objects:1,operations:2,estimatedHeapBytes:96},'export-name-record'))break;
    const nrva=r.u32(nr.start+i*4),ordIndex=r.u16(or.start+i*2);
    const name=mappedCStringAtRva(r,image,nrva,budget,'PE export name'); if(name)names.set(ordIndex,name);
  }
  const dirStart=dir.rva,dirEnd=dir.rva+dir.size;
  for(let i=0;i<numberOfFunctions;i++){
    if(!budget.take({inputBytes:4,records:1,objects:2,operations:2,estimatedHeapBytes:256},'export-function-record'))break;
    const frva=r.u32(fr.start+i*4); if(!frva)continue;
    const name=names.get(i)||`#${baseOrdinal+i}`;
    if(frva>=dirStart&&frva<dirEnd){
      const forwarder=mappedCStringAtRva(r,image,frva,budget,'PE export forwarder');
      image.exports.push({name,address:0n,ordinal:baseOrdinal+i,kind:'forwarder',forwarder:forwarder||null,source:'PE-export'});continue;
    }
    const address=image.imageBase+BigInt(frva);
    image.exports.push({
      name,address,ordinal:baseOrdinal+i,kind:'export',source:'PE-export',
      symbolKind:'unknown',functionStartAuthority:false,evidence:'exported-symbol-kind-unknown',
    });
    const independentlySeeded=(image.functions||[]).find((seed)=>seed?.address!=null&&BigInt(seed.address)===address&&seed.source!=='export')||null;
    if(independentlySeeded&&!independentlySeeded.name){independentlySeeded.name=name;independentlySeeded.nameEvidence='PE-export-name-enrichment';}
  }
}

function exportNameAtAddress(image,address){
  const target=BigInt(address);
  const match=(image.exports||[]).find((entry)=>entry?.kind==='export'&&entry.address!=null&&BigInt(entry.address)===target)||null;
  return match?.name||null;
}

function executableRvaRange(image, beginRva, size = 1) {
  if (!Number.isInteger(beginRva) || beginRva <= 0 || !Number.isInteger(size) || size <= 0) return false;
  const begin = image.imageBase + BigInt(beginRva), end = begin + BigInt(size), sec = image.sectionAt(begin);
  return !!(sec?.perms?.execute && end <= sec.address + sec.size);
}

export function parseExceptionFunctions(r, dir, image, machine, sharedBudget = null) {
  if(!dir||!dir.rva||!dir.size)return; const budget=ensureBudget(image,sharedBudget);
  const span=mappedFileSpanForRva(image,dir.rva,dir.size); if(!span){budget.partial('exception:directory-span','PE exception directory crosses a mapped boundary');return;}
  const off=span.start,end=span.spanEnd;
  if(machine===0x8664){
    let previousBegin=null,previousEnd=null;
    for(let p=off;p+12<=end;p+=12){
      if(!budget.take({inputBytes:12,records:1,objects:1,operations:2,estimatedHeapBytes:128},'exception-record'))break;
      const begin=r.u32(p),finish=r.u32(p+4),unwind=r.u32(p+8); const ordered=previousBegin==null||(begin>previousBegin&&begin>=previousEnd);
      if(!begin||finish<=begin||!ordered||!executableRvaRange(image,begin,finish-begin)){if(begin||finish)image.warnings.push(`Ignored ${!ordered?'overlapping/out-of-order':'invalid/unmapped'} x64 exception range RVA 0x${begin.toString(16)}..0x${finish.toString(16)}`);continue;}
      const address=image.imageBase+BigInt(begin);
      image.functions.push(functionSeed(address,{size:BigInt(finish-begin),name:exportNameAtAddress(image,address),source:'exception',confidence:0.999}));
      image.metadata.exceptionDirectory=image.metadata.exceptionDirectory||{count:0,kind:'x64-pdata'};image.metadata.exceptionDirectory.count++;previousBegin=begin;previousEnd=finish;void unwind;
    }
  }else if(machine===0xaa64||machine===0xa641){
    let previousBegin=null,previousEnd=null;
    for(let p=off;p+8<=end;p+=8){
      if(!budget.take({inputBytes:8,records:1,objects:1,operations:2,estimatedHeapBytes:128},'exception-record'))break;
      const begin=r.u32(p),unwindData=r.u32(p+4);if(!begin||(previousBegin!=null&&begin<=previousBegin)||!executableRvaRange(image,begin,1)){if(begin)image.warnings.push(`Ignored ARM64 exception entry outside executable order/range at RVA 0x${begin.toString(16)}`);continue;}
      let size=null;if((unwindData&3)!==0){const functionLength=(unwindData>>>2)&0x7ff;if(functionLength){const bytes=functionLength*4;if((previousEnd!=null&&begin<previousEnd)||!executableRvaRange(image,begin,bytes)){image.warnings.push(`Ignored overlapping/unmapped ARM64 exception range at RVA 0x${begin.toString(16)}`);continue;}size=BigInt(bytes);}}
      const address=image.imageBase+BigInt(begin);
      image.functions.push(functionSeed(address,{size,name:exportNameAtAddress(image,address),source:'exception',confidence:0.995}));image.metadata.exceptionDirectory=image.metadata.exceptionDirectory||{count:0,kind:'arm64-pdata'};image.metadata.exceptionDirectory.count++;previousBegin=begin;previousEnd=size==null?null:begin+Number(size);
    }
  }
}

function allowedBaseRelocationTypes(machine) {
  if (machine === 0x014c) return new Set([1, 2, 3, 4]);
  if (machine === 0x8664) return new Set([1, 2, 3, 4, 10]);
  if (machine === 0x01c0 || machine === 0x01c4) return new Set([3, 5, 7]);
  if (machine === 0xaa64 || machine === 0xa641) return new Set([4, 5, 6, 7, 8, 10]);
  return new Set([1, 2, 3, 4, 5, 6, 7, 8, 10]);
}

export function parseBaseRelocations(r, dir, image, machine = null, sharedBudget = null) {
  if(!dir||!dir.rva||dir.size<8)return; const budget=ensureBudget(image,sharedBudget);
  const span=mappedFileSpanForRva(image,dir.rva,dir.size);if(!span){budget.partial('relocations:directory-span','PE base-relocation directory crosses a mapped boundary');return;}
  let off=span.start;const end=span.spanEnd,allowed=allowedBaseRelocationTypes(machine);
  while(off+8<=end){
    if(!budget.take({inputBytes:8,records:1,operations:1,estimatedHeapBytes:32},'relocation-block'))break;
    const pageRva=r.u32(off),blockSize=r.u32(off+4);if(blockSize<8||(blockSize&1)!==0||off+blockSize>end){budget.partial('relocations:malformed-block',`Malformed PE base-relocation block at file offset 0x${off.toString(16)}`);break;}
    const count=(blockSize-8)/2;
    for(let i=0;i<count;i++){
      if(!budget.take({inputBytes:2,records:1,objects:1,operations:1,estimatedHeapBytes:112},'relocation-entry'))break;
      const raw=r.u16(off+8+i*2),type=raw>>>12,within=raw&0xfff;if(!type)continue;if(!allowed.has(type)){image.warnings.push(`Ignored reserved/unsupported PE base relocation type ${type} at RVA 0x${(pageRva+within).toString(16)}`);continue;}
      const address=image.imageBase+BigInt(pageRva+within);image.relocations.push({address,fileOffset:image.addressToOffset(address),type,symbol:null,addend:null,section:null,source:'PE-base-reloc'});
    }
    off+=blockSize;
  }
}

export function parseCoffSymbols(r, ptr, count, image, sharedBudget = null) {
  if(!ptr||!count)return;const budget=ensureBudget(image,sharedBudget);const tableBytes=count*18;
  if(!Number.isSafeInteger(tableBytes)||ptr+tableBytes>r.length){budget.partial('coff:symbol-table-span','PE COFF symbol table exceeds the input');return;}
  const strBase=ptr+tableBytes;if(strBase+4>r.length){budget.partial('coff:string-table-header','PE COFF string table header is missing');return;}
  const strSize=r.u32(strBase),strEnd=Math.min(r.length,strBase+Math.max(4,strSize));if(strBase+strSize>r.length)budget.partial('coff:string-table-span','PE COFF string table is truncated');
  let i=0;
  while(i<count){
    if(!budget.take({inputBytes:18,records:1,objects:2,operations:2,estimatedHeapBytes:256},'coff-symbol-record'))break;
    const p=ptr+i*18;let name;
    if(r.u32(p)===0){const noff=r.u32(p+4);name=noff>=4&&noff<strSize&&strBase+noff<strEnd?mappedCStringAtOffset(r,strBase+noff,strEnd,budget,'COFF symbol'):'';}else{name=r.ascii(p,8);if(name&&!budget.take({stringBytes:name.length*2,estimatedHeapBytes:name.length*2+32},'coff-inline-name'))name='';}
    const value=r.u32(p+8),secNo=r.i16(p+12),type=r.u16(p+14),storage=r.u8(p+16),aux=r.u8(p+17);const sec=image.sections.find((s)=>s.index===secNo);const address=sec?sec.address+BigInt(value):0n;
    if(name){const derivedFunction=!!(type&0x20),executableExternal=!!(sec&&sec.perms.execute&&storage===2);image.symbols.push({name,address,size:null,kind:derivedFunction?'function':'symbol',binding:storage===2?'global':'local',defined:secNo>0,sectionIndex:secNo,source:'COFF'});if(derivedFunction&&address)image.functions.push(functionSeed(address,{name,source:'symbol',confidence:0.98,exactFunctionStart:true,functionStartEvidence:'COFF derived function type'}));else if(executableExternal&&address)image.functions.push(functionSeed(address,{name,source:'symbol-heuristic',confidence:0.55}));}
    if(aux>count-i-1){budget.partial('coff:aux-overrun','PE COFF auxiliary symbol records exceed declared symbol count');break;}i+=1+aux;
  }
}

export function directory(dirs, index) { return dirs[index] || { rva: 0, size: 0 }; }
function rvaToOffset(image, rva) {
  const o = image.addressToOffset(image.imageBase + BigInt(rva));
  return o == null || o > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(o);
}
export function peMachineName(m) {
  return ({ 0x014c: 'x86', 0x8664: 'x86_64', 0x01c0: 'arm', 0x01c4: 'armv7', 0xaa64: 'arm64', 0xa641: 'arm64ec', 0x5032: 'riscv32', 0x5064: 'riscv64' })[m] || `machine-${m.toString(16)}`;
}

export function resolveCoffSectionName(r, inlineName, ptrSymbols, count) {
  const raw = String(inlineName || '');
  const m = /^\/(\d+)$/.exec(raw);
  if (!m) return raw;
  if (!ptrSymbols || !Number.isInteger(count) || count < 0) return raw;
  const stringBase = ptrSymbols + count * 18;
  if (!Number.isSafeInteger(stringBase) || stringBase < 0 || stringBase + 4 > r.length) return raw;
  const stringSize = r.u32(stringBase);
  const offset = Number(m[1]);
  if (!Number.isSafeInteger(offset) || offset < 4 || offset >= stringSize || stringBase + offset >= r.length) return raw;
  return r.cstring(stringBase + offset, Math.min(stringSize - offset, r.length - stringBase - offset)) || raw;
}

function rvaFromDelayField(value, attrs, image) {
  if (!value) return 0;
  if (attrs & 1) return value >>> 0;
  const va = BigInt(value >>> 0), base = image.imageBase;
  if (va < base || va - base > 0xffffffffn) return 0;
  return Number(va - base);
}

export function parseDelayImports(r, dir, image, sharedBudget = null) {
  if(!dir||!dir.rva||dir.size<32)return;const budget=ensureBudget(image,sharedBudget);const dirRange=mappedFileSpanForRva(image,dir.rva,dir.size);if(!dirRange){budget.partial('delay-imports:directory-span','PE delay-import directory crosses a mapped boundary');return;}
  let off=dirRange.start;const end=dirRange.spanEnd,ptrSize=image.bits===64?8:4;
  for(let guard=0;guard<65536&&off+32<=end;guard++,off+=32){
    if(!budget.take({inputBytes:32,records:1,operations:1,estimatedHeapBytes:32},'delay-import-descriptor'))break;
    const attrs=r.u32(off),nameField=r.u32(off+4),iatField=r.u32(off+12),intField=r.u32(off+16),bound=r.u32(off+20),unload=r.u32(off+24),stamp=r.u32(off+28);if(!(attrs||nameField||iatField||intField||bound||unload||stamp))break;
    const nameRva=rvaFromDelayField(nameField,attrs,image),iatRva=rvaFromDelayField(iatField,attrs,image),intRva=rvaFromDelayField(intField,attrs,image);const library=mappedCStringAtRva(r,image,nameRva,budget,'PE delay import library');
    const iatRange=mappedFileRangeForRva(image,iatRva),thunkRange=mappedFileRangeForRva(image,intRva||iatRva);if(!library||!iatRva||!iatRange||!thunkRange){budget.partial('delay-imports:malformed-descriptor','Ignored malformed PE delay-import descriptor');continue;}image.libraries.push(library);
    let terminated=false;
    for(let index=0;index<100000;index++){
      const thunkOff=thunkRange.start+index*ptrSize,iatOff=iatRange.start+index*ptrSize;if(thunkOff+ptrSize>thunkRange.end||iatOff+ptrSize>iatRange.end||thunkOff+ptrSize>r.length||iatOff+ptrSize>r.length)break;
      if(!budget.take({inputBytes:ptrSize*2,records:1,objects:1,operations:2,estimatedHeapBytes:192},'delay-import-thunk'))break;
      const raw=image.bits===64?r.u64(thunkOff):BigInt(r.u32(thunkOff));if(raw===0n){terminated=true;break;}const ordinalMask=image.bits===64?0x8000000000000000n:0x80000000n;let name=null,ordinal=null,hint=null;
      if(raw&ordinalMask)ordinal=Number(raw&0xffffn);else{let ibnRva;if(attrs&1){const masked=raw&(image.bits===64?0x7fffffffffffffffn:0x7fffffffn);if(masked>0xffffffffn)continue;ibnRva=Number(masked);}else{const va=raw&(image.bits===64?0x7fffffffffffffffn:0x7fffffffn);ibnRva=va>=image.imageBase&&va-image.imageBase<=0xffffffffn?Number(va-image.imageBase):0;}const ibnRange=mappedFileRangeForRva(image,ibnRva);if(ibnRange&&ibnRange.start+2<ibnRange.end){hint=r.u16(ibnRange.start);name=mappedCStringAtOffset(r,ibnRange.start+2,ibnRange.end,budget,'PE delay import name');}if(!name){image.warnings.push(`Ignored malformed PE delay-import thunk for ${library||'<unknown>'}`);continue;}}
      const iatAddress=image.imageBase+BigInt(iatRva+index*ptrSize);image.imports.push({name:name||`#${ordinal}`,library,ordinal,hint,source:'PE-delay-import',sites:[{address:iatAddress,offset:BigInt(iatOff),kind:'delay-iat'}]});
    }
    if(!terminated)budget.partial('delay-imports:unterminated-thunk',`PE delay-import thunk table for ${library} reached its mapped boundary`);
  }
}

function readPointer(r, off, bits) { return bits===64?r.u64(off):BigInt(r.u32(off)); }

export function parseTlsDirectory(r, dir, image, sharedBudget = null) {
  const need=image.bits===64?40:24;if(!dir||!dir.rva||dir.size<need)return;const budget=ensureBudget(image,sharedBudget);const hdr=mappedFileSpanForRva(image,dir.rva,need);if(!hdr){budget.partial('tls:directory-span','PE TLS directory header is not fully file-backed');return;}const off=hdr.start,callbacksVa=readPointer(r,off+(image.bits===64?24:12),image.bits),callbacks=[];
  if(callbacksVa){const ptrSize=image.bits===64?8:4,range=mappedFileRangeForAddress(image,callbacksVa);if(!range){budget.partial('tls:callback-table-span','PE TLS callback table is not file-backed');}else{let terminated=false;for(let i=0,p=range.start;i<65536&&p+ptrSize<=range.end;i++,p+=ptrSize){if(!budget.take({inputBytes:ptrSize,records:1,objects:1,operations:1,estimatedHeapBytes:128},'tls-callback'))break;const target=readPointer(r,p,image.bits);if(!target){terminated=true;break;}const sec=image.sectionAt(target);if(!sec?.perms?.execute)continue;callbacks.push(target);image.functions.push(functionSeed(target,{source:'tls-callback',confidence:0.999}));}if(!terminated)budget.partial('tls:unterminated-callback-table','PE TLS callback table reached its mapped boundary without a zero terminator');}}
  image.metadata.tls={callbacks,callbacksAddress:callbacksVa||null};
}

export function parseLoadConfig(r, dir, image, sharedBudget = null) {
  if(!dir||!dir.rva||dir.size<4)return;const budget=ensureBudget(image,sharedBudget),head=mappedFileSpanForRva(image,dir.rva,4);if(!head){budget.partial('load-config:header-span','PE load-config header is not file-backed');return;}const off=head.start,declared=Math.min(r.u32(off),dir.size);const full=mappedFileSpanForRva(image,dir.rva,declared);if(!full){budget.partial('load-config:directory-span','PE load-config directory crosses a mapped boundary');return;}const is64=image.bits===64,tableOffset=is64?128:80,countOffset=is64?136:84,flagsOffset=is64?144:88,ptrSize=is64?8:4;if(declared<countOffset+ptrSize)return;
  const tableVa=readPointer(r,off+tableOffset,image.bits),count64=readPointer(r,off+countOffset,image.bits),guardFlags=declared>=flagsOffset+4?r.u32(off+flagsOffset):0,extra=(guardFlags>>>28)&0xf,entrySize=4+extra,functions=[];const tableRange=tableVa?mappedFileRangeForAddress(image,tableVa):null;
  if(tableVa&&!tableRange)budget.partial('load-config:guardcf-table-span','PE GuardCF table is not file-backed');
  if(tableRange){const capacity=Math.floor((tableRange.end-tableRange.start)/entrySize);if(count64>BigInt(capacity))budget.partial('load-config:guardcf-count-span','PE GuardCF count exceeds its mapped file-backed table');const count=Number(count64<BigInt(capacity)?count64:BigInt(capacity));for(let i=0;i<count;i++){if(!budget.take({inputBytes:entrySize,records:1,objects:1,operations:1,estimatedHeapBytes:128},'guardcf-function'))break;const p=tableRange.start+i*entrySize,rva=r.u32(p);if(!rva)continue;const address=image.imageBase+BigInt(rva),sec=image.sectionAt(address);if(!sec?.perms?.execute)continue;functions.push(address);image.functions.push(functionSeed(address,{source:'guard-cf',confidence:0.995}));}}
  image.metadata.loadConfig={guardFlags,guardCFFunctionTable:tableVa||null,guardCFFunctionCount:count64,guardCFFunctions:functions};
}